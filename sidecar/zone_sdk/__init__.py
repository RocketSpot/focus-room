"""
Zone SDK - EEG Earbud Hardware SDK
A Python SDK for connecting to Zone EEG earbuds and processing brainwave data.
"""

from .zone import zone as Zone
from .models import BrainwaveData, MetricsData, RawEEGData
from .connection import discover_devices
from .errors import ZoneError, ZoneFeatureUnavailable
from .profile import PairProfile
from .battery import BatteryReading
from .impedance import ChannelSnapshot, EarSnapshot, ImpedanceSnapshot

__version__ = "0.1.0"
__all__ = [
    "Zone",
    "BrainwaveData",
    "MetricsData",
    "RawEEGData",
    "discover_devices",
    "ZoneError",
    "ZoneFeatureUnavailable",
    "PairProfile",
    "BatteryReading",
    "ChannelSnapshot",
    "EarSnapshot",
    "ImpedanceSnapshot",
]
