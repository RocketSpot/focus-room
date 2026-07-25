"""Real Zone SDK source (v2.0).

Wraps zone_sdk into the same source interface SimSource exposes. Flow: discover
-> GATT-probe connect -> battery gate -> impedance fit check -> stop impedance ->
stream. SDK callbacks (which fire on the asyncio loop and on Bleak worker threads)
push frames through the engine and out over the thread-safe transport.

CONNECT does NOT depend on the UUID catalogue (ble_profiles.json). It reads each
bud's real GATT, picks the EEG service + its notify/write characteristics, and
connects with those — so any genuine Zone bud connects on sight. We then make the
device "known" to the SDK (one _load_profile override) so the SDK's own internal
reconnect paths validate against the real bud, not the catalogue.

Phase 1 exercises this with hardware. It imports zone_sdk lazily so the
simulation build never touches Bleak.
"""

import asyncio
import os
import shutil
import time
from pathlib import Path

from protocol import OUT
from eeg_stream import EegStream

SAFE_BATTERY_PCT = 25          # refuse to start below this so a session never dies mid-read
IMPEDANCE_OK_STATES = {"low_z", "pair_ok"}

# Mid-reading bud-loss recovery: retry ladder, and the signal-quality floor held
# during an outage — below the orchestrator's 0.5 reseat threshold so the guest
# sees the reseat coaching instead of a silently frozen line.
RECONNECT_BACKOFF_SEC = (1.0, 3.0, 8.0, 15.0, 30.0)
OUTAGE_SIGNAL_QUALITY = 0.15

# Nordic UART Service — the common BLE serial profile; preferred if a bud exposes it.
NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX      = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"   # write  (host → bud)
NUS_TX      = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"   # notify (bud → host)
# Every Bluetooth-SIG standard service shares this base UUID (battery, device-info,
# generic access/attribute). The EEG service is vendor-custom, so skip these.
SIG_BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb"
# The Zone vendor service families. Used only to PREFER the right service —
# generic notify+write detection is still the fallback for any other bud.
#   00000000-2fda-  : the family observed on CURRENT hardware (and the old
#                     catalogue) — kept so every bud in the field still connects
#   efaecafe-       : the new engineering catalogue family (July 2026, letters
#                     only) — preferred once buds ship/reflash with it
ZONE_EEG_PREFIXES = ("00000000-2fda-", "efaecafe-")
# Known firmware-update services that ALSO expose a notify+write pair and would
# otherwise be mistaken for the EEG service. Skip them.
DFU_SERVICES = {
    "00001530-1212-efde-1523-785feabcd123",   # Nordic legacy DFU
    "8ec90001-f315-4f60-9fb8-838830daea50",   # Nordic buttonless secure DFU
    "fe59",                                     # Nordic Secure DFU (short)
}


