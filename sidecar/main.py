"""Zone — The Focus Room :: headless Python sidecar.

Connects back to Electron main over a localhost TCP socket and exchanges NDJSON.
Owns the Zone SDK (real mode) or the simulation source (--simulate), runs the
line engine, and answers commands from main. The guest never sees this process.

Run modes:
  python main.py --host 127.0.0.1 --port 5050         # real EEG, talk to main
  python main.py --host 127.0.0.1 --port 5050 --simulate
  python main.py --selftest [--simulate]              # standalone, prints NDJSON to stdout
"""

import argparse
import asyncio
import json
import os
import sys
import time

from protocol import OUT, IN, PROTO_VERSION
from engine import EngagementEngine


def log(msg: str) -> None:
    # human log → stderr (Electron supervisor captures it for the diagnostic view)
    sys.stderr.write(f"[sidecar] {msg}\n")
    sys.stderr.flush()


class StdoutTransport:
    """Selftest transport — writes NDJSON frames to stdout, no command channel."""
    def send(self, type_: str, **payload):
        payload.setdefault("t", int(time.time() * 1000))
        sys.stdout.write(json.dumps({"type": type_, **payload}, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def make_source(simulate, transport, engine):
    if simulate:
        from sim_source import SimSource
        return SimSource(transport, engine, log)
    from zone_source import ZoneSource
    return ZoneSource(transport, engine, log)


async def selftest(simulate, seconds):
    tx = StdoutTransport()
    engine = EngagementEngine()
    src = make_source(simulate, tx, engine)
    tx.send(OUT.HELLO, proto=PROTO_VERSION, simulate=simulate, pid=os.getpid(), source=src.name)
    tx.send(OUT.READY)
    await src.start_session()
    await asyncio.sleep(seconds)
    await src.stop_session()
    log(f"selftest done — {len(engine.samples)} samples, plateau={engine.plateau_fired}, dips={engine.dip_count}")


async def serve(host, port, simulate):
    from transport import Transport
    transport = Transport(host, port)
    transport.connect()
    loop = asyncio.get_running_loop()
    transport.start(loop)

    engine = EngagementEngine()
    try:
        source = make_source(simulate, transport, engine)
    except Exception as e:  # noqa: BLE001 — ANY failure to stand the engine up
        # REAL mode without a working SDK stack: missing entirely (a cross-built
        # package before its one-time install) or a wrong/old version (an
        # AttributeError instead of an ImportError — a stray site install did
        # exactly this). Say so honestly over the wire — the ops console turns
        # it into fix steps — and never fall back to simulation on our own:
        # sim is an explicit operator choice, not a stand-in.
        code = "sdk_missing" if isinstance(e, ImportError) else "engine_init_failed"
        transport.send(OUT.HELLO, proto=PROTO_VERSION, simulate=simulate,
                       pid=os.getpid(), source="none")
        transport.send(OUT.ERROR, code=code,
                       msg=f"real signal engine unavailable here ({type(e).__name__}: {e}); "
                           f"run the real-engine install once, or launch simulation explicitly")
        log(f"{code}: {e}")
        await asyncio.sleep(1.0)   # let the message flush before exiting
        sys.exit(4)
    transport.send(OUT.HELLO, proto=PROTO_VERSION, simulate=simulate,
                   pid=os.getpid(), source=source.name)
    transport.send(OUT.READY)
    log(f"ready (source={source.name}, simulate={simulate})")

    while True:
        msg = await transport.commands.get()
        mtype = msg.get("type")
        if mtype == IN.SHUTDOWN or msg.get("_eof"):
            break
        try:
            await dispatch(source, mtype, msg)
        except Exception as e:  # never let one bad command kill the sidecar
            transport.send(OUT.ERROR, code="command_failed", msg=f"{mtype}: {e}")
            log(f"command {mtype} failed: {e}")

    log("shutting down")
    try:
        await source.disconnect()
    except Exception as e:
        log(f"disconnect error: {e}")
    transport.close()


async def dispatch(source, mtype, msg):
    if mtype == IN.PING:
        return
    if mtype == IN.DISCOVER:
        await source.discover()
    elif mtype == IN.CONNECT:
        await source.connect()
    elif mtype == IN.DISCONNECT:
        await source.disconnect()
    elif mtype == IN.START_FIT:
        await source.start_fit()
    elif mtype == IN.STOP_FIT:
        await source.stop_fit()
    elif mtype == IN.START_SESSION:
        await source.start_session()
    elif mtype == IN.STOP_SESSION:
        await source.stop_session()
    elif mtype == IN.MARK:
        source.mark(msg.get("kind"), msg.get("t"))
    elif mtype == IN.TEST_SIGNAL:
        source.test_signal()
    else:
        log(f"unknown command: {mtype}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--simulate", action="store_true",
                    default=(os.environ.get("FOCUSROOM_SIMULATE") == "1"))
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--seconds", type=float, default=4.0)
    args = ap.parse_args()

    try:
        if args.selftest:
            asyncio.run(selftest(args.simulate, args.seconds))
        else:
            asyncio.run(serve(args.host, args.port, args.simulate))
    except KeyboardInterrupt:
        pass
    except ConnectionError as e:
        log(f"transport error: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
