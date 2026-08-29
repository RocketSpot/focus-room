"""The room searches for earbuds by itself, and does it politely.

Auto-connect exists so a session can start with nobody at the operator console:
open the buds near the Mac and they connect on their own. The risk in a feature
like this is never the happy path, it is the loop turning into a second actor
that fights the mechanisms that already own the link, or quietly dying. The
first version had exactly those bugs, found by adversarial review: the gate
read a stats-time cache that froze whenever samples stopped (so the watcher
worked once per launch, then locked out for the day), the gate verdict was
stale by the full scan length, a mid-session takeover restored the link but
never the stream, and an operator Disconnect was undone within seconds. Every
scenario below drives the REAL loop and the REAL gate against a fake SDK whose
get_buds_status() is the same live truth production reads — no test-forged
state flags anywhere.

Run:  venv/bin/python tests/eeg-autoconnect.test.py
"""
import asyncio
import pathlib
import sys
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "sidecar"))

import zone_source  # noqa: E402
from zone_source import auto_connect_should_try  # noqa: E402

SRC = (pathlib.Path(__file__).resolve().parent.parent / "sidecar" / "zone_source.py").read_text()

passed = 0
fails = []


def ok(name, fn):
    global passed
    try:
        fn()
        passed += 1
        print("  ok   " + name)
    except AssertionError as e:
        fails.append(name)
        print(" FAIL  " + name + "\n       " + str(e))


CLEAR = {
    "enabled": True, "left_up": False, "right_up": False,
    "connect_in_flight": False, "reconnecting": False, "rotating": False,
    "sdk_recovery": False, "lead_armed": False, "in_cooldown": False,
    "standdown": False,
}


# ---------------- the pure gate ----------------

def t_gate_clear_field_goes():
    go, why = auto_connect_should_try(dict(CLEAR))
    assert go, "with nothing owning the link the loop must be allowed to scan: " + why


def t_gate_every_owner_outranks_it():
    for field in ("connect_in_flight", "reconnecting", "rotating",
                  "sdk_recovery", "lead_armed", "in_cooldown", "standdown"):
        st = dict(CLEAR)
        st[field] = True
        go, why = auto_connect_should_try(st)
        assert not go, field + " must outrank the auto loop"
        assert why != "clear", "the refusal must carry its reason"


def t_gate_any_connected_bud_stops_it():
    for field in ("left_up", "right_up"):
        st = dict(CLEAR)
        st[field] = True
        go, why = auto_connect_should_try(st)
        assert not go, "one connected bud means the link is live, hands off"
        assert why == "connected", why


def t_gate_kill_switch():
    st = dict(CLEAR)
    st["enabled"] = False
    go, why = auto_connect_should_try(st)
    assert not go and why == "disabled", "FOCUSROOM_AUTOCONNECT=0 must fully disable it"


# ---------------- source-pinned wiring ----------------

def _loop_src():
    return SRC.split("async def _auto_connect_loop")[1].split("def _auto_backoff")[0]


def t_scan_is_quiet():
    scan = SRC.split("async def _auto_scan")[1].split("async def _auto_connect_loop")[0]
    assert "self.Zone.discover(" in scan, "the scan must go through the SDK"
    assert "await self.discover(" not in scan and "await self.discover(" not in _loop_src(), \
        "the loop must never CALL the broadcasting discover()"
    assert "OUT.DISCOVERED" not in scan and "OUT.ERROR" not in _loop_src(), \
        "an empty pass must emit nothing to the console"


def t_gate_reads_live_sdk_truth():
    gate = SRC.split("def _auto_gate(self):")[1].split("async def _auto_scan")[0]
    assert "get_buds_status()" in gate, \
        "the gate must read the SDK's live status, not the stats-time _left_up cache"


def t_gate_rechecked_after_scan_before_handover():
    loop = _loop_src()
    before_connect = loop.split("await self.connect(auto=True)")[0]
    assert before_connect.count("self._auto_gate()") >= 2, \
        "the gate must be re-evaluated after the scan, before the handover"


def t_session_active_hands_to_the_ladder():
    loop = _loop_src()
    assert "_maybe_reconnect(" in loop and "_session_active" in loop, \
        "mid-session the ladder owns recovery (it alone restarts the stream)"
    seg = loop.split("if self._session_active:")[1].split("self.log(\"auto-connect: earbuds found")[0]
    assert "self.connect" not in seg, \
        "a plain connect() mid-session restores the link but leaves the reading frozen"


def t_no_address_clearing_and_backoff_instead():
    loop = _loop_src()
    assert "self._left_addr = None" not in loop and "self._right_addr = None" not in loop, \
        "clearing addresses disarms a live ladder's need_left/need_right"
    assert "_auto_fail_streak" in loop and "_auto_backoff" in loop, \
        "failures must back off, not churn every cycle"