class ZoneSource:
    name = "zone"

    def __init__(self, transport, engine, log):
        from zone_sdk import Zone  # lazy: only in real mode
        self.tx = transport
        self.engine = engine
        self.log = log
        self.Zone = Zone
        self._ensure_profiles()        # legacy fallback only — connect() no longer needs the catalogue
        self.sdk = Zone()
        self.sdk.set_stream_chunk(50)
        self.sdk.set_stream_idle_sleep(0.01)

        # Captured ONCE here — ZoneSource is constructed inside the sidecar's
        # asyncio.run() loop. SDK callbacks (disconnect, stats) fire on Bleak
        # worker-loop threads, so anything that touches the loop/SDK state must
        # be bounced back onto THIS loop, not scheduled on the worker's loop.
        self._loop = asyncio.get_running_loop()

        self._left_addr = None
        self._right_addr = None
        self._left_uuids = None     # real {service,rx,tx} probed off the left bud's GATT
        self._right_uuids = None
        self._streaming = False
        self._reconnecting = False
        self._rotating = False           # the liveness rotation owns the link right now
        self._session_active = False     # a guest reading is in progress (start..stop)
        self._metrics_since_stream = 0   # liveness: did EEG frames arrive after start?
        # Ranked EEG candidates from the last GATT probe, per side, plus the
        # services already proven silent — so a re-probe (reconnect/rotation)
        # returns the CURRENTLY SELECTED candidate, not always rank 0.
        self._left_candidates = []       # [(tier, {"service","rx","tx"}), ...]
        self._right_candidates = []
        self._eeg_failed = {"left": set(), "right": set()}
        self._auto_pair = None           # the mutable 'auto' PairProfile (touch fill-in)
        self._last_impedance = None
        self._last_battery_l = None
        self._last_battery_r = None

        self.sdk.on_metrics(self._on_metrics)
        self.sdk.on_brainwaves(self._on_brainwaves)
        self.sdk.on_stats(self._on_stats)
        self.sdk.on_connection_status(self._on_connection)
        self.sdk.on_impedance(self._on_impedance)
        # Phase 2A: raw per-channel EEG. The SDK already decodes + emits ADC counts
        # here every chunk; before 2A nothing subscribed, so raw never left the SDK.
        self.sdk.on_raw_data(self._on_raw)
        self._eeg_stream = None       # per-session raw transport + quality (eeg_stream.py)
        self._left_up = False         # last-known link state, for single-bud raw labelling
        self._right_up = False

    def _catalogue_path(self):
        """Which UUID catalogue ships to the SDK. Engineering delivered three
        technique variants (July 2026); the shipped default ble_profiles.json is
        technique 3, and FOCUSROOM_UUID_CATALOGUE=1|2|3 selects another for
        evaluation without touching files."""
        n = os.environ.get("FOCUSROOM_UUID_CATALOGUE", "").strip()
        base = Path(__file__).resolve().parent
        if n in ("1", "2", "3"):
            p = base / f"ble_profiles.catalogue-{n}.json"
            if p.exists():
                return p
            self.log(f"catalogue {n} not found next to the sidecar — using the shipped default")
        return base / "ble_profiles.json"

    def _ensure_profiles(self):
        """The SDK loads ble_profiles.json from its own package dir to validate a
        profile connect. We ship our copy (generated from the UUID catalogue)
        next to this file and install it into the SDK package. A stale copy is
        REPLACED when its content differs from ours — the early-return on an
        existing file meant a catalogue update never reached an SDK that had
        run before, and the room would keep validating against retired UUIDs."""
        try:
            import zone_sdk
            target = Path(zone_sdk.__file__).resolve().parent / "ble_profiles.json"
            src = self._catalogue_path()
            if not src.exists():
                self.log("ble_profiles.json not found next to the sidecar — real connect needs it")
                return
            if target.exists() and target.read_bytes() == src.read_bytes():
                return
            shutil.copyfile(src, target)
            self.log(f"installed {src.name} → {target}")
        except Exception as e:
            self.log(f"could not install ble_profiles.json: {e}")

    # ---------------- discovery / connect ----------------
    async def discover(self):
        devices = await self.Zone.discover(duration=5)
        out = []
        for d in devices:
            name = (d.get("name") or "").lower()
            side = "left" if "left" in name else ("right" if "right" in name else None)
            if side == "left":
                self._left_addr = d["address"]
            elif side == "right":
                self._right_addr = d["address"]
            out.append({"name": d.get("name"), "address": d["address"],
                        "rssi": d.get("rssi"), "side": side})
        self.tx.send(OUT.DISCOVERED, devices=out)
        return out

    async def connect(self):
        if not self._left_addr and not self._right_addr:
            await self.discover()
        if not self._left_addr and not self._right_addr:
            self.tx.send(OUT.CONNECTION, leftConnected=False, rightConnected=False, connected=False)
            self.tx.send(OUT.ERROR, code="no_buds", msg="no Zone buds discovered")
            return False
        # Fresh explicit connect: forget prior rotation state so the ranked
        # probe starts from rank 0 again (a past failure may have been transient).
        self._eeg_failed = {"left": set(), "right": set()}
        # Hook the SDK to self-discover the EEG service off the live device, then run
        # its NORMAL validated connect. The GATT read happens INSIDE the SDK's tuned
        # connect sequence (not as a separate pre-connection of ours) — that keeps
        # Windows from losing the address between probe and connect, and keeps us on
        # the validated path so the SDK's own auto-reconnect works.
        self._install_overrides()
        ok = await self.sdk.connect_selected(
            left_address=self._left_addr, right_address=self._right_addr,
            profile="zone_eeg", skip_validation=False)
        status = self.sdk.get_buds_status()
        self.tx.send(OUT.CONNECTION,
                     leftConnected=bool(status.get("left_connected")),
                     rightConnected=bool(status.get("right_connected")),
                     connected=ok)
        return ok

    # ---------------- catalogue-free connect (SDK self-discovery hooks) ----------------
    def _install_overrides(self):
        """Replace the SDK's two catalogue touch-points with live self-discovery —
        covering BOTH our connect and the SDK's own internal auto-reconnect (which
        also uses the validated path):
          * _load_profile   → a single 'auto' pair whose has_eeg gate is satisfied
            (the REAL triplet flows into the connection via _match_side, below).
          * _match_pair_side → probe the bud's GATT and return its own EEG triplet
            instead of comparing against the catalogue."""
        from zone_sdk.profile import PairProfile
        placeholder = {"service": "auto", "rx": "auto", "tx": "auto"}  # non-None → has_eeg True
        # left/right_touch start None and are filled in per side by _match_side
        # once the probe knows the siblings (the pair object is mutable; the SDK
        # collects the extra-TX subscriptions AFTER both matches resolve, so the
        # fill-in lands in time). Battery stays None ON PURPOSE: battery drives
        # get_battery writes and the keepalive 'q' ping — verified the keepalive
        # loop no-ops cleanly with battery None and has_battery stays False, so
        # the battery gate keeps skipping.
        pair = PairProfile(
            name="auto", left_eeg=placeholder, right_eeg=placeholder,
            left_battery=None, right_battery=None, left_touch=None, right_touch=None,
            metadata={"Serial_Number": "auto",
                      "Left_MAC_Address": self._left_addr,
                      "Right_MAC_Address": self._right_addr})
        self._auto_pair = pair
        self.sdk._load_profile = lambda profile, _p={"auto": pair}: _p
        self.sdk._match_pair_side = self._match_side

    async def _match_side(self, address, pairs, side):
        """Drop-in for the SDK's catalogue matcher: probe the live GATT and return
        this bud's own EEG triplet as the 'auto' pair match (or None to fail)."""
        trip = await self._probe_uuids(address, side)
        if not trip:
            return None
        if side == "left":
            self._left_uuids = trip
        else:
            self._right_uuids = trip
        self._arm_keepalive_sibling(side, trip)
        return ("auto", trip)

    def _arm_keepalive_sibling(self, side, chosen):
        """Re-arm the Windows dual-link anti-throttle. During connect the SDK
        subscribes the active pair's battery/touch TX chars with NO-OP handlers
        (zone.py extras → connection.py start_notify) purely to keep both BLE
        links at a fast connection interval; our 'auto' pair had none, so one
        link could demote to ~50Hz. Fill the pair's touch triplet per side with
        the best NON-chosen zone-family disjoint sibling from the probe.
        Verified in zone.py/connection.py: touch triplets feed ONLY the extra
        passive-notify subscription — no write path, no ping loop touches them."""
        pair = self._auto_pair
        if pair is None:
            self.log(f"{side}: no auto pair to arm keepalive sibling on")
            return
        cands = self._left_candidates if side == "left" else self._right_candidates
        sib = next((t for tier, t in cands
                    if tier == 0 and t["service"] != chosen["service"]), None)
        if side == "left":
            pair.left_touch = sib
        else:
            pair.right_touch = sib
        if sib:
            self.log(f"{side}: keepalive sibling {sib['service']} (tx={sib['tx']}) "
                     f"→ pair touch, passive notify only")
        else:
            self.log(f"{side}: no zone-family disjoint sibling — anti-throttle "
                     f"keepalive subscription not armed for this side")

    async def _probe_uuids(self, address, side):
        """Open the bud's GATT and pick the EEG service + its notify (TX, data) and
        write (RX, command) characteristics. No catalogue. Returns {"service","rx",
        "tx"} or None. TX/RX match the SDK contract (start_notify on tx, write rx).

        Runs INSIDE the SDK's validated connect (installed as _match_pair_side), so
        its connect/disconnect mirrors the SDK's own proven probe timing.

        Keeps the FULL ranked candidate list per side (for the liveness rotation
        and the keepalive sibling) and skips services already proven silent, so
        a reconnect re-probe lands on the currently selected candidate."""
        from bleak import BleakClient
        client = BleakClient(address)
        if side == "left":
            self._left_candidates = []
        else:
            self._right_candidates = []
        failed = self._eeg_failed[side]
        try:
            await client.connect(timeout=15.0)
            try:
                await client.get_services()
            except Exception:
                pass
            services = list(client.services)

            # Full vendor GATT dump — ground truth if a guess is ever wrong.
            for s in services:
                su = str(s.uuid).lower()
                if su.endswith(SIG_BASE_SUFFIX):
                    continue
                desc = ", ".join(f"{str(c.uuid).lower()}[{'/'.join(c.properties)}]"
                                 for c in s.characteristics)
                self.log(f"{side}: GATT service {su} :: {desc or '(no chars)'}")

            # Nordic UART, if a (future) bud uses it and the roles check out.
            for s in services:
                if str(s.uuid).lower() != NUS_SERVICE or NUS_SERVICE in failed:
                    continue
                cmap = {str(c.uuid).lower(): c for c in s.characteristics}
                tx, rx = cmap.get(NUS_TX), cmap.get(NUS_RX)
                if tx and rx and ("notify" in tx.properties or "indicate" in tx.properties) \
                        and ("write" in rx.properties or "write-without-response" in rx.properties):
                    self.log(f"{side}: matched Nordic UART rx={NUS_RX} tx={NUS_TX}")
                    trip = {"service": NUS_SERVICE, "rx": NUS_RX, "tx": NUS_TX}
                    if side == "left":
                        self._left_candidates = [(1, trip)]
                    else:
                        self._right_candidates = [(1, trip)]
                    return trip

            # Rank vendor-custom services. The real Zone EEG/battery/touch services are
            # the 00000000-2fda-… family, each with SEPARATE notify+write chars; a lone
            # bidirectional-char service (pairing/control) is a last resort. Prefer:
            # zone-family & disjoint  >  disjoint  >  zone-family  >  shared char.
            ranked = []
            for s in services:
                su = str(s.uuid).lower()
                if su.endswith(SIG_BASE_SUFFIX) or su in DFU_SERVICES:
                    continue
                trip = self._pick_eeg_chars(su, list(s.characteristics))
                if not trip:
                    continue
                disjoint = trip["tx"] != trip["rx"]
                zone = su.startswith(ZONE_EEG_PREFIXES)
                tier = 0 if (zone and disjoint) else 1 if disjoint else 2 if zone else 3
                ranked.append(((tier, su), trip))
                self.log(f"{side}: EEG candidate {su} rx={trip['rx']} tx={trip['tx']}"
                         f" [{'disjoint' if disjoint else 'shared'}{' zone' if zone else ''}]")
            if ranked:
                ranked.sort(key=lambda r: r[0])     # lowest tier, then lowest UUID
                cands = [(key[0], trip) for key, trip in ranked]
                if side == "left":
                    self._left_candidates = cands
                else:
                    self._right_candidates = cands
                best = next((t for _, t in cands if t["service"] not in failed), None)
                if best is None:
                    # rotation exhausted this side — best guess is still rank 0
                    best = cands[0][1]
                    self.log(f"{side}: all {len(cands)} EEG candidates previously "
                             f"failed — falling back to rank 0 {best['service']}")
                elif failed:
                    self.log(f"{side}: rotation active — skipping "
                             f"{len(failed)} failed candidate(s)")
                self.log(f"{side}: using EEG service {best['service']} "
                         f"(rx={best['rx']} tx={best['tx']})")
                return best

            self.log(f"{side}: no EEG-like (notify+write) service on {address}")
            return None
        except Exception as e:
            self.log(f"{side}: GATT probe failed on {address}: {e}")
            return None
        finally:
            try:
                if client.is_connected:
                    await client.disconnect()
            except Exception:
                pass
            await asyncio.sleep(0.3)

    @staticmethod
    def _pick_eeg_chars(service_uuid, chars):
        """From one service's characteristics, choose TX (notify) and RX (write).
        Prefer DISJOINT chars — a notify-only TX and a write-only RX — so a char
        that advertises several properties can't end up aliased to both. Fall back
        to a shared bidirectional char only if no disjoint pair exists."""
        def has(c, *names):
            return any(n in c.properties for n in names)
        notify = [c for c in chars if has(c, "notify", "indicate")]
        writes = [c for c in chars if has(c, "write", "write-without-response")]
        if not notify or not writes:
            return None
        # TX = data out of the bud: prefer a notify char that doesn't also write.
        tx = next((c for c in notify if not has(c, "write", "write-without-response")), notify[0])
        # RX = commands into the bud: prefer a write char that doesn't also notify,
        # and prefer write-without-response (the SDK writes with response=False).
        cmd_only = [c for c in writes if not has(c, "notify", "indicate")]
        pool = cmd_only or writes
        rx = next((c for c in pool if has(c, "write-without-response")), pool[0])
        return {"service": service_uuid, "rx": str(rx.uuid).lower(), "tx": str(tx.uuid).lower()}

    # ---------------- pre-session fit check ----------------
    async def start_fit(self):
        await self._battery_gate()
        # impedance and streaming are mutually exclusive — fit check is pre-session
        await self.sdk.start_impedance()
        self.log("impedance fit check armed")

    async def _battery_gate(self):
        from zone_sdk import ZoneFeatureUnavailable
        status = self.sdk.get_buds_status()
        pair = status.get("pair") or {}
        if not pair.get("has_battery"):
            self.log("battery: pair does not report battery — skipping gate")
            self.tx.send(OUT.BATTERY, leftPct=None, rightPct=None, ok=True, skipped=True)
            return
        try:
            batt = await self.sdk.get_battery()
        except ZoneFeatureUnavailable as e:
            self.log(f"battery unavailable ({e}) — skipping gate")
            self.tx.send(OUT.BATTERY, leftPct=None, rightPct=None, ok=True, skipped=True)
            return
        left = batt.get("left")
        right = batt.get("right")
        lp = left.percentage if left else None
        rp = right.percentage if right else None
        self._last_battery_l, self._last_battery_r = lp, rp
        ok = all(p is None or p >= SAFE_BATTERY_PCT for p in (lp, rp))
        self.tx.send(OUT.BATTERY, leftPct=lp, rightPct=rp, ok=ok)

    async def stop_fit(self):
        try:
            await self.sdk.stop_impedance()
        except Exception as e:
            self.log(f"stop_impedance error: {e}")

    # ---------------- live session ----------------
    async def start_session(self):
        # re-entrancy guard (parity with sim): a duplicate START_SESSION must
        # not wipe the live buffer mid-reading.
        if self._session_active:
            self.log("start_session ignored — session already active")
            return True
        # ensure impedance is disarmed (it cannot run with streaming)
        if self.sdk.get_buds_status().get("impedance_armed"):
            await self.sdk.stop_impedance()
        self.engine.reset()   # per-session: guest 2 never inherits guest 1's band/plateau
        self._flush_stale_buffers("session start")   # drop the fit check's lead-off tone
        self._session_active = True
        self._metrics_since_stream = 0
        # Fresh raw transport + quality per session (continuity/quality reset).
        st = self.sdk.get_buds_status()
        self._left_up = bool(st.get("left_connected"))
        self._right_up = bool(st.get("right_connected"))
        self._eeg_stream = EegStream(self.tx, self.log, simulation=False, expected_rate_hz=250)
        ok = await self.sdk.start_streaming()
        self._streaming = bool(ok)
        self.engine.set_signal_quality(0.9)
        self.log(f"streaming started: {ok}")
        if self._streaming:
            asyncio.create_task(self._stream_liveness_check())
        return ok

    def _flush_stale_buffers(self, why):
        """Drop residual EEG samples between fit and streaming (and after a
        reconnect) so the fit check's 31.25Hz lead-off tone — or pre-outage
        samples — can't be served as the reading's first windows and anchor the
        engine's floor. Verified in connection.py/zone.py: _channel_buffers and
        _proc_buffers persist across stop_impedance → start_streaming. Never
        flushes while impedance is armed (the fit check owns those samples)."""
        if self.sdk.get_buds_status().get("impedance_armed"):
            self.log(f"flush({why}) skipped — impedance armed")
            return
        flushed = 0
        conn = getattr(self.sdk, "_conn", None)
        if conn is not None and hasattr(conn, "_channel_buffers"):
            for buf in conn._channel_buffers:
                flushed += len(buf)
                buf.clear()
        else:
            self.log(f"flush({why}): SDK _conn._channel_buffers not found — "
                     f"skipping (SDK layout changed?)")
        proc = getattr(self.sdk, "_proc_buffers", None)
        if proc:
            for buf in proc:
                flushed += len(buf)
                buf.clear()
        self.log(f"flushed {flushed} stale buffered samples ({why})")

    def _decoded_counts(self):
        """Per-side decoded EEG-frame counts from the SDK link stats ('received'
        counts only decoded A0..C0 frames), for connected sides. None if the SDK
        layout changed. Distinguishes 'the pick is wrong' (silence) from 'the
        pick is right but the link is throttled' (frames decode, just slowly)."""
        conn = getattr(self.sdk, "_conn", None)
        if conn is None or not hasattr(conn, "get_stats"):
            return None
        try:
            s = conn.get_stats()
        except Exception as e:
            self.log(f"get_stats failed: {e}")
            return None
        out = {}
        for dev, side in (("dev1", "left"), ("dev2", "right")):
            d = s.get(dev) or {}
            if d.get("connected"):
                out[side] = float(d.get("received") or 0.0)
        return out

    async def _stream_liveness_check(self):
        """Connected but silent = the probe picked a service that isn't the EEG one
        (no 0xA0..0xC0 frames decode → zero metrics). Instead of dying as silence,
        rotate through the ranked probe candidates; only when the rotation is
        exhausted emit the final no_eeg_data error."""
        await asyncio.sleep(6.0)
        if not self._streaming or self._metrics_since_stream > 0:
            return
        if self._reconnecting or self._rotating:
            return  # a recovery path owns the link; it re-arms this check when done
        if getattr(self.sdk, "_inside_sample_rate_recovery", False):
            # the SDK's own rate recovery is mid-teardown — a metrics gap is
            # expected; don't fight it, just check again after it settles.
            self.log("liveness: SDK sample-rate recovery in flight — re-checking in 6s")
            asyncio.create_task(self._stream_liveness_check())
            return
        # Throttled ≠ wrong: metrics need a full window on the SLOWER side, so a
        # Windows-demoted (~50Hz) but CORRECT link can be silent at 6s. If frames
        # are decoding on every connected side, keep the pick and keep watching —
        # never rotate away from the right service.
        counts = self._decoded_counts()
        if counts and all(c > 100 for c in counts.values()):
            self.log(f"liveness: no metrics yet but EEG frames decoding {counts} — "
                     "link slow, not wrong; re-checking in 6s")
            asyncio.create_task(self._stream_liveness_check())
            return
        if self._has_untried_candidates():
            await self._rotate_eeg_candidates()
            return
        svc = (self._left_uuids or self._right_uuids or {}).get("service")
        self.tx.send(OUT.ERROR, code="no_eeg_data",
                     msg=(f"streaming but no EEG frames after 6s — the probed service "
                          f"({svc}) may not be the EEG one; check the GATT dump in the log"))
        self.log("LIVENESS: no metrics 6s into streaming — likely the wrong EEG service")

    def _has_untried_candidates(self):
        """True if any connected side still has a probe candidate that hasn't
        been proven silent (the current pick counts as about-to-fail)."""
        for side, cands, current in (("left", self._left_candidates, self._left_uuids),
                                     ("right", self._right_candidates, self._right_uuids)):
            if current is None:
                continue
            failed = self._eeg_failed[side] | {current["service"]}
            if any(t["service"] not in failed for _, t in cands):
                return True
        return False

    async def _rotate_eeg_candidates(self):
        """Verify-the-pick-by-framing fallback: the current EEG pick produced no
        frames, so mark it failed per side and reconnect through the SDK's
        validated path — _match_side re-probes and returns the next unfailed
        candidate (and rebuilds the keepalive siblings). Bounded to one pass
        through the list; then the liveness check emits the final error."""
        self._rotating = True   # keeps _maybe_reconnect and the SDK watch off the link
        try:
            # The aligned reader starves on the min() across sides, so ONE wrong
            # pick silences all metrics. Mark failed only the side(s) that are
            # actually silent — a side that is decoding frames keeps its pick.
            # (counts None = SDK layout changed → conservative old behavior.)
            counts = self._decoded_counts()
            for side, current in (("left", self._left_uuids), ("right", self._right_uuids)):
                if current is None:
                    continue
                if counts is not None and side not in counts:
                    continue   # link down right now — not the pick's fault
                if counts is not None and counts.get(side, 0.0) > 100:
                    self.log(f"rotation: {side} pick is decoding frames "
                             f"({counts[side]:.0f} received) — keeping it")
                    continue
                self._eeg_failed[side].add(current["service"])
            self.log("LIVENESS: no metrics 6s into streaming — ROTATING EEG pick; "
                     f"failed L={sorted(self._eeg_failed['left'])} "
                     f"R={sorted(self._eeg_failed['right'])}")
            self._streaming = False
            try:
                # full teardown: stops streaming + keepalive, frees both links so
                # the validated re-probe can open its own GATT connection.
                await self.sdk.disconnect()
            except Exception as e:
                self.log(f"rotation disconnect error: {e}")
            ok = await self.sdk.connect_selected(
                left_address=self._left_addr, right_address=self._right_addr,
                profile="zone_eeg", skip_validation=False)
            if not ok:
                self.tx.send(OUT.ERROR, code="no_eeg_data",
                             msg="EEG service rotation reconnect failed — "
                                 "no candidate produced data")
                return
            if not self._session_active:
                self.log("rotation: session ended mid-rotation — not restarting the stream")
                return
            self._flush_stale_buffers("candidate rotation")
            self._metrics_since_stream = 0
            ok = await self.sdk.start_streaming()
            self._streaming = bool(ok)
            self.log(f"rotation: streaming restarted={ok} on "
                     f"L={(self._left_uuids or {}).get('service')} "
                     f"R={(self._right_uuids or {}).get('service')}")
            if self._streaming:
                asyncio.create_task(self._stream_liveness_check())   # re-arm
        finally:
            self._rotating = False

    async def stop_session(self):
        self._session_active = False
        if self._eeg_stream is not None:
            self._eeg_stream.close("stop_session")   # flush + close any validation capture
        self._eeg_stream = None   # ignore any raw callbacks that arrive after stop
        if self._streaming:
            try:
                await self.sdk.stop_streaming()
            except Exception as e:
                self.log(f"stop_streaming error: {e}")
        self._streaming = False
        if self.engine.samples:
            self.tx.send(OUT.SESSION_SAMPLES, samples=self.engine.samples)
            self.tx.send(OUT.ARCHETYPE, **self.engine.compute_archetype())

    def mark(self, kind, t):
        # The interruption is a real pull; the dip is whatever the brain does.
        # We only record the alignment — the engine detects the real dip.
        self.log(f"mark {kind} @ {t}")
        # in validation mode, a mark is also a staff event annotation on the raw capture
        # (blink / swallow / L-out / disconnect / …). NOT a classifier.
        if self._eeg_stream is not None:
            self._eeg_stream.annotate(kind, t)

    def test_signal(self):
        res = self.sdk.send_test_signal()
        if asyncio.iscoroutine(res):
            asyncio.create_task(res)
        self.tx.send(OUT.LOG, level="info", msg="test_signal injected through real pipeline")

    async def disconnect(self):
        await self.stop_session()
        try:
            await self.sdk.disconnect()
        except Exception as e:
            self.log(f"disconnect error: {e}")

    # ---------------- SDK callbacks ----------------
    def _on_metrics(self, m):
        now_ms = int(time.time() * 1000)
        self._metrics_since_stream += 1   # liveness: EEG frames are flowing
        # raw native metrics → diagnostic + engine
        self.tx.send(OUT.METRICS, engagement=m.engagement, focus=m.focus, stress=m.stress,
                     mental_readiness=m.mental_readiness, drowsiness=m.drowsiness,
                     relaxation=getattr(m, "relaxation", None), wellness=getattr(m, "wellness", None))
        frame = self.engine.feed(m.engagement, now_ms)
        if frame is not None:
            events = frame.pop("events", [])
            self.tx.send(OUT.FRAME, **frame)
            for ev in events:
                if ev == "plateau":
                    self.tx.send(OUT.PLATEAU, tRel=frame["tRel"])
                elif ev == "dip":
                    self.tx.send(OUT.DIP, tRel=frame["tRel"])

    def _on_raw(self, raw):
        """Phase 2A: forward raw per-channel ADC counts through EegStream (batched
        transport + honest quality). raw.channels is 4 lists when both buds are up,
        2 when a single bud streams. Labels are PROVISIONAL (see hardware doc); we
        never subtract, re-reference, or average channels here."""
        stream = self._eeg_stream
        if stream is None:
            return
        chans = raw.channels
        if not chans or not isinstance(chans[0], list):
            return
        n = len(chans)
        if n >= 4:
            labels, cols = ["Left-A", "Left-B", "Right-A", "Right-B"], chans[:4]
        elif n == 2:
            if self._right_up and not self._left_up:
                labels, cols = ["Right-A", "Right-B"], chans
            else:                              # left, or ambiguous → provisional left
                labels, cols = ["Left-A", "Left-B"], chans
        else:
            return
        try:
            stream.ingest(cols, labels, sdk_rate=getattr(raw, "sample_rate", None))
        except Exception as e:
            self.log(f"eeg_stream ingest error: {e}")

    def _on_brainwaves(self, b):
        denom = (b.alpha + b.theta)
        eng_index = (b.beta / denom) if denom else 0.0
        self.tx.send(OUT.BRAINWAVES, delta=b.delta, theta=b.theta, alpha=b.alpha,
                     beta=b.beta, gamma=b.gamma, engIndex=round(eng_index, 4))

    def _on_stats(self, s):
        self.tx.send(OUT.STATS, dev1=s.get("dev1"), dev2=s.get("dev2"), elapsed=s.get("elapsed"))
        # signal quality from worst connected bud's rate and drop ratio
        q = 1.0
        for dev in ("dev1", "dev2"):
            d = s.get(dev) or {}
            if not d.get("connected"):
                continue
            rate = float(d.get("rate") or 0.0)
            recv = float(d.get("received") or 0.0)
            drop = float(d.get("dropped") or 0.0)
            rate_q = max(0.0, min(1.0, rate / 250.0))
            drop_q = 1.0 - (drop / (recv + drop)) if (recv + drop) > 0 else 1.0
            q = min(q, rate_q * drop_q)
        if self._reconnecting:
            # mid-outage the healthy bud's stats would read clean (~1/s) and
            # overwrite the forced-down quality — hold the floor so the
            # orchestrator's reseat watch keeps firing until recovery.
            q = min(q, OUTAGE_SIGNAL_QUALITY)
        # _on_stats runs on a BLE worker thread; this is a single GIL-atomic
        # float set, read on the main loop in engine.feed() — safe without a lock.
        self.engine.set_signal_quality(q)
        d1, d2 = s.get("dev1") or {}, s.get("dev2") or {}
        # keep link-side state current for single-bud raw labelling
        self._left_up = bool(d1.get("connected"))
        self._right_up = bool(d2.get("connected"))
        # carry last-known battery so eeg/connection matches the sim shape
        self.tx.send(OUT.CONNECTION,
                     leftConnected=bool(d1.get("connected")),
                     rightConnected=bool(d2.get("connected")),
                     dropRateL=self._drop_rate(d1), dropRateR=self._drop_rate(d2),
                     batteryL=self._last_battery_l, batteryR=self._last_battery_r)

    @staticmethod
    def _drop_rate(d):
        recv = float(d.get("received") or 0.0)
        drop = float(d.get("dropped") or 0.0)
        return round(drop / (recv + drop), 4) if (recv + drop) > 0 else 0.0

    def _on_connection(self, status: str):
        self.tx.send(OUT.CONNECTION, status=status)
        if status in ("left_disconnected", "right_disconnected"):
            # This callback can fire on a Bleak worker-loop thread. Bounce the
            # reconnect onto the sidecar's MAIN loop so connect_selected/streaming
            # run on the right loop and the _reconnecting guard isn't raced.
            self._loop.call_soon_threadsafe(self._maybe_reconnect, status)

    def _maybe_reconnect(self, status):
        # runs on the main loop (scheduled via call_soon_threadsafe)
        if self._reconnecting or self._rotating:
            return
        if getattr(self.sdk, "_inside_sample_rate_recovery", False):
            self.log(f"{status}: SDK sample-rate recovery in flight — leaving it to the SDK")
            return
        self._reconnecting = True
        asyncio.create_task(self._attempt_reconnect(status))

    async def _attempt_reconnect(self, status):
        """Mid-reading bud-loss recovery. Reconnect ONLY the lost link, flush
        the stale buffers, then cycle stop/start streaming: the SDK's internal
        _streaming flag stays True across a bud drop, so a status-gated start
        would be skipped, the rejoined bud would never receive CMD_START, and
        the aligned reader would freeze on its empty buffers (available==0 →
        ALL frames stop). Backoff ladder; reconnect_failed only after the
        final attempt."""
        self.log(f"{status}: attempting reconnect "
                 f"(backoff {', '.join(f'{d:g}s' for d in RECONNECT_BACKOFF_SEC)})")
        # drive the visible signal down so the orchestrator's reseat watch
        # (signalQuality < 0.5 for 2 frames) fires and the guest sees coaching.
        self.engine.set_signal_quality(OUTAGE_SIGNAL_QUALITY)
        last_err = None
        try:
            for attempt, delay in enumerate(RECONNECT_BACKOFF_SEC, start=1):
                await asyncio.sleep(delay)
                # per-attempt guard: over a ladder this long the SDK's own
                # low-sample-rate recovery can start a full-pair scan-reconnect;
                # interleaving our per-device connect with it could leave a
                # duplicate still-notifying client feeding the same channels.
                if getattr(self.sdk, "_inside_sample_rate_recovery", False):
                    self.log(f"reconnect attempt {attempt}: SDK sample-rate recovery "
                             f"in flight — deferring this attempt to it")
                    continue
                try:
                    ok = await self._reconnect_lost_sides()
                except Exception as e:
                    ok, last_err = False, e
                    self.log(f"reconnect attempt {attempt}/{len(RECONNECT_BACKOFF_SEC)} "
                             f"error: {e}")
                if not ok:
                    self.log(f"reconnect attempt {attempt}/{len(RECONNECT_BACKOFF_SEC)} "
                             f"failed — bud(s) still down")
                    continue
                if self._session_active:
                    # cycle so the stream-start command really reaches the
                    # rejoined bud, with a buffer flush in between.
                    try:
                        await self.sdk.stop_streaming()
                    except Exception as e:
                        self.log(f"post-reconnect stop_streaming error: {e}")
                    self._flush_stale_buffers("reconnect")
                    self._metrics_since_stream = 0
                    # re-check: a STOP_SESSION may have landed during the awaits
                    # above — leave the stream down rather than orphan it.
                    if not self._session_active:
                        self.log("reconnect: session ended during restart — leaving the stream down")
                    else:
                        ok_stream = await self.sdk.start_streaming()
                        self._streaming = bool(ok_stream)
                        self.log(f"post-reconnect streaming restart: {ok_stream}")
                        if not ok_stream:
                            continue
                        asyncio.create_task(self._stream_liveness_check())
                self.engine.set_signal_quality(0.9)   # restored; live stats re-take it ~1/s
                now = self.sdk.get_buds_status()
                self.tx.send(OUT.CONNECTION,
                             leftConnected=bool(now.get("left_connected")),
                             rightConnected=bool(now.get("right_connected")),
                             batteryL=self._last_battery_l, batteryR=self._last_battery_r)
                self.log(f"reconnect recovered on attempt {attempt}")
                return
            self.tx.send(OUT.ERROR, code="reconnect_failed",
                         msg=(f"bud reconnect failed after {len(RECONNECT_BACKOFF_SEC)} "
                              f"attempts" + (f" (last error: {last_err})" if last_err else "")))
        finally:
            self._reconnecting = False

    async def _reconnect_lost_sides(self):
        """Reconnect whichever link(s) are down, leaving the healthy bud alone.
        Verified in zone.py/connection.py: connect_selected with a single
        address calls set_device_profiles with the other side None — wiping its
        EEG profile + extra-TX subscriptions and nulling its remembered address,
        which silently mutes every later command write to the healthy bud. So a
        single-side rejoin goes straight to the SDK's per-device connect
        (hasattr-guarded); the triplets from the initial validated probe still
        apply to the same bud, and its extra-TX keepalive subs are re-made."""
        status = self.sdk.get_buds_status()   # refreshes link state
        need_left = bool(self._left_addr) and not status.get("left_connected")
        need_right = bool(self._right_addr) and not status.get("right_connected")
        if not (need_left or need_right):
            return True
        conn = getattr(self.sdk, "_conn", None)
        if conn is None or not (hasattr(conn, "connect_device1")
                                and hasattr(conn, "connect_device2")):
            # SDK internals moved — full validated pair reconnect as the fallback
            self.log("SDK _conn.connect_device1/2 unavailable — "
                     "falling back to full-pair reconnect")
            return await self.sdk.connect_selected(
                left_address=self._left_addr, right_address=self._right_addr,
                profile="zone_eeg", skip_validation=False)
        ok = True
        if need_left:
            self.log(f"reconnecting left bud only ({self._left_addr}); "
                     f"right link untouched")
            ok = bool(await conn.connect_device1(self._left_addr)) and ok
        if need_right:
            self.log(f"reconnecting right bud only ({self._right_addr}); "
                     f"left link untouched")
            ok = bool(await conn.connect_device2(self._right_addr)) and ok
        return ok

    def _on_impedance(self, snap):
        def ch(c):
            if c is None:
                return None
            return {"kohm": c.kohm, "state": c.state, "phase": c.phase, "hint": c.hint}

        def ear(e):
            if e is None:
                return None
            return {"ch1": ch(e.ch1), "ch2": ch(e.ch2)}

        channels = {"left": ear(snap.left), "right": ear(snap.right)}
        # "Good contact" = the SDK's own QC-pass line: phase == "good" (≤ ~800 kΩ).
        # We gate on PHASE, not on the tighter low_z/pair_ok state buckets (≤150 kΩ):
        # dry in-ear electrodes commonly sit in high_z (150–500 kΩ) while still
        # reading a clean signal, so requiring ≤150 kΩ would never pass a real guest.
        # A channel still filling its window reads phase "idle"/"measuring" → we wait.
        good = bad = pending = 0
        for ear_d in (channels["left"], channels["right"]):
            if ear_d is None:
                continue
            for c in (ear_d["ch1"], ear_d["ch2"]):
                if c is None:
                    continue
                ph = c["phase"]
                if ph == "good":
                    good += 1
                elif ph == "bad":
                    bad += 1
                else:
                    pending += 1        # idle / measuring — still settling
        all_good = good >= 1 and bad == 0 and pending == 0
        self._last_impedance = channels
        self._log_impedance(channels, all_good)
        self.tx.send(OUT.IMPEDANCE, channels=channels, allGood=all_good)

    def _log_impedance(self, channels, all_good):
        """A compact, human-readable impedance line for the diagnostic — logged on
        any allGood change and otherwise at most ~every 1.5s (the raw snapshots
        still stream to the diagnostic verbatim)."""
        now = time.time()
        changed = all_good != getattr(self, "_last_imp_good", None)
        if not changed and (now - getattr(self, "_last_imp_log", 0.0)) < 1.5:
            return
        self._last_imp_log = now
        self._last_imp_good = all_good

        def fmt(ear_d):
            if ear_d is None:
                return "—"
            parts = []
            for name in ("ch1", "ch2"):
                c = ear_d[name]
                if c is None:
                    parts.append(f"{name}:—"); continue
                k = f"{c['kohm']:.0f}k" if c.get("kohm") is not None else "?"
                parts.append(f"{name}={k}/{c['state']}/{c['phase']}")
            return " ".join(parts)

        self.log(f"impedance L[{fmt(channels['left'])}] R[{fmt(channels['right'])}] allGood={all_good}")
