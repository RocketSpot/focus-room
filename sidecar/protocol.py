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
    # Per-session analysis counters: how many windows were measured, how many were
    # dropped and why, and the running 1/f exponent. Lets the orchestrator judge a
    # session's data quality on facts rather than on a signal-quality guess.
    ANALYSIS = "eeg/analysis-v1"
    STATS = "eeg/stats"
    CONNECTION = "eeg/connection"
    BATTERY = "fit/battery"
    IMPEDANCE = "fit/impedance"
    # Live per-channel electrode contact, decoded from the lead-off bits the
    # firmware sends inline with every sample. Unlike IMPEDANCE this needs no
    # injected current, so it works DURING a reading. Operator-facing only.
    LEADOFF = "fit/leadoff"
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