def t_exclusion_is_two_way():
    mr = SRC.split("def _maybe_reconnect(self, status):")[1].split("async def _attempt_reconnect")[0]
    assert "_connect_in_flight" in mr, "the ladder must not spawn under an in-flight connect"
    conn = SRC.split("async def connect(self, auto=False):")[1].split("async def _connect_inner")[0]
    assert "_reconnecting" in conn and "_rotating" in conn, \
        "connect must refuse while the ladder or rotation owns the link"


def t_heartbeat_and_error_lines_are_scarce():
    assert "AUTOCONNECT_HEARTBEAT_SEC = 600" in SRC, \
        "one still-watching line per 10 minutes, not one per minute"
    loop = _loop_src()
    assert "_auto_last_err" in loop, "identical failure lines must be deduplicated"


def t_backoff_is_capped():
    class H:
        _auto_fail_streak = 0
    for streak, cap in ((0, zone_source.AUTOCONNECT_IDLE_SEC), (30, 120.0)):
        H._auto_fail_streak = streak
        v = zone_source.ZoneSource._auto_backoff(H)
        assert v <= 120.0, "backoff must cap at 2 minutes: %r" % v
        if streak == 0:
            assert v == zone_source.AUTOCONNECT_IDLE_SEC, "no penalty before any failure"
    H._auto_fail_streak = 3
    assert zone_source.ZoneSource._auto_backoff(H) > zone_source.AUTOCONNECT_IDLE_SEC, \
        "repeated failures must actually slow the loop down"


# ---------------- behavioural scenarios: real loop, fake SDK ----------------
# The fake's get_buds_status() is the SAME live truth the production gate
# reads. Nothing in these tests writes _left_up/_right_up by hand.

def make_room(script):
    """Build a TestSource around a scripted discover(). Returns (src, world)."""
    world = {
        "scans": [], "sends": [], "logs": [], "connects": [],
        "buds": {"left_connected": False, "right_connected": False},
        "script": script,
    }

    class FakeZone:
        _inside_sample_rate_recovery = False
        _lead_armed = False

        def __init__(self):
            self.connection = types.SimpleNamespace(set_leadoff_tap=lambda cb: None)

        def get_buds_status(self):
            return dict(world["buds"])

        def __getattr__(self, name):
            return lambda *a, **k: None

        @staticmethod
        async def discover(duration=5):
            world["scans"].append(duration)
            return world["script"](len(world["scans"]))

    fake_pkg = types.ModuleType("zone_sdk")
    fake_pkg.Zone = FakeZone

    class TestSource(zone_source.ZoneSource):
        def _ensure_profiles(self):
            pass

    real_pkg = sys.modules.get("zone_sdk")
    sys.modules["zone_sdk"] = fake_pkg
    try:
        tx = types.SimpleNamespace(send=lambda *a, **k: world["sends"].append(a))
        src = TestSource(tx, None, lambda *a: world["logs"].append(" ".join(map(str, a))))
    finally:
        if real_pkg is not None:
            sys.modules["zone_sdk"] = real_pkg
        else:
            sys.modules.pop("zone_sdk", None)
    return src, world


def fast(coro):
    """Run a scenario with tight loop timings."""
    saved = (zone_source.AUTOCONNECT_SETTLE_SEC, zone_source.AUTOCONNECT_IDLE_SEC,
             zone_source.AUTOCONNECT_SCAN_SEC)
    zone_source.AUTOCONNECT_SETTLE_SEC = 0.02
    zone_source.AUTOCONNECT_IDLE_SEC = 0.04
    zone_source.AUTOCONNECT_SCAN_SEC = 0.01
    try:
        asyncio.run(coro)
    finally:
        (zone_source.AUTOCONNECT_SETTLE_SEC, zone_source.AUTOCONNECT_IDLE_SEC,
         zone_source.AUTOCONNECT_SCAN_SEC) = saved


BOTH = [{"name": "Zone Left", "address": "AA:11", "rssi": -50},
        {"name": "Zone Right", "address": "BB:22", "rssi": -52}]


def t_scenario_scan_connect_idle():
    async def main():
        src, world = make_room(lambda n: [] if n < 3 else BOTH)

        async def fake_connect(auto=False):
            world["connects"].append((src._left_addr, src._right_addr))
            world["buds"] = {"left_connected": True, "right_connected": True}
            return True
        src.connect = fake_connect
        await asyncio.sleep(0.6)
        assert len(world["scans"]) >= 3, "the loop must keep scanning empty air: %r" % world["scans"]
        assert not world["sends"], "empty passes must emit NOTHING: %r" % world["sends"]
        assert len(world["connects"]) == 1, "exactly one handover: %r" % world["connects"]
        assert world["connects"][0] == ("AA:11", "BB:22"), "both sides classified"
        settled = len(world["scans"])
        await asyncio.sleep(0.3)
        assert len(world["scans"]) == settled, \
            "once the SDK reports connected the loop must go idle (live truth, not a cache)"
        src._auto_task.cancel()
    fast(main())


