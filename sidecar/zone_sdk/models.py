"""
Zone SDK - Data Models
"""

from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional


@dataclass
class RawEEGData:
    """
    Raw EEG data from the device.

    Attributes:
        timestamp: Time when data was captured
        channels: List of channel data (4 channels for dual earbuds)
                 Can be either:
                 - List[List[float]]: [[ch0], [ch1], [ch2], [ch3]]
                 - List[float]: Single channel samples
        sample_rate: Sampling rate in Hz
    """

    timestamp: datetime
    channels: List
    sample_rate: int

    def __repr__(self):
        n_ch = len(self.channels) if isinstance(self.channels[0], list) else 1
        return f"RawEEGData(channels={n_ch}, rate={self.sample_rate}Hz)"


@dataclass
class BrainwaveData:
    """
    Processed brainwave frequency bands.

    Attributes:
        timestamp: Time when data was processed
        delta: Delta band power (0.5-4 Hz) - deep sleep
        theta: Theta band power (4-8 Hz) - meditation, creativity
        alpha: Alpha band power (8-13 Hz) - relaxation, calmness
        beta: Beta band power (13-30 Hz) - active thinking, focus
        gamma: Gamma band power (30-45 Hz) - high-level processing
    """

    timestamp: datetime
    delta: float
    theta: float
    alpha: float
    beta: float
    gamma: float

    def __repr__(self):
        return f"BrainwaveData(α={self.alpha:.2f}, β={self.beta:.2f}, γ={self.gamma:.2f}, θ={self.theta:.2f}, δ={self.delta:.2f})"


@dataclass
class MetricsData:
    """
    Calculated mental state metrics (0-1 range).
   

    Attributes:
        timestamp: Time when metrics were calculated
        focus: Focus level (0-1)
        stress: Stress level (0-1)
        mental_readiness: Mental readiness score (0-1)
        engagement: Engagement level (0-1) 
        drowsiness: Drowsiness level (0-1)
        relaxation: Relaxation level (0-1) - 
        wellness: Wellness level (0-1) - 
    """

    timestamp: datetime
    focus: float
    stress: float
    mental_readiness: float
    engagement: float
    drowsiness: float
    relaxation: Optional[float] = None
    wellness: Optional[float] = None

    def __repr__(self):
        return f"MetricsData(focus={self.focus:.2f}, stress={self.stress:.2f}, readiness={self.mental_readiness:.2f}, engagement={self.engagement:.2f})"


@dataclass
class DeviceInfo:
    """
    Information about connected device.

    Attributes:
        name: Device name
        address: BLE address
        connected: Connection status
        streaming: Streaming status
    """

    name: str
    address: str
    connected: bool = False
    streaming: bool = False

    def __repr__(self):
        status = "Connected" if self.connected else "Disconnected"
        return f"DeviceInfo(name={self.name}, status={status})"
