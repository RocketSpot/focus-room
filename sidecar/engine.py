"""The line engine — turns native engagement into the one calm line.

Document.pdf "The Live Focus Line, Defined":
  * smoothed engagement, rolling ~4-8s window, updated ~1/s
  * plotted on a RELATIVE scale set from the guest's own session
    (y-axis is "low for you" to "high for you", never absolute 0..100)
  * a dip counts as real only when it falls below the session's running band
    for more than a couple of seconds (separates a real drop from a
    blink/swallow artifact)
  * one soft state word that changes slowly: settling/focused/dipping/recovering

This is the SAME relative-scale + no-numbers discipline as lib/focusline.js,
moved server-side and fed by real metrics.engagement. Phase 2 tunes the
constants; the shape of the logic lives here.
"""

from collections import deque
from statistics import mean, pstdev
from typing import Optional, List, Dict

from protocol import STATE_WORD


class EngagementEngine:
    def __init__(
        self,
        smooth_seconds: float = 6.0,   # 4-8s rolling window (doc)
        # The analyser hands over one value per 1.0s hop, and a gate of
        # exactly 1.0s beats against that cadence: whether an incoming value
        # clears (t - last_emit) >= 1.0 depends on sub-millisecond arrival
        # jitter, so roughly every other window was swallowed and the guest
        # line ran at ~0.5 Hz (measured on 2026-08-31: 45 frames over 92s).
        # Half the hop passes every window exactly once and still absorbs a
        # burst of duplicates.
        emit_interval: float = 0.5,
        warmup_seconds: float = 5.0,   # ignore cold-start for the relative scale
    ):
        self.smooth_seconds = smooth_seconds
        self.emit_interval = emit_interval
        self.warmup_seconds = warmup_seconds

        self._raw = deque()            # (t_s, value) recent raw engagement
        self._t0: Optional[float] = None
        self._last_emit: float = -1e9

        # adaptive per-session band for the relative scale
        self._lo: Optional[float] = None
        self._hi: Optional[float] = None
        self._band_init = False
        self._obs_max: Optional[float] = None   # highest smoothed value seen
        self._obs_max_t: float = 0.0            # when it last rose (stability gate)

        # recorded relative samples (for replay, card/profile/email, archetype)
        self.samples: List[Dict] = []   # {t: seconds-from-start, v: 0..1}
        self._rel_hist = deque(maxlen=600)  # (t_s, rel) ~10 min at 1Hz

        # slow state machine
        self._state = STATE_WORD.SETTLING
        self._settled = False
        self._dip_since: Optional[float] = None
        self._dip_active = False
        self._trough: float = 1.0
        self._pre_dip_baseline: float = 0.0

        # one-shot detectors
        self._plateau_since: Optional[float] = None
        self._plateau_dips = 0      # consecutive below-level samples (artifact tolerance)
        self.plateau_fired = False
        self.dip_count = 0

        self._signal_quality: float = 1.0

    # --- tuning constants (Phase 2 will revisit) ---
    # A live line can't know the session's eventual peak, so the band is
    # anchored to the guest's cold-start and given a plausible span to climb
    # into (then expands to their real range). The reveal/outputs rescale from
    # the true session min/max via finalize_samples() — that's the honest
    # within-session scale. Live just needs to show the climb, not pin to top.
    INITIAL_SPAN = 0.50       # native-engagement units of expected climb headroom
    # flat-session polish: once the line has been STABLE (not climbing) for a
    # while, slowly contract the ceiling toward the observed range so a small-range
    # session fills its own scale. Only fires when the band was over-seeded AND the
    # line settled — so an active climb still shows, and a normal session (whose
    # ceiling already expanded to its real max) is untouched.
    BAND_STABLE_SEC = 8.0
    BAND_HEADROOM = 0.06
    BAND_MIN_SPAN = 0.30
    BAND_CONTRACT = 0.04
    SETTLE_LEVEL = 0.55       # rel at which we consider the guest "focused"
    # The interruption must land WHILE the guest is genuinely focused and still
    # reading. A 3-minute passage was routinely finished before a 22s hold in the
    # top 28% of range could qualify, so the moment never came. Shorter hold at a
    # slightly lower level still requires a real, stable plateau (not a spike) —
    # it just reaches it inside the reading instead of after it.
    PLATEAU_LEVEL = 0.62      # upper portion of the guest's own range
    PLATEAU_SECONDS = 9.0     # sustained stretch → a real plateau, not a spike
    PLATEAU_MAX_STD = 0.14    # must be reasonably stable to count
    DIP_MARGIN = 0.16         # below running band to qualify as a dip
    DIP_MIN_SECONDS = 2.5     # sustained (doc: "more than a couple of seconds")
    RECOVER_MARGIN = 0.06

    def set_signal_quality(self, q: float) -> None:
        self._signal_quality = max(0.0, min(1.0, q))

    def reset(self) -> None:
        """Clear every piece of session-scoped state so the next guest starts
        fresh: samples, t0, the relative band seeds, and the plateau/dip
        latches (the plateau must be able to fire again). Called at the START
        of a session by both sources — never at stop, which still emits
        SESSION_SAMPLES + archetype from the buffer. Signal quality is link
        state, not session state, so it survives the reset."""
        self._raw.clear()
        self._t0 = None
        self._last_emit = -1e9

        self._lo = None
        self._hi = None
        self._band_init = False
        self._obs_max = None
        self._obs_max_t = 0.0

        self.samples = []
        self._rel_hist.clear()

        self._state = STATE_WORD.SETTLING
        self._settled = False
        self._dip_since = None
        self._dip_active = False
        self._trough = 1.0
        self._pre_dip_baseline = 0.0

        self._plateau_since = None
        self._plateau_dips = 0
        self.plateau_fired = False
        self.dip_count = 0

    def feed(self, raw_engagement: float, t_ms: int) -> Optional[Dict]:
        """Ingest one native engagement value. Returns a frame dict (when it's
        time to emit ~1/s) else None. The frame may carry events ('plateau'|'dip')
        the caller forwards to main."""
        t_s = t_ms / 1000.0
        if self._t0 is None:
            self._t0 = t_s
        rel_t = t_s - self._t0

        self._raw.append((t_s, float(raw_engagement)))
        cutoff = t_s - self.smooth_seconds
        while self._raw and self._raw[0][0] < cutoff:
            self._raw.popleft()

        if (t_s - self._last_emit) < self.emit_interval:
            return None
        self._last_emit = t_s

        smoothed = mean(v for _, v in self._raw)
        self._update_band(rel_t, smoothed)
        rel = self._to_relative(smoothed)

        # store both the live relative value and the raw smoothed value; the
        # latter lets the reveal/outputs rescale on the true session min/max.
        self.samples.append({"t": round(rel_t, 3), "v": round(rel, 4), "vr": round(smoothed, 4)})
        self._rel_hist.append((rel_t, rel))

        events: List[str] = []
        self._update_state(rel_t, rel, events)

        return {
            "engagementRel": round(rel, 4),
            "stateWord": self._state,
            "signalQuality": round(self._signal_quality, 3),
            "tRel": round(rel_t, 3),
            "events": events,
        }

    # --- relative scale ---
    def _update_band(self, rel_t: float, smoothed: float) -> None:
        if not self._band_init:
            # anchor low at the cold-start baseline and give the line room to
            # climb into; from here the band only expands to the guest's real
            # range as the session reveals it.
            self._lo = smoothed
            self._hi = smoothed + self.INITIAL_SPAN
            self._obs_max = smoothed
            self._obs_max_t = rel_t
            self._band_init = True
            return
        self._lo = min(self._lo, smoothed)
        if smoothed > self._obs_max:
            # only a meaningful climb resets the stability timer — plateau noise
            # shouldn't keep the band from settling.
            if (smoothed - self._obs_max) > 0.02:
                self._obs_max_t = rel_t
            self._obs_max = smoothed
        if smoothed > self._hi:
            self._hi = smoothed                       # new high → expand immediately
        elif (rel_t - self._obs_max_t) > self.BAND_STABLE_SEC:
            # the line has settled; pull an over-seeded ceiling down toward the
            # observed range (downward only — never above the real max + headroom)
            target = max(self._obs_max + self.BAND_HEADROOM, self._lo + self.BAND_MIN_SPAN)
            if target < self._hi:
                self._hi += (target - self._hi) * self.BAND_CONTRACT

    def _to_relative(self, smoothed: float) -> float:
        lo, hi = self._lo, self._hi
        if lo is None or hi is None or (hi - lo) < 1e-6:
            return 0.5
        # small headroom so the live line rarely pins to the exact top/bottom
        span = (hi - lo)
        rel = (smoothed - lo) / span
        rel = 0.04 + rel * 0.92
        return max(0.0, min(1.0, rel))

    # --- slow state machine + detectors ---
    def _running_baseline(self, window: float = 10.0) -> float:
        if not self._rel_hist:
            return 0.0
        t_now = self._rel_hist[-1][0]
        vals = [v for tt, v in self._rel_hist if tt >= t_now - window]
        return max(vals) if vals else self._rel_hist[-1][1]

    def _update_state(self, rel_t: float, rel: float, events: List[str]) -> None:
        baseline = self._running_baseline()

        # dip detection — sustained drop below the running band
        if not self._dip_active:
            if rel < baseline - self.DIP_MARGIN:
                if self._dip_since is None:
                    self._dip_since = rel_t
                    self._pre_dip_baseline = baseline
                    self._trough = rel
                else:
                    self._trough = min(self._trough, rel)
                    if (rel_t - self._dip_since) >= self.DIP_MIN_SECONDS:
                        self._dip_active = True
                        self.dip_count += 1
                        events.append("dip")
                        self._state = STATE_WORD.DIPPING
            else:
                self._dip_since = None
        else:
            self._trough = min(self._trough, rel)
            # recovering once we climb back off the trough
            if rel >= self._trough + self.RECOVER_MARGIN and self._state != STATE_WORD.RECOVERING:
                self._state = STATE_WORD.RECOVERING
            # dip resolved once back near pre-dip baseline
            if rel >= self._pre_dip_baseline - self.RECOVER_MARGIN:
                self._dip_active = False
                self._dip_since = None
                self._state = STATE_WORD.FOCUSED

        if self._dip_active:
            return  # dipping/recovering owns the state word while a dip is live

        # settle → focused
        if not self._settled:
            if rel >= self.SETTLE_LEVEL:
                self._settled = True
                self._state = STATE_WORD.FOCUSED
            else:
                self._state = STATE_WORD.SETTLING
        else:
            self._state = STATE_WORD.FOCUSED

        # plateau detection (one-shot) — drives automated interruption timing
        if not self.plateau_fired and self._settled:
            recent = [v for tt, v in self._rel_hist if tt >= rel_t - self.PLATEAU_SECONDS]
            if rel >= self.PLATEAU_LEVEL and len(recent) >= 3:
                self._plateau_dips = 0
                if self._plateau_since is None:
                    self._plateau_since = rel_t
                stable = pstdev(recent) <= self.PLATEAU_MAX_STD if len(recent) > 1 else True
                held = (rel_t - self._plateau_since) >= self.PLATEAU_SECONDS
                above = min(recent) >= self.PLATEAU_LEVEL - 0.08
                if held and stable and above:
                    self.plateau_fired = True
                    events.append("plateau")
            else:
                # tolerate a brief artifact dip — don't discard a real plateau hold
                self._plateau_dips += 1
                if self._plateau_dips >= 2:
                    self._plateau_since = None
                    self._plateau_dips = 0

    # --- archetype features (Phase 4 consumes these) ---
    def compute_archetype(self) -> Dict:
        """Two relative features of the guest's own session (Document.pdf 2x2):
        settle speed + variability once engaged. Returns features + label."""
        if len(self.samples) < 8:
            return {"label": "steady", "name": "Steady Burner", "settle": "unknown", "variability": "unknown"}

        # settle speed: time from start to first sustained hold in the upper range
        settle_t = None
        for i, s in enumerate(self.samples):
            if s["v"] >= self.PLATEAU_LEVEL:
                # require it to hold a few samples
                window = self.samples[i:i + 4]
                if len(window) >= 3 and mean(w["v"] for w in window) >= self.PLATEAU_LEVEL - 0.05:
                    settle_t = s["t"]
                    break
        total_t = self.samples[-1]["t"] or 1.0
        settle_frac = (settle_t / total_t) if settle_t is not None else 1.0
        settled_quickly = settle_frac <= 0.33

        # variability across the clean middle (exclude cold start + dip window)
        mids = [s["v"] for s in self.samples if 0.2 * total_t <= s["t"] <= 0.85 * total_t]
        variability = pstdev(mids) if len(mids) > 1 else 0.0
        variable = variability >= 0.14

        label, name = self._archetype_label(settled_quickly, variable)
        return {
            "label": label,
            "name": name,
            "settle": "quickly" if settled_quickly else "slowly",
            "variability": "variable" if variable else "steady",
            "settleFrac": round(settle_frac, 3),
            "variabilityValue": round(variability, 4),
        }

    @staticmethod
    def _archetype_label(quickly: bool, variable: bool):
        # Document.pdf 2x2
        if not quickly and not variable:
            return "deep", "Deep Diver"
        if not quickly and variable:
            return "sprint", "Sprinter"
        if quickly and not variable:
            return "steady", "Steady Burner"
        return "igniter", "Quick Igniter"
