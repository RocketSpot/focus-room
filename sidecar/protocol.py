"""Message contract — Python mirror of app/protocol.js. Keep strings in lock-step.

Every message on the localhost link is one JSON object per line (NDJSON):
    {"type": <one of these>, "t": <ms>, ...payload}
"""

PROTO_VERSION = 1


class OUT:
    """sidecar -> main"""
    HELLO = "hello"
    READY = "ready"
    LOG = "log"
    ERROR = "error"
    DISCOVERED = "discovered"
    METRICS = "eeg/metrics"
    FRAME = "eeg/frame"
    BRAINWAVES = "eeg/brainwaves"
    STATS = "eeg/stats"
    CONNECTION = "eeg/connection"
    BATTERY = "fit/battery"
    IMPEDANCE = "fit/impedance"
    PLATEAU = "session/plateau"
    DIP = "session/dip"
    ARCHETYPE = "session/archetype"
    SESSION_SAMPLES = "session/samples"
    # Phase 2A — raw per-channel EEG transport + honest quality (versioned; see
    # sidecar/eeg_stream.py). These carry ADC counts and continuity/quality, never µV.
    EEG_CONFIG = "eeg/config-v1"
    EEG_RAW = "eeg/raw-v1"
    EEG_QUALITY = "eeg/quality-v1"


class IN:
    """main -> sidecar"""
    PING = "ping"
    DISCOVER = "discover"
    CONNECT = "connect"
    DISCONNECT = "disconnect"
    START_FIT = "start_fit"
    STOP_FIT = "stop_fit"
    START_SESSION = "start_session"
    STOP_SESSION = "stop_session"
    MARK = "mark"
    TEST_SIGNAL = "test_signal"
    SHUTDOWN = "shutdown"


class STATE_WORD:
    SETTLING = "settling"
    FOCUSED = "focused"
    DIPPING = "dipping"
    RECOVERING = "recovering"
