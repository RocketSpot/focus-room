"""NDJSON transport: the sidecar's localhost link back to Electron main.

Electron main listens on 127.0.0.1:<port> and hands us the port on argv. We
connect as a client and exchange newline-delimited JSON. Sends are made from
several threads (asyncio loop + Bleak worker threads that fire SDK callbacks),
so send() is guarded by a lock. Incoming commands are parsed on a reader thread
and handed to the asyncio loop via call_soon_threadsafe.
"""

import asyncio
import json
import socket
import threading
import time
from typing import Optional


class Transport:
    def __init__(self, host: str, port: int):
        self._host = host
        self._port = port
        self._sock: Optional[socket.socket] = None
        self._send_lock = threading.Lock()
        self._reader: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.commands: Optional[asyncio.Queue] = None
        self._closed = threading.Event()

    def connect(self, retries: int = 50, delay: float = 0.1) -> None:
        """Blocking connect with retries — main's TCP server is already up."""
        last = None
        for _ in range(retries):
            try:
                self._sock = socket.create_connection((self._host, self._port), timeout=5)
                # create_connection leaves its 5s timeout on the socket; clear it
                # so the blocking recv() in _read_loop waits indefinitely between
                # commands instead of raising socket.timeout (which would look
                # like EOF and trigger a spurious restart every few seconds).
                self._sock.settimeout(None)
                self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                return
            except OSError as e:  # server not listening yet
                last = e
                time.sleep(delay)
        raise ConnectionError(f"could not reach main at {self._host}:{self._port}: {last}")

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self.commands = asyncio.Queue()
        self._reader = threading.Thread(target=self._read_loop, name="transport-reader", daemon=True)
        self._reader.start()

    def send(self, type_: str, **payload) -> None:
        if self._sock is None or self._closed.is_set():
            return
        payload.setdefault("t", int(time.time() * 1000))
        line = json.dumps({"type": type_, **payload}, separators=(",", ":")) + "\n"
        data = line.encode("utf-8")
        with self._send_lock:
            try:
                self._sock.sendall(data)
            except OSError:
                self._closed.set()

    def _read_loop(self) -> None:
        buf = b""
        try:
            while not self._closed.is_set():
                try:
                    chunk = self._sock.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line.decode("utf-8"))
                    except ValueError:
                        continue
                    if self._loop is not None and self.commands is not None:
                        self._loop.call_soon_threadsafe(self.commands.put_nowait, msg)
        finally:
            self._closed.set()
            # Wake the command consumer so the main loop can exit cleanly.
            if self._loop is not None and self.commands is not None:
                self._loop.call_soon_threadsafe(self.commands.put_nowait, {"type": "shutdown", "_eof": True})

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def close(self) -> None:
        self._closed.set()
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