def t_scenario_survives_a_finished_session():
    # THE lockout regression: after a session, _left_up/_right_up froze True.
    # The gate must follow get_buds_status(), which says the buds are down.
    async def main():
        src, world = make_room(lambda n: BOTH)
        src._left_up = True      # stale stats-time cache, exactly as after stop_session
        src._right_up = True

        async def fake_connect(auto=False):
            world["connects"].append(auto)
            world["buds"] = {"left_connected": True, "right_connected": True}
            return True
        src.connect = fake_connect
        await asyncio.sleep(0.4)
        assert len(world["connects"]) == 1, \
            "guest 2's buds must auto-connect even though guest 1's flags went stale: %r" % world["connects"]
        src._auto_task.cancel()
    fast(main())


def t_scenario_disconnect_stands_down_and_connect_rearms():
    async def main():
        src, world = make_room(lambda n: BOTH)
        src._auto_standdown = True    # operator pressed Disconnect
        called = []

        async def fake_connect(auto=False):
            called.append(auto)
            return True
        src.connect = fake_connect
        await asyncio.sleep(0.4)
        assert not called, "a stood-down watcher must not touch parked buds"
        go, why = src._auto_gate()
        assert not go and "standing down" in why, why
        src._auto_task.cancel()
    fast(main())
    # and the re-arm: a manual connect clears the latch before anything else
    conn = SRC.split("async def connect(self, auto=False):")[1].split("async def _connect_inner")[0]
    assert "self._auto_standdown = False" in conn.split("if self._connect_in_flight")[0], \
        "a manual Connect must re-arm the watcher"
    assert "self._auto_standdown = False" in SRC.split("async def discover(self):")[1].split("self.tx.send(OUT.DISCOVERED")[0], \
        "a manual Find must re-arm the watcher"
    assert "self._auto_standdown = True" in SRC.split("async def disconnect(self):")[1].split("async def _on_metrics")[0].split("def _on_metrics")[0], \
        "operator Disconnect must set the latch"


def t_scenario_mid_session_goes_to_the_ladder():
    async def main():
        src, world = make_room(lambda n: BOTH)
        src._session_active = True
        ladder = []
        src._maybe_reconnect = lambda status: ladder.append(status)

        async def fake_connect(auto=False):
            world["connects"].append(auto)
            return True
        src.connect = fake_connect
        await asyncio.sleep(0.4)
        assert ladder, "mid-session the find must go to the reconnect ladder"
        assert not world["connects"], \
            "a plain connect() mid-session leaves the reading frozen behind a live link"
        src._auto_task.cancel()
    fast(main())


def t_scenario_failure_backs_off_and_keeps_addresses():
    async def main():
        src, world = make_room(lambda n: BOTH)

        async def fake_connect(auto=False):
            world["connects"].append(auto)
            return False
        src.connect = fake_connect
        await asyncio.sleep(0.5)
        assert world["connects"], "the loop must try"
        assert src._auto_fail_streak >= 1, "failures must count"
        assert src._auto_backoff() > zone_source.AUTOCONNECT_IDLE_SEC, \
            "a failing bud must slow the loop down"
        assert src._left_addr == "AA:11" and src._right_addr == "BB:22", \
            "failure must NOT clear the addresses a live ladder depends on"
        assert len(world["connects"]) < 6, \
            "backoff must actually reduce the retry rate: %d attempts" % len(world["connects"])
        src._auto_task.cancel()
    fast(main())


def t_scenario_half_pair_gets_grace_scans():
    # left bud out of the case first; right follows two scans later
    async def main():
        left_only = [BOTH[0]]
        src, world = make_room(lambda n: left_only if n < 3 else BOTH)

        async def fake_connect(auto=False):
            world["connects"].append((src._left_addr, src._right_addr))
            world["buds"] = {"left_connected": True, "right_connected": True}
            return True
        src.connect = fake_connect
        await asyncio.sleep(0.5)
        assert world["connects"], "the handover must happen"
        assert world["connects"][0][1] == "BB:22", \
            "the grace scans must catch the sibling before committing to a half pair"
        src._auto_task.cancel()
    fast(main())


def t_connect_is_idempotent_when_both_up():
    async def main():
        src, world = make_room(lambda n: [])
        src._auto_task.cancel()
        world["buds"] = {"left_connected": True, "right_connected": True}
        inner = []
        src._connect_inner = lambda: inner.append(1)   # would explode if awaited; must not be reached
        got = await src.connect()
        assert got is True, "connect on a fully-up pair is a no-op success"
        assert not inner, "no teardown/rebuild of a live pair"
    fast(main())


def t_connect_refuses_while_ladder_owns_link():
    async def main():
        src, world = make_room(lambda n: [])
        src._auto_task.cancel()
        src._reconnecting = True
        got = await src.connect()
        assert got is None, "connect during the ladder must be a refusal, not an attempt"
    fast(main())


for name, fn in sorted((k, v) for k, v in list(globals().items()) if k.startswith("t_")):
    ok(name[2:].replace("_", " "), fn)

print()
print(f"{len(fails)} FAILURE(S)" if fails else f"all {passed} checks passed")
sys.exit(1 if fails else 0)
