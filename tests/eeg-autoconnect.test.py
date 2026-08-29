"""The room searches for earbuds by itself, and does it politely.

Auto-connect exists so a session can start with nobody at the operator console:
open the buds near the Mac and they connect on their own. The risk in a feature
like this is never the happy path, it is the loop turning into a second actor
that fights the four mechanisms that already own the link (the operator's
connect, the reconnect ladder, the service rotation, the SDK's own recovery) or
scrolling the console with noise all day. Every check here pins one of those
properties.

Run:  venv/bin/python tests/eeg-autoconnect.test.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "sidecar"))

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
}


def t_clear_field_goes():
    go, why = auto_connect_should_try(dict(CLEAR))
    assert go, "with nothing owning the link the loop must be allowed to scan: " + why


def t_every_owner_outranks_it():
    # each single owner, alone, must stop the loop
    for field in ("connect_in_flight", "reconnecting", "rotating",
                  "sdk_recovery", "lead_armed", "in_cooldown"):
        st = dict(CLEAR)
        st[field] = True
        go, why = auto_connect_should_try(st)
        assert not go, field + " must outrank the auto loop"
        assert why != "clear", "the refusal must carry its reason"


def t_any_connected_bud_stops_it():
    for field in ("left_up", "right_up"):
        st = dict(CLEAR)
        st[field] = True
        go, why = auto_connect_should_try(st)
        assert not go, "one connected bud means the link is live, hands off"
        assert why == "connected", why


def t_kill_switch():
    st = dict(CLEAR)
    st["enabled"] = False
    go, why = auto_connect_should_try(st)
    assert not go and why == "disabled", "FOCUSROOM_AUTOCONNECT=0 must fully disable it"


def t_missing_fields_fail_closed_on_owners():
    # a state dict missing an owner flag treats it as absent, which is the only
    # sane default; but a missing "enabled" defaults to on, matching the env default
    go, _ = auto_connect_should_try({})
    assert go, "an empty state is a clear field"


def t_scan_is_quiet():
    # the loop must scan via the SDK directly, never via self.discover(), which
    # broadcasts a DISCOVERED message on every empty pass all day long
    loop = SRC.split("async def _auto_connect_loop")[1].split("def _catalogue_path")[0]
    assert "self.Zone.discover(" in loop, "the loop must scan through the SDK"
    assert "await self.discover(" not in loop, "the loop must never CALL the broadcasting discover()"
    assert "OUT.DISCOVERED" not in loop and "OUT.ERROR" not in loop, \
        "an empty pass must emit nothing to the console"


def t_heartbeat_is_throttled():
    loop = SRC.split("async def _auto_connect_loop")[1].split("def _catalogue_path")[0]
    assert "_auto_last_note" in loop and "60" in loop, \
        "the still-watching note must be throttled, not once per pass"


def t_connect_refusal_is_not_failure():
    # a duplicate connect returns None (refusal to stack), and the loop must
    # not clear the remembered addresses on it, they may belong to the manual
    # connect that is running right now
    assert "return None" in SRC.split("if self._connect_in_flight:")[1].split("async def _connect_inner")[0], \
        "a stacked connect must return None, not False"
    loop = SRC.split("async def _auto_connect_loop")[1].split("def _catalogue_path")[0]
    assert "ok is None" in loop, "the loop must treat None as defer, not as failure"


def t_failure_forgets_the_stale_address():
    loop = SRC.split("async def _auto_connect_loop")[1].split("def _catalogue_path")[0]
    after_fail = loop.split("ok is None")[1]
    assert "self._left_addr = None" in after_fail and "self._right_addr = None" in after_fail, \
        "a failed attempt must re-discover next pass, not hammer a stale MAC"


def t_task_creation_respects_the_switch():
    assert "if AUTOCONNECT_ENABLED:" in SRC and "_auto_connect_loop())" in SRC, \
        "the task must only be created when the feature is on"


def t_loop_survives_exceptions():
    loop = SRC.split("async def _auto_connect_loop")[1].split("def _catalogue_path")[0]
    assert "except asyncio.CancelledError" in loop, "cancellation must end the loop cleanly"
    assert "except Exception" in loop, "a Bleak hiccup must never kill the watcher for good"


# ---- behavioural: the REAL loop against a fake SDK ---------------------------
# No hardware on the desk, so the SDK is faked at the import seam and the real
# _auto_connect_loop runs: empty air for a few passes (must stay silent), then
# both buds advertise (must hand over to connect exactly once, then go idle).
def t_live_loop_scans_then_connects_then_idles():
    import asyncio
    import types
    import zone_source

    scans = []
    sends = []
    connects = []

    class FakeZone:
        # the gate reads these two by getattr: they must be real booleans, or the
        # catch-all below would hand it a truthy lambda and the loop would defer forever
        _inside_sample_rate_recovery = False
        _lead_armed = False
        def __init__(self):
            self.connection = types.SimpleNamespace(set_leadoff_tap=lambda cb: None)
        def __getattr__(self, name):          # set_stream_chunk, on_metrics, ...
            return lambda *a, **k: None
        @staticmethod
        async def discover(duration=5):
            scans.append(duration)
            if len(scans) < 3:
                return []
            return [{"name": "Zone Left", "address": "AA:11", "rssi": -50},
                    {"name": "Zone Right", "address": "BB:22", "rssi": -52}]

    fake_pkg = types.ModuleType("zone_sdk")
    fake_pkg.Zone = FakeZone

    class TestSource(zone_source.ZoneSource):
        def _ensure_profiles(self):
            pass

    async def main():
        real_pkg = sys.modules.get("zone_sdk")
        sys.modules["zone_sdk"] = fake_pkg
        old_idle = zone_source.AUTOCONNECT_IDLE_SEC
        zone_source.AUTOCONNECT_IDLE_SEC = 0.05
        try:
            tx = types.SimpleNamespace(send=lambda *a, **k: sends.append(a))
            src = TestSource(tx, None, lambda *a: None)
            async def fake_connect():
                connects.append((src._left_addr, src._right_addr))
                src._left_up = src._right_up = True
                return True
            src.connect = fake_connect
            # the loop opens with a fixed 2 s settle, then 0.05 s passes
            await asyncio.sleep(2.9)
            assert len(scans) >= 3, "the loop must keep scanning empty air: %r" % scans
            assert not sends, "empty passes must emit NOTHING to the console: %r" % sends
            assert len(connects) == 1, "exactly one handover to connect: %r" % connects
            assert connects[0] == ("AA:11", "BB:22"), "both sides classified: %r" % connects
            settled = len(scans)
            await asyncio.sleep(0.4)
            assert len(scans) == settled, "once connected the loop must go idle, not keep scanning"
            src._auto_task.cancel()
        finally:
            zone_source.AUTOCONNECT_IDLE_SEC = old_idle
            if real_pkg is not None:
                sys.modules["zone_sdk"] = real_pkg
            else:
                sys.modules.pop("zone_sdk", None)

    asyncio.run(main())


for name, fn in sorted((k, v) for k, v in list(globals().items()) if k.startswith("t_")):
    ok(name[2:].replace("_", " "), fn)

print()
print(f"{len(fails)} FAILURE(S)" if fails else f"all {passed} checks passed")
sys.exit(1 if fails else 0)
