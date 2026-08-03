"""Simulation data source.

Synthesizes the SAME JSON frame shapes the real Zone source emits — a believable
climbing -> plateau -> dip -> recovery engagement curve, plus band powers and
per-bud stats — so the full experience can be built and demoed without buds.

HARD RULE (master prompt): a live guest only ever sees real signal. This source
runs only behind the explicit --simulate flag and is never a silent fallback.
"""

import asyncio
import math
import os
import random
import time
from datetime import datetime

import numpy as _np

from protocol import OUT
from band_analyzer import BandAnalyzer
from eeg_stream import EegStream


class SimSource:
    name = "sim"

    def __init__(self, transport, engine, log):
        self.tx = transport
        self.engine = engine
        self.log = log
        self._task = None
        self._fit_task = None
        self._running = False
        self._t_start = None
        self._interrupt_at = None     # session-seconds when the dip begins
        self._rng = random.Random(7)
        # scenario knob for the edge-case runs: normal | flat | dropout
        self._scenario = os.environ.get("FOCUSROOM_SIM_SCENARIO", "normal").lower()
        # A LABELLED synthetic raw stream so the whole EEG pipeline can be exercised
        # without hardware. Deterministic 1/f noise carrying broad oscillatory bumps,
        # at ADC-count scale, run through the SAME analyser the room ships. Never
        # passed off as real: every payload carries simulation:true and the screen
        # shows a persistent SIMULATED badge.
        self._eeg_stream = None
        self._raw_i = 0
        self._pink_cache = {}
        self._osc_cache = {}
        self._analyzer = None

    RAW_FS = 250.0
    RAW_BATCH = 50            # 0.2 s of samples per emit → matches the 0.2 s loop

    # ---------------- pre-session fit check ----------------
    async def start_fit(self):
        self._fit_task = asyncio.create_task(self._fit_loop())

    async def stop_fit(self):
        await self._cancel(self._fit_task)
        self._fit_task = None

    async def _fit_loop(self):
        # battery: both good
        self.tx.send(OUT.BATTERY, leftPct=88, rightPct=91, ok=True)
        # impedance converges open -> high_z -> pair_ok -> low_z (phase good)
        seq = ["open", "high_z", "pair_ok", "low_z", "low_z"]
        try:
            for i, st in enumerate(seq):
                phase = "measuring" if i == 0 else "good"
                ch = lambda: {"kohm": {"open": None, "high_z": 320, "pair_ok": 120, "low_z": 28}[st],
                              "state": st, "phase": phase, "hint": None}
                channels = {"left": {"ch1": ch(), "ch2": ch()},
                            "right": {"ch1": ch(), "ch2": ch()}}
                all_good = st in ("low_z", "pair_ok") and phase == "good"
                self.tx.send(OUT.IMPEDANCE, channels=channels, allGood=all_good)
                await asyncio.sleep(0.8)
            # hold allGood
            while True:
                self.tx.send(OUT.IMPEDANCE, channels={
                    "left": {"ch1": {"kohm": 26, "state": "low_z", "phase": "good", "hint": None},
                             "ch2": {"kohm": 30, "state": "low_z", "phase": "good", "hint": None}},
                    "right": {"ch1": {"kohm": 24, "state": "low_z", "phase": "good", "hint": None},
                              "ch2": {"kohm": 33, "state": "pair_ok", "phase": "good", "hint": None}},
                }, allGood=True)
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass

    # ---------------- live session ----------------
    async def start_session(self):
        if self._running:
            return
        self.engine.reset()   # per-session: guest 2 never inherits guest 1's band/plateau
        self._running = True
        self._t_start = time.monotonic()
        self._interrupt_at = None
        self.engine.set_signal_quality(0.97)
        self._eeg_stream = EegStream(self.tx, self.log, simulation=True, expected_rate_hz=int(self.RAW_FS))
        self._analyzer = BandAnalyzer(fs=self.RAW_FS, log=self.log)
        self._analyzer.on_window(self._on_window)
        self._raw_i = 0
        self._engagement_now = 0.5
        self._task = asyncio.create_task(self._session_loop())
        self.log("sim session started")

    def _synth_raw_batch(self, n, engagement=0.5):
        """Synthetic EEG that behaves like EEG: a 1/f background carrying broad
        oscillatory bumps whose heights follow the scripted engagement curve.

        This replaces a sum of four pure sines. Sines were wrong twice over. They
        look nothing like EEG on the signal-check screen, which is a room full of
        people looking at a trace that is visibly not a brain. And spectrally they
        have no 1/f background at all, so they exercised none of the analysis that
        actually matters: a pipeline could be completely broken on real spectra and
        still look perfect in simulation. Every dev run now drives the same
        analyser the room ships.

        Still deterministic, still labelled simulation:true everywhere.
        """
        alpha_amp = 26.0 - 16.0 * engagement      # alpha falls as engagement rises
        beta_amp = 6.0 + 20.0 * engagement        # beta rises with it
        theta_amp = 12.0 - 4.0 * engagement
        cols = []
        # a slow shared breathing drift, well inside what the analyser accepts
        shared = self._pink_seg(n, 1.4, self._raw_i, seed=17) * 22.0
        for c in range(4):
            x = self._pink_seg(n, 1.3, self._raw_i, seed=100 + c) * 30.0
            x = x + self._osc_seg(n, 10.0, self._raw_i, seed=200 + c) * alpha_amp
            x = x + self._osc_seg(n, 19.0, self._raw_i, seed=300 + c) * beta_amp
            x = x + self._osc_seg(n, 6.0, self._raw_i, seed=400 + c) * theta_amp
            cols.append(list(x + shared))
        self._raw_i += n
        return cols

    def _pink_seg(self, n, chi, i0, seed):
        """A continuous 1/f^chi segment. Phases are seeded per channel and the
        segment is cut from a long precomputed buffer, so successive batches join
        without a seam. A seam would read as an electrode pop to the analyser,
        which is exactly the artifact it is supposed to catch."""
        buf = self._pink_cache.get((chi, seed))
        if buf is None:
            rng = _np.random.default_rng(seed)
            N = int(self.RAW_FS * 120)                 # two minutes, looped
            f = _np.fft.rfftfreq(N, d=1.0 / self.RAW_FS)
            amp = _np.zeros_like(f)
            amp[1:] = f[1:] ** (-chi / 2.0)
            spec = amp * _np.exp(1j * rng.uniform(0, 2 * _np.pi, size=f.size))
            spec[0] = 0.0
            buf = _np.fft.irfft(spec, n=N)
            buf = buf / (buf.std() or 1.0)
            self._pink_cache[(chi, seed)] = buf
        N = len(buf)
        idx = (_np.arange(i0, i0 + n) % N)
        return buf[idx]

    def _osc_seg(self, n, fc, i0, seed):
        """A BROAD oscillation around fc, not a pure tone: band-limited noise, the
        shape a real rhythm actually has on a spectrum."""
        buf = self._osc_cache.get((fc, seed))
        if buf is None:
            from scipy import signal as _sg
            rng = _np.random.default_rng(seed)
            N = int(self.RAW_FS * 120)
            sos = _sg.butter(4, [max(0.5, fc - 1.5), fc + 1.5], btype="band",
                             fs=self.RAW_FS, output="sos")
            buf = _sg.sosfiltfilt(sos, rng.standard_normal(N))
            buf = buf / (buf.std() or 1.0)
            self._osc_cache[(fc, seed)] = buf
        N = len(buf)
        idx = (_np.arange(i0, i0 + n) % N)
        return buf[idx]

    def _emit_synth_raw(self, te):
        """Feed the synthetic batch through the SAME EegStream the real path uses.
        The dropout scenario injects a genuine gap then a right-ear flatline so the
        gap and partial-quality states are exercised honestly (never hidden)."""
        if self._eeg_stream is None:
            return
        labels = ["Left-A", "Left-B", "Right-A", "Right-B"]
        if self._scenario == "dropout" and 22.0 <= te < 26.0:
            # a real packet gap — advance the sample phase but emit NOTHING, so the
            # display shows a gap and continuity reports missing samples
            self._raw_i += self.RAW_BATCH
            return
        cols = self._synth_raw_batch(self.RAW_BATCH, engagement=self._engagement_now)
        if self._scenario == "dropout" and 26.0 <= te < 32.0:
            cols[2] = [10.0] * self.RAW_BATCH    # Right-A flatline (dead contact)
            cols[3] = [12.0] * self.RAW_BATCH    # Right-B flatline
        self._eeg_stream.ingest(cols, labels, sdk_rate=int(self.RAW_FS))
        if self._analyzer is not None:
            self._analyzer.ingest(cols, labels)

    async def stop_session(self):
        self._running = False
        if self._eeg_stream is not None:
            self._eeg_stream.close("stop_session")   # flush + close any validation capture
        self._eeg_stream = None
        await self._cancel(self._task)
        self._task = None
        if self.engine.samples:
            self.tx.send(OUT.SESSION_SAMPLES, samples=self.engine.samples)
            self.tx.send(OUT.ARCHETYPE, **self.engine.compute_archetype())

    def mark(self, kind, t):
        # in validation mode, a mark is also a staff event annotation on the raw capture.
        if self._eeg_stream is not None:
            self._eeg_stream.annotate(kind, t)
        # The orchestrator's interruption fire lands here; deepen the dip now.
        if kind == "interruption" and self._interrupt_at is None and self._t_start is not None:
            self._interrupt_at = time.monotonic() - self._t_start
            self.log(f"sim: interruption marked at {self._interrupt_at:.1f}s")

    def test_signal(self):
        self.log("sim: test_signal injected (no-op in simulation)")
        self.tx.send(OUT.LOG, level="info", msg="sim test_signal acknowledged")

    # ---------------- curve ----------------
    def _engagement_at(self, te: float) -> float:
        # flat session: a high-ish, very even line with only a modest dip — the
        # edge case the doc requires (don't force drama, name the calm pattern).
        if self._scenario == "flat":
            lo, plateau, tau, wave_amp, dip_amp = 0.46, 0.60, 9.0, 0.012, 0.14
        else:
            lo, plateau, tau, wave_amp, dip_amp = 0.20, 0.84, 11.0, 0.030, 0.42

        base = lo + (plateau - lo) * (1.0 - math.exp(-te / tau))
        wave = wave_amp * math.sin(te / 7.0 * 2 * math.pi) + (wave_amp * 0.6) * math.sin(te / 2.3 * 2 * math.pi)
        noise = 0.012 * (self._rng.random() * 2 - 1)
        v = base + wave * (1 - math.exp(-te / tau)) + noise

        # auto-script an interruption if the orchestrator hasn't fired one yet,
        # so the demo always shows the full arc
        if self._interrupt_at is None and te > 45.0:
            self._interrupt_at = te
        if self._interrupt_at is not None:
            d = te - self._interrupt_at
            if d >= 0:
                fall = 1.0 - math.exp(-d / 1.4)
                rec = math.exp(-d / 9.0)
                v -= dip_amp * fall * rec / 0.36
        return max(0.04, min(0.98, v))

    def _on_window(self, r):
        """One accepted analysis window, measured from the synthetic raw stream.

        This is the same callback shape zone_source uses, so simulation and
        hardware emit an identical wire message and neither can drift from the
        other. It replaces a hand-tuned table of band constants that never went
        near the analyser: the room's own DSP could be completely broken and
        every simulated session would still have looked perfect.
        """
        osc, ap, q, share = r["osc"], r["aperiodic"], r["quality"], r["share"]
        self.tx.send(
            OUT.BRAINWAVES,
            delta=round(share["delta"], 5), theta=round(share["theta"], 5),
            alpha=round(share["alpha"], 5), beta=round(share["beta"], 5),
            gamma=round(share["gamma"], 5),
            engIndex=round(r["engagement"], 4),
            bandsSchema=2,
            osc={k: round(v, 3) for k, v in osc.items()},
            ap={"exponent": round(ap["exponent"], 3), "offsetLog10": round(ap["offsetLog10"], 4),
                "r2": round(ap["r2"], 4), "retainedFrac": round(ap["retainedFrac"], 3),
                "mode": ap["mode"], "ok": ap["ok"]},
            quality=q, simulation=True,
        )

    async def _session_loop(self):
        tick = 0
        try:
            while self._running:
                te = time.monotonic() - self._t_start
                e = self._engagement_at(te)
                self._engagement_now = e
                now_ms = int(time.time() * 1000)

                # signal-trouble scenario: a degraded window mid-read
                dropout = self._scenario == "dropout" and 22.0 <= te <= 32.0
                self.engine.set_signal_quality(0.35 if dropout else 0.97)

                # Phase 2A: labelled synthetic raw EEG (250 Hz, batched) — the live
                # signal-check screen renders THIS, not the ~1 Hz band lines.
                self._emit_synth_raw(te)

                frame = self.engine.feed(e, now_ms)
                if frame is not None:
                    events = frame.pop("events", [])
                    self.tx.send(OUT.FRAME, **frame)
                    for ev in events:
                        if ev == "plateau":
                            self.tx.send(OUT.PLATEAU, tRel=frame["tRel"])
                        elif ev == "dip":
                            self.tx.send(OUT.DIP, tRel=frame["tRel"])

                # ~1 Hz: native metrics + band powers + stats (diagnostic cross-checks)
                if tick % 5 == 0:
                    self.tx.send(
                        OUT.METRICS, engagement=round(e, 4),
                        focus=round(max(0, min(1, e + 0.03 * (self._rng.random() * 2 - 1))), 4),
                        stress=round(max(0, min(1, 0.4 - 0.2 * e + 0.05 * self._rng.random())), 4),
                        mental_readiness=round(0.6 + 0.3 * e, 4),
                        drowsiness=round(max(0, 0.3 - 0.25 * e), 4),
                        relaxation=round(max(0, min(1, 1 - e * 0.6)), 4),
                        wellness=None,
                    )
                    # Band values are NOT scripted any more. They are measured from the
                    # synthetic raw above by the same BandAnalyzer the hardware path uses,
                    # and arrive through _on_window. Emitting them from here as well would
                    # be inventing a second, disagreeing answer.
                    rate = (120 + self._rng.random() * 10) if dropout else (248 + self._rng.random() * 2)
                    drop = round(0.45 if dropout else 0.0, 3)
                    self.tx.send(OUT.STATS,
                                 dev1={"connected": True, "received": int(te * 250), "dropped": int(te * 50) if dropout else 0,
                                       "rate": round(rate, 1), "notifications": int(te * 35),
                                       "notify_rate": 35.0},
                                 dev2={"connected": True, "received": int(te * 250), "dropped": 0,
                                       "rate": round(rate - 0.5, 1), "notifications": int(te * 35),
                                       "notify_rate": 35.0},
                                 elapsed=round(te, 2))
                    self.tx.send(OUT.CONNECTION, leftConnected=True, rightConnected=True,
                                 dropRateL=drop, dropRateR=0.0, batteryL=88, batteryR=91)

                tick += 1
                await asyncio.sleep(0.2)
        except asyncio.CancelledError:
            pass

    # ---------------- shared ----------------
    async def discover(self):
        self.tx.send(OUT.DISCOVERED, devices=[
            {"name": "Zone EEG Left (sim)", "address": "SIM-L", "rssi": -42, "side": "left"},
            {"name": "Zone EEG Right (sim)", "address": "SIM-R", "rssi": -45, "side": "right"},
        ])

    async def connect(self):
        self.tx.send(OUT.CONNECTION, leftConnected=True, rightConnected=True,
                     dropRateL=0.0, dropRateR=0.0, batteryL=88, batteryR=91)

    async def disconnect(self):
        await self.stop_session()
        await self.stop_fit()

    async def _cancel(self, task):
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
