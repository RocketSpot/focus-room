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

from protocol import OUT
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
        # Phase 2A: a LABELLED synthetic raw stream so the live-EEG pipeline can be
        # exercised without hardware. It is a deterministic sum of sines at real
        # ADC-count scale — NEVER passed off as real: every payload carries
        # simulation:true and the screen shows a persistent SIMULATED badge.
        self._eeg_stream = None
        self._raw_i = 0

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
        self._raw_i = 0
        self._task = asyncio.create_task(self._session_loop())
        self.log("sim session started")

    def _synth_raw_batch(self, n):
        """Deterministic synthetic EEG-like batch: a sum of sines (10 Hz alpha,
        20 Hz beta, 6 Hz theta, 2 Hz slow) at ADC-count scale, per channel with a
        small phase/amplitude offset so the four traces differ. NOT random noise,
        NOT passed off as real (simulation:true everywhere)."""
        cols = [[], [], [], []]
        for _ in range(n):
            t = self._raw_i / self.RAW_FS
            env = 1.0 + 0.15 * math.sin(2 * math.pi * 0.1 * t)   # slow breathing envelope
            for c in range(4):
                ph = c * 0.55
                amp = 1.0 - 0.07 * c
                v = amp * env * (
                    820 * math.sin(2 * math.pi * 10.0 * t + ph)
                    + 300 * math.sin(2 * math.pi * 20.0 * t + 0.7 + ph)
                    + 250 * math.sin(2 * math.pi * 6.0 * t + 1.3 + ph)
                    + 200 * math.sin(2 * math.pi * 2.0 * t + ph)
                )
                cols[c].append(v)
            self._raw_i += 1
        return cols

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
        cols = self._synth_raw_batch(self.RAW_BATCH)
        if self._scenario == "dropout" and 26.0 <= te < 32.0:
            cols[2] = [10.0] * self.RAW_BATCH    # Right-A flatline (dead contact)
            cols[3] = [12.0] * self.RAW_BATCH    # Right-B flatline
        self._eeg_stream.ingest(cols, labels, sdk_rate=int(self.RAW_FS))

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

    def _bands(self, e: float):
        # consistent with the engagement index beta/(alpha+theta)
        beta = 0.5 + e * 1.6
        alpha = 1.25 - e * 0.45
        theta = 0.85 - e * 0.25
        delta = 0.6 + 0.1 * (self._rng.random())
        gamma = 0.25 + e * 0.4
        return delta, theta, alpha, beta, gamma

    async def _session_loop(self):
        tick = 0
        try:
            while self._running:
                te = time.monotonic() - self._t_start
                e = self._engagement_at(te)
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
                    d, th, a, b, g = self._bands(e)
                    self.tx.send(
                        OUT.METRICS, engagement=round(e, 4),
                        focus=round(max(0, min(1, e + 0.03 * (self._rng.random() * 2 - 1))), 4),
                        stress=round(max(0, min(1, 0.4 - 0.2 * e + 0.05 * self._rng.random())), 4),
                        mental_readiness=round(0.6 + 0.3 * e, 4),
                        drowsiness=round(max(0, 0.3 - 0.25 * e), 4),
                        relaxation=round(max(0, min(1, 1 - e * 0.6)), 4),
                        wellness=None,
                    )
                    eng_index = b / (a + th) if (a + th) else 0.0
                    self.tx.send(OUT.BRAINWAVES, delta=round(d, 4), theta=round(th, 4),
                                 alpha=round(a, 4), beta=round(b, 4), gamma=round(g, 4),
                                 engIndex=round(eng_index, 4))
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
