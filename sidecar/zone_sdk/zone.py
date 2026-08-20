"""
Zone SDK - Main interface
"""

import asyncio
import logging
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, List, Optional, Dict

from bleak import BleakClient

try:
    from .connection import DualBLEConnection, discover_devices
    from .models import RawEEGData, BrainwaveData, MetricsData
    from .processors import SignalProcessor, MetricsCalculator
    from .profile import PairProfile, load_profiles
    from .battery import BatteryQuery, BatteryReading
    from .impedance import (
        EarImpedanceProcessor,
        ImpedanceSnapshot,
        ChannelSnapshot,
    )
    from .errors import ZoneError, ZoneFeatureUnavailable
except ImportError:
    from connection import DualBLEConnection, discover_devices
    from models import RawEEGData, BrainwaveData, MetricsData
    from processors import SignalProcessor, MetricsCalculator
    from profile import PairProfile, load_profiles
    from battery import BatteryQuery, BatteryReading
    from impedance import (
        EarImpedanceProcessor,
        ImpedanceSnapshot,
        ChannelSnapshot,
    )
    from errors import ZoneError, ZoneFeatureUnavailable

logger = logging.getLogger(__name__)

# Brief settle after connect before keep-alive / streaming (deskApp habit).
_BLE_POST_DEV2_SETTLE_SEC = 3.0

# While streaming: each 1s window measures EEG rate; below
# _LOW_SAMPLE_RATE_THRESHOLD_HZ may trigger reconnect, but only after a stabilize
# grace (especially after arming impedance) and only if rates stop ramping up.
_LOW_SAMPLE_RATE_THRESHOLD_HZ = 200
_LOW_SAMPLE_RATE_RECONNECT_ROUNDS_MAX = 30
# No auto-reconnect for this long after start_impedance() (Windows/BLE link ramps slowly).
_SAMPLE_RATE_STABILIZE_GRACE_SEC = 12.0
# If only streaming (impedance not yet armed), shorter initial grace.
_SAMPLE_RATE_STREAM_ONLY_GRACE_SEC = 8.0
# Worst connected ear must rise by at least this much vs the previous 1s window
# to count as "still improving" (avoid reconnect while climbing toward threshold).
_SAMPLE_RATE_IMPROVE_MIN_DELTA_HZ = 1.0
# If below threshold and not improving for this long (after grace), reconnect.
_SAMPLE_RATE_STALL_BEFORE_RECONNECT_SEC = 18.0


class zone:
    def __init__(self, connection_type: str = "ble", buffer_size: int = 4096):
        self.connection_type = connection_type
        self._conn = DualBLEConnection(buffer_size=buffer_size)
        self._processor = SignalProcessor()
        self._metrics = MetricsCalculator()

        self._raw_data_callbacks: List[Callable[[RawEEGData], None]] = []
        self._brainwave_callbacks: List[Callable[[BrainwaveData], None]] = []
        self._metrics_callbacks: List[Callable[[MetricsData], None]] = []
        self._stats_callbacks: List[Callable[[dict], None]] = []
        self._connection_callbacks: List[Callable[[str], None]] = []

        self._stream_task: Optional[asyncio.Task] = None
        self._streaming = False
        self._stream_chunk = 50
        self._proc_window = 500   # 2s sliding window (500 samples at 250 Hz)
        self._proc_step = 250     # 50% overlap → slide 1s (250 samples)
        self._proc_buffers: Optional[List[deque]] = None
        self._idle_sleep = 0.01
        self._conn.set_stats_callback(self._emit_stats)
        self._conn.set_disconnect_callback(self._on_device_disconnected)
        # profiles file path (same folder as this file)
        self._profiles_path = Path(__file__).with_name("ble_profiles.json")
        # Active pair matched during connect_selected
        self._active_pair: Optional[PairProfile] = None
        # Impedance state (wired in Task 9)
        self._lead_armed: bool = False
        self._impedance_owns_stream: bool = False
        self._left_imp: Optional[EarImpedanceProcessor] = None
        self._right_imp: Optional[EarImpedanceProcessor] = None
        self._imp_task: Optional[asyncio.Task] = None
        self._impedance_callbacks: List[Callable[[ImpedanceSnapshot], None]] = []
        # Two-bud sample alignment for impedance (strict): while not aligned,
        # samples are dropped. When the second side delivers its first sample,
        # both processors reset and ingestion starts from that sample. The emit
        # loop drains a thread-safe queue so BLE notify callbacks only enqueue.
        self._imp_aligned: bool = False
        self._imp_left_seen: bool = False
        self._imp_right_seen: bool = False
        # Dev1 / dev2 BLE notify callbacks run on two different worker threads.
        # The tap only enqueues; the asyncio impedance loop drains and ingests
        # under _imp_lock so callbacks never block on Goertzel work.
        self._imp_lock = threading.Lock()
        self._imp_q_lock = threading.Lock()
        self._imp_pending: deque = deque(maxlen=200_000)
        # Remember the addresses we last connected (kept for diagnostics).
        self._last_left_address: Optional[str] = None
        self._last_right_address: Optional[str] = None
        # Background task that pings both BLE links with a harmless battery
        # query every ~700 ms starting at connect time. Without it, Windows
        # demotes the older of two concurrent links to a ~210 ms connection
        # interval a few seconds after it goes idle, capping that bud's
        # sample rate at ~50 Hz. The query is identical to what the
        # hardware-team reference GUI sends when the user clicks "Query".
        self._keepalive_task: Optional[asyncio.Task] = None
        # While True, keep-alive must not write battery RX — competes with
        # BatteryQuery.stop_notify/start_notify/write on the same links.
        self._battery_gatt_busy: bool = False
        # Last profile name used for a successful profile-validation connect (rescan reconnect).
        self._last_connect_profile: Optional[str] = None
        self._sample_rate_watch_task: Optional[asyncio.Task] = None
        # True while tearing down / reconnecting for sample-rate recovery (avoids nested watch).
        self._inside_sample_rate_recovery: bool = False
        self._ble_auto_recovery_task: Optional[asyncio.Task] = None
        # Sample-rate watch: allow BLE rates to ramp before reconnect; detect stall vs improving.
        self._rate_watch_grace_until: float = 0.0
        self._rate_watch_prev_worst: Optional[float] = None
        self._rate_watch_stall_since: Optional[float] = None

    def set_stream_chunk(self, n_samples: int):
        """Set raw streaming chunk size (affects raw callbacks and GUI smoothness)."""
        try:
            n_samples = int(n_samples)
        except Exception:
            return
        self._stream_chunk = max(10, n_samples)

    def set_stream_idle_sleep(self, seconds: float):
        """Set sleep duration when no data is available (lower = lower latency)."""
        try:
            seconds = float(seconds)
        except Exception:
            return
        self._idle_sleep = max(0.0, seconds)

    # ===================== CALLBACKS =====================

    def on_raw_data(self, callback: Callable[[RawEEGData], None]):
        self._raw_data_callbacks.append(callback)

    def on_brainwaves(self, callback: Callable[[BrainwaveData], None]):
        self._brainwave_callbacks.append(callback)

    def on_metrics(self, callback: Callable[[MetricsData], None]):
        self._metrics_callbacks.append(callback)

    def on_stats(self, callback: Callable[[dict], None]):
        self._stats_callbacks.append(callback)

    def on_connection_status(self, callback: Callable[[str], None]):
        self._connection_callbacks.append(callback)

    def on_impedance(self, callback: Callable[[ImpedanceSnapshot], None]):
        self._impedance_callbacks.append(callback)

    # ===================== LOOP HELPER =====================

    @staticmethod
    def _in_running_loop() -> bool:
        try:
            asyncio.get_running_loop()
            return True
        except RuntimeError:
            return False

    # ===================== DISCOVERY =====================

    @classmethod
    def discover(cls, duration: int = 5):
        if cls._in_running_loop():
            return discover_devices(duration=duration)
        return asyncio.run(discover_devices(duration=duration))

    # ===================== PROFILE / VALIDATION =====================

    def _load_profile(self, profile: str) -> Dict[str, PairProfile]:
        """Return {pair_name: PairProfile} for the named profile in ble_profiles.json."""
        profiles = load_profiles(self._profiles_path)
        if profile not in profiles:
            raise ValueError(f"Profile '{profile}' not found in ble_profiles.json")
        return profiles[profile]

    async def _match_pair_side(
        self,
        address: str,
        pairs: Dict[str, PairProfile],
        side: str,   # "left" or "right"
    ) -> Optional[tuple]:
        """Probe the device and return (pair_name, matched_triplet) for the first
        pair whose `{side}_eeg` triplet matches. Falls back to characteristic-only
        match under any service if exact service UUID doesn't match.
        """
        try:
            client = BleakClient(address)
            await client.connect(timeout=12.0)
            try:
                await client.get_services()
            except Exception:
                pass

            # Snapshot device state
            device_chars_by_service: Dict[str, set] = {}
            for service in client.services:
                svc_uuid = str(service.uuid).lower()
                device_chars_by_service[svc_uuid] = {
                    str(c.uuid).lower() for c in service.characteristics
                }

            # Pass 1: exact service + rx + tx match
            for pair_name, pair in pairs.items():
                expected = pair.left_eeg if side == "left" else pair.right_eeg
                if expected is None:
                    continue
                exp_service = expected["service"].lower()
                exp_rx      = expected["rx"].lower()
                exp_tx      = expected["tx"].lower()
                chars = device_chars_by_service.get(exp_service)
                if chars and exp_rx in chars and exp_tx in chars:
                    return (pair_name, dict(expected))

            # Pass 2: match rx+tx under any service (Windows BLE cache quirk)
            for pair_name, pair in pairs.items():
                expected = pair.left_eeg if side == "left" else pair.right_eeg
                if expected is None:
                    continue
                exp_rx = expected["rx"].lower()
                exp_tx = expected["tx"].lower()
                for svc_uuid, chars in device_chars_by_service.items():
                    if exp_rx in chars and exp_tx in chars:
                        return (pair_name, {"service": svc_uuid, "rx": exp_rx, "tx": exp_tx})

            return None
        except Exception as e:
            logger.error(f"validate {side} {address}: {e}")
            return None
        finally:
            try:
                if "client" in locals() and client.is_connected:
                    await client.disconnect()
            except Exception:
                pass

    # ===================== PUBLIC CONNECT - ENHANCED =====================

    async def connect_selected(
        self,
        left_address: Optional[str] = None,
        right_address: Optional[str] = None,
        profile: str = "zone_eeg",
        manual_uuids: Optional[Dict[str, Dict[str, str]]] = None,
        skip_validation: bool = False,
    ) -> bool:
        """Connect using profile validation. Both sides (if provided) must match the
        SAME PairProfile, otherwise the connection fails.

        Manual-UUID mode is preserved for backward compatibility: when `manual_uuids`
        is provided, _active_pair is NOT set (legacy path), and battery/impedance
        features will raise ZoneFeatureUnavailable.
        """
        if not left_address and not right_address:
            self._emit_connection_status("no_device_selected")
            return False

        # Legacy manual-UUIDs path — unchanged behavior
        if manual_uuids is not None:
            logger.info("Using MANUAL UUIDs (legacy path, no active pair)")
            left_uuids  = manual_uuids.get("left")  if left_address  else None
            right_uuids = manual_uuids.get("right") if right_address else None
            self._conn.set_device_profiles(dev1_profile=left_uuids, dev2_profile=right_uuids)
            self._active_pair = None
            ok = await self._finalize_connect(left_address, right_address, left_uuids, right_uuids)
            if ok:
                self._last_connect_profile = None
            return ok

        # Normal path: load pairs
        try:
            pairs = self._load_profile(profile)
        except Exception as e:
            logger.error(f"Failed to load profile '{profile}': {e}")
            self._emit_connection_status("profile_load_failed")
            return False

        if skip_validation:
            logger.error(
                "skip_validation=True is only valid with manual_uuids; "
                "refusing to connect via profile path without validation"
            )
            self._emit_connection_status("invalid_configuration")
            return False

        left_match = None
        right_match = None

        if left_address and not skip_validation:
            left_match = await self._match_pair_side(left_address, pairs, "left")
            if left_match is None:
                logger.error("Left device did not match any pair")
                self._emit_connection_status("left_validation_failed")
                return False

        if right_address and not skip_validation:
            right_match = await self._match_pair_side(right_address, pairs, "right")
            if right_match is None:
                logger.error("Right device did not match any pair")
                self._emit_connection_status("right_validation_failed")
                if not left_match:
                    return False

        # Both sides must belong to the same pair
        if left_match and right_match and left_match[0] != right_match[0]:
            logger.error(
                f"device mismatch: left matched '{left_match[0]}', "
                f"right matched '{right_match[0]}'"
            )
            self._emit_connection_status("pair_mismatch")
            return False

        active_pair_name = (left_match or right_match)[0]
        self._active_pair = pairs[active_pair_name]
        logger.info(f"Active pair: {active_pair_name}")

        left_uuids  = left_match[1]  if left_match  else None
        right_uuids = right_match[1] if right_match else None

        # Collect Battery + Touch TX UUIDs — subscribing to them during
        # connect matches the reference GUI and prevents Windows from
        # throttling one BLE link when both buds are connected.
        def _extra_tx(bat, tch):
            extras = []
            if bat and bat.get("tx"):
                extras.append(bat["tx"])
            if tch and tch.get("tx"):
                extras.append(tch["tx"])
            return extras

        dev1_extra = _extra_tx(self._active_pair.left_battery, self._active_pair.left_touch)
        dev2_extra = _extra_tx(self._active_pair.right_battery, self._active_pair.right_touch)

        self._conn.set_device_profiles(
            dev1_profile=left_uuids,
            dev2_profile=right_uuids,
            dev1_extra_tx=dev1_extra,
            dev2_extra_tx=dev2_extra,
        )
        ok = await self._finalize_connect(left_address, right_address, left_uuids, right_uuids)
        if ok:
            self._last_connect_profile = profile
        return ok

    async def _finalize_connect(
        self,
        left_address: Optional[str],
        right_address: Optional[str],
        left_uuids: Optional[Dict[str, str]],
        right_uuids: Optional[Dict[str, str]],
    ) -> bool:
        connected_any = False
        want_left = bool(left_address and left_uuids)
        want_right = bool(right_address and right_uuids)
        self._last_left_address = left_address if want_left else None
        self._last_right_address = right_address if want_right else None

        async def _connect_left() -> bool:
            try:
                return await self._conn.connect_device1(left_address)
            except Exception:
                logger.exception("left connect failed")
                return False

        async def _connect_right() -> bool:
            try:
                return await self._conn.connect_device2(right_address)
            except Exception:
                logger.exception("right connect failed")
                return False

        if want_left and want_right:
            # Match ML-DES-APP deskApp: ``useBleTransport`` fires left+right
            # ``connect`` in parallel (Promise.all). Each bud still uses its own
            # Bleak worker thread here (deskApp uses one asyncio loop + stdin queue).
            l_res, r_res = await asyncio.gather(
                _connect_left(),
                _connect_right(),
                return_exceptions=True,
            )
            if isinstance(l_res, Exception):
                logger.exception("left connect failed")
                self._emit_connection_status("left_connection_failed")
            elif l_res:
                self._emit_connection_status("left_connected")
                connected_any = True
            else:
                self._emit_connection_status("left_connection_failed")

            if isinstance(r_res, Exception):
                logger.exception("right connect failed")
                self._emit_connection_status("right_connection_failed")
            elif r_res:
                self._emit_connection_status("right_connected")
                connected_any = True
            else:
                self._emit_connection_status("right_connection_failed")
        elif want_left:
            if await _connect_left():
                self._emit_connection_status("left_connected")
                connected_any = True
            else:
                self._emit_connection_status("left_connection_failed")
        elif want_right:
            if await _connect_right():
                self._emit_connection_status("right_connected")
                connected_any = True
            else:
                self._emit_connection_status("right_connection_failed")

        if connected_any:
            await asyncio.sleep(_BLE_POST_DEV2_SETTLE_SEC)
            # Start the keep-alive as soon as both links are up so Windows
            # never gets a chance to demote one of them. Safe no-op if only
            # one bud is connected.
            if self._conn._dev1_connected and self._conn._dev2_connected:
                self._start_keepalive()

        if not connected_any:
            self._emit_connection_status("invalid_device")
        return connected_any

    def _start_keepalive(self) -> None:
        """Launch the keep-alive task if not already running."""
        if self._keepalive_task and not self._keepalive_task.done():
            return
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def _stop_keepalive(self) -> None:
        """Cancel and await the keep-alive task, if any."""
        task = self._keepalive_task
        self._keepalive_task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _keepalive_loop(self) -> None:
        """Ping both BLE links with a battery query every ``KEEPALIVE_PERIOD``
        seconds. Windows demotes the older of two concurrent links to a slow
        connection interval after it goes idle; regular bidirectional traffic
        stops that demotion. ``q`` is the same byte the hardware team's
        reference GUI sends when you click its Query button.

        IMPORTANT: while EEG is streaming (250 Hz notifications on both buds)
        the link is *already* active in both directions, so the keep-alive is
        redundant. Worse — issuing an RX write to the battery characteristic
        on top of a 250 Hz EEG TX flood causes the firmware to drop the BLE
        link within a few seconds (it cannot service two concurrent RX/TX
        pipelines under load). So we pause the keep-alive whenever streaming
        is active and resume it only when the buds are idle again.
        """
        KEEPALIVE_PERIOD = 0.35

        def _battery_rx(triplet):
            if not triplet:
                return None
            return triplet.get("rx")

        try:
            while True:
                await asyncio.sleep(KEEPALIVE_PERIOD)

                if not (self._conn._dev1_connected and self._conn._dev2_connected):
                    continue
                if self._conn._streaming:
                    continue
                if self._battery_gatt_busy:
                    continue
                pair = self._active_pair
                if not pair:
                    continue

                left_rx = _battery_rx(pair.left_battery)
                right_rx = _battery_rx(pair.right_battery)

                async def _ping(device_id: int, rx_uuid):
                    if not rx_uuid:
                        return
                    try:
                        await self._conn.run_on_device(
                            device_id,
                            self._conn._write_gatt_on_worker(device_id, rx_uuid, b"q"),
                        )
                    except Exception:
                        pass

                await asyncio.gather(
                    _ping(1, left_rx),
                    _ping(2, right_rx),
                )
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("keepalive loop crashed")

    # ===================== NEW: CONNECT WITH MANUAL UUIDs =====================

    async def connect_with_uuids(
        self,
        left_address: Optional[str] = None,
        right_address: Optional[str] = None,
        left_uuids: Optional[Dict[str, str]] = None,
        right_uuids: Optional[Dict[str, str]] = None,
    ) -> bool:
        """
        Simplified method to connect with manually provided UUIDs
        """
        manual_uuids = {}

        if left_address and left_uuids:
            manual_uuids["left"] = left_uuids

        if right_address and right_uuids:
            manual_uuids["right"] = right_uuids

        if not manual_uuids:
            logger.error("No manual UUIDs provided")
            return False

        # Fill missing side with dummy data
        if "left" not in manual_uuids and left_address:
            manual_uuids["left"] = {
                "service": "00000000-0000-0000-0000-000000000000",
                "rx": "00000000-0000-0000-0000-000000000000",
                "tx": "00000000-0000-0000-0000-000000000000",
            }

        if "right" not in manual_uuids and right_address:
            manual_uuids["right"] = {
                "service": "00000000-0000-0000-0000-000000000000",
                "rx": "00000000-0000-0000-0000-000000000000",
                "tx": "00000000-0000-0000-0000-000000000000",
            }

        return await self.connect_selected(
            left_address=left_address,
            right_address=right_address,
            manual_uuids=manual_uuids,
            skip_validation=True,
        )

    # ===================== LEGACY CONNECT =====================

    def connect(self, left_address: str, right_address: Optional[str] = None):
        if self._in_running_loop():
            return self._connect_async(left_address, right_address)
        return asyncio.run(self._connect_async(left_address, right_address))

    async def _connect_async(
        self, left_address: str, right_address: Optional[str] = None
    ) -> bool:
        left_ok = await self.connect_left(left_address)
        right_ok = False
        if right_address:
            right_ok = await self.connect_right(right_address)
        return left_ok or right_ok

    def connect_left(self, address: str):
        if self._in_running_loop():
            return self._connect_left_async(address)
        return asyncio.run(self._connect_left_async(address))

    async def _connect_left_async(self, address: str) -> bool:
        ok = await self._conn.connect_device1(address)
        if ok:
            self._emit_connection_status("left_connected")
        return ok

    def connect_right(self, address: str):
        if self._in_running_loop():
            return self._connect_right_async(address)
        return asyncio.run(self._connect_right_async(address))

    async def _connect_right_async(self, address: str) -> bool:
        ok = await self._conn.connect_device2(address)
        if ok:
            self._emit_connection_status("right_connected")
            await asyncio.sleep(_BLE_POST_DEV2_SETTLE_SEC)
        return ok

    def disconnect(self):
        if self._in_running_loop():
            return self._disconnect_async()
        return asyncio.run(self._disconnect_async())

    def reset_devices(self):
        if self._in_running_loop():
            return self._conn.send_reset()
        return asyncio.run(self._conn.send_reset())

    def set_default_mode(self):
        if self._in_running_loop():
            return self._conn.send_default()
        return asyncio.run(self._conn.send_default())

    def send_test_signal(self):
        if self._in_running_loop():
            return self._conn.send_test_signal()
        return asyncio.run(self._conn.send_test_signal())

    async def _disconnect_async(self):
        await self._cancel_ble_auto_recovery_task()
        if self._lead_armed:
            try:
                await self.stop_impedance()
            except Exception:
                logger.exception("stop_impedance during disconnect failed")
        await self._stop_keepalive()
        await self._stop_streaming_async()
        await self._conn.disconnect_device1()
        await self._conn.disconnect_device2()
        self._active_pair = None
        self._last_connect_profile = None
        self._emit_connection_status("disconnected")

    @staticmethod
    def _normalize_bt_addr(addr: Optional[str]) -> str:
        if not addr:
            return ""
        return addr.upper().replace("-", ":")

    def _pick_address_from_scan(
        self,
        scan_entries: List[Dict[str, Any]],
        expected_mac: Optional[str],
        name_side: str,
    ) -> Optional[str]:
        """Resolve a bud after reboot: prefer MAC match, else Zone EEG Left/Right name."""
        exp = self._normalize_bt_addr(expected_mac)
        if exp:
            for e in scan_entries:
                if self._normalize_bt_addr(e.get("address")) == exp:
                    return str(e["address"])
        name_side = name_side.lower()
        for e in scan_entries:
            name = (e.get("name") or "").lower()
            if "zone" not in name:
                continue
            if name_side == "left" and "left" in name:
                return str(e["address"])
            if name_side == "right" and "right" in name:
                return str(e["address"])
        return None

    @staticmethod
    def _channel_hint_suggests_ble_reconnect(ch: Optional[ChannelSnapshot]) -> bool:
        if ch is None:
            return False
        h = (ch.hint or "").lower()
        if not h:
            return False
        if "reconnect" in h:
            return True
        if "too low" in h and "ble" in h:
            return True
        if "ble rate" in h:
            return True
        return False

    def _impedance_snapshot_needs_ble_recovery(
        self, snap: ImpedanceSnapshot
    ) -> bool:
        """True when impedance math flags a slow/untrustworthy BLE ear (see impedance.py)."""
        for ear in (snap.left, snap.right):
            if ear is None:
                continue
            if self._channel_hint_suggests_ble_reconnect(
                ear.ch1
            ) or self._channel_hint_suggests_ble_reconnect(ear.ch2):
                return True
        return False

    def _impedance_ble_trouble_blurb(self, snap: ImpedanceSnapshot) -> str:
        parts = []
        for label, ear in (("L", snap.left), ("R", snap.right)):
            if ear is None:
                continue
            for ci, ch in enumerate((ear.ch1, ear.ch2), start=1):
                if ch and ch.hint and self._channel_hint_suggests_ble_reconnect(ch):
                    parts.append(f"{label}{ci}: {ch.hint}")
        return "; ".join(parts) if parts else "impedance BLE hint"

    async def _cancel_ble_auto_recovery_task(self) -> None:
        task = self._ble_auto_recovery_task
        self._ble_auto_recovery_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    def _schedule_ble_recovery_from_impedance(self, snap: ImpedanceSnapshot) -> None:
        """Fire-and-forget soft reconnect when impedance detects a slow BLE ear."""
        if not self._active_pair:
            return
        if self._inside_sample_rate_recovery:
            return
        if self._ble_auto_recovery_task is not None and not self._ble_auto_recovery_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        st = self._conn.get_stats()
        r1 = float(st["dev1"]["rate"])
        r2 = float(st["dev2"]["rate"])
        blur = self._impedance_ble_trouble_blurb(snap)

        async def _runner() -> None:
            try:
                logger.warning(
                    "Impedance flagged bad/slow ear — soft reconnect until healthy (%s); "
                    "instantaneous rates dev1=%.0f/s dev2=%.0f/s",
                    blur,
                    r1,
                    r2,
                )
                await self._recover_from_low_sample_rate(r1, r2)
            finally:
                self._ble_auto_recovery_task = None

        self._ble_auto_recovery_task = loop.create_task(_runner())

    async def _reconnect_same_pair_by_scan(
        self,
        scan_duration: int = 8,
        post_disconnect_sleep: float = 2.0,
        scan_rounds: int = 8,
        round_gap: float = 2.0,
    ) -> bool:
        """Disconnect both buds, scan, and ``connect_selected`` using stored pair hints."""
        if not self._active_pair:
            logger.error("reconnect by scan: no active pair")
            return False
        prof = self._last_connect_profile or "zone_eeg"
        meta = self._active_pair.metadata or {}
        left_mac_meta = meta.get("Left_MAC_Address") or self._last_left_address
        right_mac_meta = meta.get("Right_MAC_Address") or self._last_right_address
        want_left = bool(
            self._last_left_address and self._active_pair.left_eeg is not None
        )
        want_right = bool(
            self._last_right_address and self._active_pair.right_eeg is not None
        )
        if not want_left and not want_right:
            logger.error("reconnect by scan: no remembered addresses")
            return False

        await self._stop_keepalive()
        await self._conn.disconnect_device1()
        await self._conn.disconnect_device2()
        await asyncio.sleep(post_disconnect_sleep)

        left_adr: Optional[str] = None
        right_adr: Optional[str] = None
        for attempt in range(scan_rounds):
            found = await discover_devices(duration=scan_duration)
            if want_left:
                left_adr = self._pick_address_from_scan(
                    found, left_mac_meta, "left"
                )
            if want_right:
                right_adr = self._pick_address_from_scan(
                    found, right_mac_meta, "right"
                )
            have_l = not want_left or left_adr is not None
            have_r = not want_right or right_adr is not None
            if have_l and have_r:
                logger.info(
                    "reconnect by scan: found buds (attempt %s/%s)",
                    attempt + 1,
                    scan_rounds,
                )
                break
            logger.info(
                "reconnect by scan: rescan in %.1fs (left=%s right=%s)",
                round_gap,
                left_adr,
                right_adr,
            )
            await asyncio.sleep(round_gap)
        else:
            self._emit_connection_status("sample_rate_rescan_failed")
            return False

        self._emit_connection_status("sample_rate_reconnecting")
        return await self.connect_selected(
            left_address=left_adr,
            right_address=right_adr,
            profile=prof,
            manual_uuids=None,
            skip_validation=False,
        )

    async def _recover_from_low_sample_rate(self, r1: float, r2: float) -> bool:
        """Soft disconnect + rescan reconnect until both buds exceed the rate threshold."""
        if not self._active_pair:
            logger.error(
                "EEG sample rate low but no active pair — cannot auto-reconnect by scan"
            )
            return False

        logger.warning(
            "EEG sample rate low (dev1=%.0f/s, dev2=%.0f/s) — soft reconnect until "
            "both >= %s samp/s (max %s rounds)",
            r1,
            r2,
            _LOW_SAMPLE_RATE_THRESHOLD_HZ,
            _LOW_SAMPLE_RATE_RECONNECT_ROUNDS_MAX,
        )
        self._emit_connection_status("low_sample_rate_recovery")

        had_stream = self._streaming
        had_imp = self._lead_armed
        imp_owned = self._impedance_owns_stream

        self._inside_sample_rate_recovery = True
        try:
            for round_idx in range(_LOW_SAMPLE_RATE_RECONNECT_ROUNDS_MAX):
                logger.info(
                    "sample rate recovery round %s/%s",
                    round_idx + 1,
                    _LOW_SAMPLE_RATE_RECONNECT_ROUNDS_MAX,
                )
                try:
                    if self._lead_armed:
                        await self.stop_impedance()
                    if self._streaming:
                        await self._stop_streaming_async(
                            stop_sample_rate_watch=False
                        )
                    elif self._conn._streaming:
                        await self._conn.stop_streaming()

                    ok = await self._reconnect_same_pair_by_scan(
                        post_disconnect_sleep=1.0,
                    )
                    if not ok:
                        self._emit_connection_status(
                            "low_sample_rate_recovery_failed"
                        )
                        return False

                    if had_imp and not imp_owned:
                        await self._start_streaming_async()
                    if had_imp:
                        await self.start_impedance()
                    elif had_stream:
                        await self._start_streaming_async()
                except Exception:
                    logger.exception("sample rate recovery round failed")
                    self._emit_connection_status("low_sample_rate_recovery_failed")
                    return False

                # Extra settle after reconnect + stream/impedance so Windows/BLE can ramp.
                await asyncio.sleep(4.0)
                await asyncio.sleep(1.0)
                self._conn.refresh_link_state()
                n1a = self._conn._dev1_received
                n2a = self._conn._dev2_received
                await asyncio.sleep(1.0)
                self._conn.refresh_link_state()
                n1b = self._conn._dev1_received
                n2b = self._conn._dev2_received
                need1 = self._conn._dev1_connected
                need2 = self._conn._dev2_connected
                vr1 = (n1b - n1a) / 1.0
                vr2 = (n2b - n2a) / 1.0
                good = (not need1 or vr1 >= _LOW_SAMPLE_RATE_THRESHOLD_HZ) and (
                    not need2 or vr2 >= _LOW_SAMPLE_RATE_THRESHOLD_HZ
                )
                if good and had_imp and self._lead_armed:
                    await asyncio.sleep(3.0)
                    self._imp_flush_pending()
                    now_msv = time.monotonic() * 1000.0
                    with self._imp_lock:
                        li_v, ri_v = self._left_imp, self._right_imp
                        if li_v is not None or ri_v is not None:
                            snap_v = ImpedanceSnapshot(
                                left=li_v.snapshot(True, now_msv) if li_v else None,
                                right=ri_v.snapshot(True, now_msv) if ri_v else None,
                            )
                        else:
                            snap_v = None
                    if snap_v is not None and self._impedance_snapshot_needs_ble_recovery(
                        snap_v
                    ):
                        logger.warning(
                            "sample rates OK but impedance still reports slow/BLE ear — "
                            "retry round"
                        )
                        good = False
                if good:
                    logger.info(
                        "sample rate recovery OK (round %s): dev1=%.0f/s dev2=%.0f/s",
                        round_idx + 1,
                        vr1,
                        vr2,
                    )
                    self._emit_connection_status("sample_rate_recovery_ok")
                    return True
                logger.warning(
                    "after soft reconnect round %s: dev1=%.0f/s dev2=%.0f/s "
                    "(want >= %s on each connected side)",
                    round_idx + 1,
                    vr1,
                    vr2,
                    _LOW_SAMPLE_RATE_THRESHOLD_HZ,
                )

            logger.error(
                "sample rate recovery gave up after %s rounds",
                _LOW_SAMPLE_RATE_RECONNECT_ROUNDS_MAX,
            )
            self._emit_connection_status("low_sample_rate_recovery_failed")
            return False
        finally:
            self._inside_sample_rate_recovery = False

    async def _stop_sample_rate_watch(self) -> None:
        task = self._sample_rate_watch_task
        self._sample_rate_watch_task = None
        self._rate_watch_prev_worst = None
        self._rate_watch_stall_since = None
        if task and not task.done():
            task.cancel()
            # Avoid awaiting our own task (would deadlock / self-cancel).
            if task is not asyncio.current_task():
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    async def _start_sample_rate_watch(self) -> None:
        await self._stop_sample_rate_watch()
        now = time.monotonic()
        if self._lead_armed:
            self._rate_watch_grace_until = now + _SAMPLE_RATE_STABILIZE_GRACE_SEC
        else:
            self._rate_watch_grace_until = now + _SAMPLE_RATE_STREAM_ONLY_GRACE_SEC
        self._rate_watch_prev_worst = None
        self._rate_watch_stall_since = None
        self._sample_rate_watch_task = asyncio.create_task(
            self._sample_rate_watch_loop()
        )

    async def _sample_rate_watch_loop(self) -> None:
        try:
            while self._streaming and self._conn._streaming:
                self._conn.refresh_link_state()
                await asyncio.sleep(1.0)
                if not (self._streaming and self._conn._streaming):
                    break
                while self._streaming and self._conn._streaming:
                    self._conn.refresh_link_state()
                    n1a = self._conn._dev1_received
                    n2a = self._conn._dev2_received
                    await asyncio.sleep(1.0)
                    if not (self._streaming and self._conn._streaming):
                        break
                    n1b = self._conn._dev1_received
                    n2b = self._conn._dev2_received
                    r1 = (n1b - n1a) / 1.0
                    r2 = (n2b - n2a) / 1.0
                    need1 = self._conn._dev1_connected
                    need2 = self._conn._dev2_connected
                    bad = (need1 and r1 < _LOW_SAMPLE_RATE_THRESHOLD_HZ) or (
                        need2 and r2 < _LOW_SAMPLE_RATE_THRESHOLD_HZ
                    )
                    if not bad:
                        self._rate_watch_prev_worst = None
                        self._rate_watch_stall_since = None
                        continue
                    now_m = time.monotonic()
                    if now_m < self._rate_watch_grace_until:
                        continue
                    if not self._active_pair:
                        logger.warning(
                            "sample rate low (dev1=%.0f/s, dev2=%.0f/s) "
                            "— connect with profile validation to enable auto-reconnect",
                            r1,
                            r2,
                        )
                        continue
                    worst = min(
                        r1 if need1 else float("inf"),
                        r2 if need2 else float("inf"),
                    )
                    if self._rate_watch_prev_worst is None:
                        self._rate_watch_prev_worst = worst
                        continue

                    prev_w = self._rate_watch_prev_worst
                    improving = (
                        worst
                        >= prev_w + _SAMPLE_RATE_IMPROVE_MIN_DELTA_HZ
                    )
                    if improving:
                        self._rate_watch_stall_since = None
                        self._rate_watch_prev_worst = worst
                        continue

                    if self._rate_watch_stall_since is None:
                        self._rate_watch_stall_since = now_m
                    stall_age = now_m - self._rate_watch_stall_since
                    if stall_age < _SAMPLE_RATE_STALL_BEFORE_RECONNECT_SEC:
                        self._rate_watch_prev_worst = worst
                        continue

                    logger.warning(
                        "sample rate stalled below %s samp/s for %.0fs "
                        "(dev1=%.0f/s dev2=%.0f/s) — starting reconnect",
                        _LOW_SAMPLE_RATE_THRESHOLD_HZ,
                        stall_age,
                        r1,
                        r2,
                    )
                    self._rate_watch_prev_worst = worst
                    self._rate_watch_stall_since = None

                    ok = await self._recover_from_low_sample_rate(r1, r2)
                    if not ok:
                        return
                    self._rate_watch_prev_worst = None
                    self._rate_watch_stall_since = None
                    break
        except asyncio.CancelledError:
            raise

    # ===================== STREAMING =====================

    def start_streaming(self):
        if self._in_running_loop():
            return self._start_streaming_async()
        return asyncio.run(self._start_streaming_async())

    async def _start_streaming_async(self) -> bool:
        ok = await self._conn.start_streaming()
        if not ok:
            return False

        self._streaming = True
        if self._stream_task is None or self._stream_task.done():
            self._stream_task = asyncio.create_task(self._stream_loop())
        if not self._inside_sample_rate_recovery:
            await self._start_sample_rate_watch()
        return True

    def stop_streaming(self):
        if self._in_running_loop():
            return self._stop_streaming_async()
        return asyncio.run(self._stop_streaming_async())

    async def _stop_streaming_async(
        self, stop_sample_rate_watch: bool = True
    ) -> bool:
        if stop_sample_rate_watch:
            await self._stop_sample_rate_watch()
        # If impedance is armed and owns the stream, unwind via stop_impedance
        # (which will call us back with _impedance_owns_stream already False)
        if self._lead_armed and self._impedance_owns_stream:
            await self.stop_impedance()
            return True
        # If impedance is armed but user started the stream manually, disarm first
        if self._lead_armed and not self._impedance_owns_stream:
            await self.stop_impedance()

        self._streaming = False
        if self._stream_task and not self._stream_task.done():
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
        self._stream_task = None
        return await self._conn.stop_streaming()

    async def _stream_loop(self):
        while self._streaming:
            data = self._conn.read_data(
                n_samples=self._stream_chunk, allow_partial=True, pad_value=0.0
            )
            if data:
                raw = RawEEGData(
                    timestamp=datetime.now(),
                    channels=data["channels"],
                    sample_rate=data["sample_rate"],
                )
                self._emit_raw(raw)

                n_channels = len(data["channels"])
                if self._proc_buffers is None or len(self._proc_buffers) != n_channels:
                    self._proc_buffers = [deque() for _ in range(n_channels)]

                # All channels have equal length (synced by sample_num)
                for ch_idx, ch_data in enumerate(data["channels"]):
                    self._proc_buffers[ch_idx].extend(ch_data)

                while (
                    self._proc_buffers
                    and len(self._proc_buffers[0]) >= self._proc_window
                ):
                    if not self._lead_armed:
                        # Peek full window (500 samples) without removing
                        proc_channels = []
                        for ch_buf in self._proc_buffers:
                            proc_channels.append(
                                [ch_buf[i] for i in range(self._proc_window)]
                            )

                        proc_raw = RawEEGData(
                            timestamp=datetime.now(),
                            channels=proc_channels,
                            sample_rate=data["sample_rate"],
                        )

                        # Run heavy processing in thread to not block BLE notifications
                        loop = asyncio.get_event_loop()
                        brainwaves = await loop.run_in_executor(
                            None, self._processor.process_streaming, proc_raw
                        )
                        self._emit_brainwaves(brainwaves)

                        metrics = await loop.run_in_executor(
                            None, self._metrics.calculate_metrics, brainwaves
                        )
                        self._emit_metrics(metrics)

                    # Slide: remove only step_size (250), keep 250 for overlap
                    for ch_buf in self._proc_buffers:
                        for _ in range(self._proc_step):
                            ch_buf.popleft()

            else:
                await asyncio.sleep(self._idle_sleep)
                continue

            # Yield to event loop so BLE notifications can deliver new data
            await asyncio.sleep(0)

    # ===================== STATUS =====================

    def get_connection_stats(self):
        return self._conn.get_stats()

    def is_connected(self) -> bool:
        return self._conn.is_connected()

    def is_fully_connected(self) -> bool:
        return self._conn.is_fully_connected()

    def get_buds_status(self) -> dict:
        """Synchronous snapshot of connection state + active pair metadata."""
        self._conn.refresh_link_state()
        pair = self._active_pair
        return {
            "left_connected":  self._conn._dev1_connected,
            "right_connected": self._conn._dev2_connected,
            "streaming":       self._streaming,
            "impedance_armed": self._lead_armed,
            "pair": None if pair is None else {
                "name":                  pair.name,
                "serial_number":         pair.metadata.get("Serial_Number"),
                "left_mac":              pair.metadata.get("Left_MAC_Address"),
                "right_mac":             pair.metadata.get("Right_MAC_Address"),
                "left_firmware_upload":  pair.metadata.get("Left_Firmware_Upload"),
                "right_firmware_upload": pair.metadata.get("Right_Firmware_Upload"),
                "left_deployment":       pair.metadata.get("Left_Deployment_Status"),
                "right_deployment":      pair.metadata.get("Right_Deployment_Status"),
                "qc_passed":             pair.metadata.get("QC_Passed"),
                "data_test_done":        pair.metadata.get("Data_Test_Done"),
                "charge_case_complete":  pair.metadata.get("Charge_Case_Complete"),
                "has_battery":           pair.has_battery,
                "has_touch":             pair.has_touch,
            },
        }

    async def get_battery(self) -> Dict[str, Optional[BatteryReading]]:
        """One-shot battery read from both ears.

        Raises ZoneFeatureUnavailable if no active pair or battery UUIDs are missing.
        """
        if not self._active_pair:
            raise ZoneFeatureUnavailable("no active pair (connect with a profile first)")
        if not self._active_pair.has_battery:
            raise ZoneFeatureUnavailable(
                f"battery UUIDs not configured for pair '{self._active_pair.name}'"
            )

        # Battery RX writes during a 250 Hz EEG notify flood are known to
        # destabilise firmware / the right link (see ``_keepalive_loop``).
        # Pause CMD_START streaming for the GATT window, then resume — same
        # as avoiding keep-alive ``q`` pings while streaming.
        self._battery_gatt_busy = True
        paused_ble = self._conn._streaming
        out: Dict[str, Optional[BatteryReading]] = {}
        try:
            if paused_ble:
                await self._conn.stop_streaming()
                await asyncio.sleep(0.2)

            q = BatteryQuery()

            # Serialise L/R reads — avoids overlapping notify handshakes on
            # Windows when both buds are connected.
            if self._conn._dev1_connected and self._active_pair.left_battery:
                t = self._active_pair.left_battery
                out["left"] = await self._conn.run_on_device(
                    1, q.read_one(self._conn._client1, t["rx"], t["tx"], "left")
                )
                if self._conn._dev2_connected and self._active_pair.right_battery:
                    await asyncio.sleep(0.12)

            if self._conn._dev2_connected and self._active_pair.right_battery:
                t = self._active_pair.right_battery
                out["right"] = await self._conn.run_on_device(
                    2, q.read_one(self._conn._client2, t["rx"], t["tx"], "right")
                )

        finally:
            if paused_ble:
                ok_resume = await self._conn.start_streaming()
                # Extra settle after CMD_START on both buds — Windows often
                # re-assigns asymmetric connection intervals after stop/start
                # (see get_battery during impedance: one link ~73/s, other ~322/s).
                await asyncio.sleep(0.4)
                if not ok_resume:
                    logger.error("failed to restart streaming after battery read")
                elif self._lead_armed:
                    with self._imp_lock:
                        self._imp_aligned = False
                        self._imp_left_seen = False
                        self._imp_right_seen = False
                        if self._left_imp is not None:
                            self._left_imp.reset()
                        if self._right_imp is not None:
                            self._right_imp.reset()
                    with self._imp_q_lock:
                        self._imp_pending.clear()
                    try:
                        await self._conn.write_eeg_rx_text("both", "lead")
                    except Exception:
                        logger.exception("re-arm lead after battery read failed")
            self._battery_gatt_busy = False

        return out

    # ===================== IMPEDANCE =====================

    async def start_impedance(self):
        """Arm lead-off injection and start emitting impedance snapshots."""
        if not self._active_pair or not self._active_pair.has_eeg:
            raise ZoneFeatureUnavailable("no EEG profile configured (connect first)")
        if not (self._conn._dev1_connected or self._conn._dev2_connected):
            raise ZoneFeatureUnavailable("no device currently connected")
        if self._lead_armed:
            return  # idempotent

        with self._imp_q_lock:
            self._imp_pending.clear()

        self._impedance_owns_stream = not self._streaming
        if self._impedance_owns_stream:
            ok = await self._start_streaming_async()
            if not ok:
                self._impedance_owns_stream = False
                raise ZoneError("failed to start streaming for impedance")

        with self._imp_lock:
            self._left_imp = EarImpedanceProcessor(side="L")
            self._right_imp = EarImpedanceProcessor(side="R")
            # Strict two-bud alignment: until each ear has delivered ≥1 sample,
            # samples are dropped; then both processors reset and ingestion starts.
            self._imp_aligned = False
            self._imp_left_seen = False
            self._imp_right_seen = False

        # Install the tap up-front. _on_impedance_sample is gated on
        # self._lead_armed so pre-arm samples are dropped — same model as
        # the desktop app's subscribe callback (`if (!armed) return;`).
        self._conn.set_impedance_tap(self._on_impedance_sample)

        try:
            # Arm ADS1299 lead-off injection on both ears in parallel —
            # matches the desktop app's writeEegRx({ side: "both", text:
            # "lead" }) (see docs/IMPEDANCE_CHECK.md step 2). The parallel
            # dispatch keeps the lead-off start time on left and right
            # within a few ms of each other.
            ok_lead = await self._conn.write_eeg_rx_text("both", "lead")
            if not ok_lead:
                raise ZoneError("failed to arm lead-off")
        except Exception:
            # Roll back partial setup so the tap doesn't leak
            self._conn.set_impedance_tap(None)
            with self._imp_q_lock:
                self._imp_pending.clear()
            with self._imp_lock:
                self._left_imp = None
                self._right_imp = None
                self._imp_aligned = False
                self._imp_left_seen = False
                self._imp_right_seen = False
            if self._impedance_owns_stream:
                self._impedance_owns_stream = False
                await self._stop_streaming_async()
            raise

        self._lead_armed = True
        self._imp_task = asyncio.create_task(self._impedance_emit_loop())
        # Allow BLE throughput to ramp after lead arm before sample-rate watchdogs act.
        _now = time.monotonic()
        self._rate_watch_grace_until = max(
            self._rate_watch_grace_until,
            _now + _SAMPLE_RATE_STABILIZE_GRACE_SEC,
        )
        self._rate_watch_prev_worst = None
        self._rate_watch_stall_since = None

        if self._conn.is_fully_connected():
            st = self._conn.get_stats()
            if st["elapsed"] >= 1.0:
                r1 = st["dev1"]["rate"]
                r2 = st["dev2"]["rate"]
                if r1 < 120.0 or r2 < 120.0:
                    logger.warning(
                        "BLE notification rate is low (dev1=%.0f/s, dev2=%.0f/s); "
                        "one Windows dual-link may be ~50 Hz — impedance uses approximate "
                        "mode below ideal Nyquist (see impedance hints).",
                        r1,
                        r2,
                    )

    def _on_impedance_sample(self, device_id: int, ch1_raw: float, ch2_raw: float, abs_idx: int = None):
        # Drop pre-arm samples — same gating as the desktop app's
        # subscribe callback (`if (!armed) return;` in
        # EegSessionImpedanceContext.tsx). Without this, samples that
        # arrive between tap-install and `lead` taking effect would
        # enter the 256-sample Goertzel buffer and bias the first
        # readings (one side often appearing low while the other is
        # already correct).
        if not self._lead_armed:
            return

        t_mono = time.monotonic()
        with self._imp_q_lock:
            self._imp_pending.append((device_id, ch1_raw, ch2_raw, t_mono, abs_idx))

    def _imp_flush_pending(self):
        """Drain impedance queue on the asyncio thread; ingest under _imp_lock."""
        batch = []
        with self._imp_q_lock:
            while self._imp_pending:
                batch.append(self._imp_pending.popleft())
        if not batch:
            return
        with self._imp_lock:
            for device_id, ch1_raw, ch2_raw, t_mono, abs_idx in batch:
                left_imp = self._left_imp
                right_imp = self._right_imp
                if left_imp is None and right_imp is None:
                    break
                if not self._imp_aligned:
                    if device_id == 1:
                        self._imp_left_seen = True
                    elif device_id == 2:
                        self._imp_right_seen = True
                    if self._imp_left_seen and self._imp_right_seen:
                        self._imp_aligned = True
                        if left_imp is not None:
                            left_imp.reset()
                        if right_imp is not None:
                            right_imp.reset()
                        if device_id == 1 and left_imp is not None:
                            left_imp.ingest(ch1_raw, ch2_raw, t_mono, abs_idx)
                        elif device_id == 2 and right_imp is not None:
                            right_imp.ingest(ch1_raw, ch2_raw, t_mono, abs_idx)
                else:
                    if device_id == 1 and left_imp is not None:
                        left_imp.ingest(ch1_raw, ch2_raw, t_mono, abs_idx)
                    elif device_id == 2 and right_imp is not None:
                        right_imp.ingest(ch1_raw, ch2_raw, t_mono, abs_idx)

    async def _impedance_emit_loop(self):
        # Emit impedance snapshots on a fixed cadence. BLE samples are queued
        # from worker threads and drained here so ingest never blocks notify.
        # When inferred Fs is below IMPEDANCE_MIN_FS_HZ (strict mode), impedance.py
        # returns measuring + hint.
        try:
            while self._lead_armed:
                self._imp_flush_pending()
                now_ms = time.monotonic() * 1000.0

                # Suppress all impedance output until both buds have
                # delivered their first sample. The user explicitly does
                # not want to see "measuring" placeholders for a side
                # that hasn't started streaming yet.
                if self._imp_aligned:
                    with self._imp_lock:
                        li, ri = self._left_imp, self._right_imp
                        snap = ImpedanceSnapshot(
                            left=li.snapshot(True, now_ms) if li else None,
                            right=ri.snapshot(True, now_ms) if ri else None,
                        )
                    for cb in list(self._impedance_callbacks):
                        try:
                            cb(snap)
                        except Exception:
                            logger.exception("impedance callback error")
                    if self._impedance_snapshot_needs_ble_recovery(snap):
                        self._schedule_ble_recovery_from_impedance(snap)
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            pass

    async def stop_impedance(self):
        if not self._lead_armed:
            return  # idempotent
        self._lead_armed = False
        self._conn.set_impedance_tap(None)

        # Disarm lead-off injection — matches the desktop app's
        # writeEegRx({ side: "both", text: "lead0" })
        # (see docs/IMPEDANCE_CHECK.md step 14).
        try:
            await self._conn.write_eeg_rx_text("both", "lead0")
        except Exception:
            logger.exception("failed to send lead0")

        if self._imp_task and not self._imp_task.done():
            self._imp_task.cancel()
            try:
                await self._imp_task
            except asyncio.CancelledError:
                pass
        self._imp_task = None
        with self._imp_q_lock:
            self._imp_pending.clear()
        with self._imp_lock:
            self._left_imp = None
            self._right_imp = None
            self._imp_aligned = False
            self._imp_left_seen = False
            self._imp_right_seen = False

        if self._impedance_owns_stream:
            await self._stop_streaming_async()
            self._impedance_owns_stream = False

    # ===================== DISCONNECT HANDLER =====================

    def _on_device_disconnected(self, side: str):
        """Called by BLE layer when a device unexpectedly disconnects."""
        logger.warning("Unexpected %s earbud disconnect", side)
        self._emit_connection_status(f"{side}_disconnected")

    # ===================== EMITTERS =====================

    def _emit_raw(self, data: RawEEGData):
        for cb in list(self._raw_data_callbacks):
            try:
                cb(data)
            except Exception as exc:
                logger.exception("Raw data callback error: %s", exc)

    def _emit_brainwaves(self, data: BrainwaveData):
        for cb in list(self._brainwave_callbacks):
            try:
                cb(data)
            except Exception as exc:
                logger.exception("Brainwave callback error: %s", exc)

    def _emit_metrics(self, data: MetricsData):
        for cb in list(self._metrics_callbacks):
            try:
                cb(data)
            except Exception as exc:
                logger.exception("Metrics callback error: %s", exc)

    def _emit_stats(self, stats: dict):
        for cb in list(self._stats_callbacks):
            try:
                cb(stats)
            except Exception as exc:
                logger.exception("Stats callback error: %s", exc)

    def _emit_connection_status(self, status: str):
        for cb in list(self._connection_callbacks):
            try:
                cb(status)
            except Exception as exc:
                logger.exception("Connection callback error: %s", exc)

    # ===================== CONTEXT MANAGER =====================

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._in_running_loop():
            asyncio.create_task(self._disconnect_async())
        else:
            asyncio.run(self._disconnect_async())
        return False


__all__ = ["zone", "RawEEGData", "BrainwaveData", "MetricsData", "discover_devices"]
