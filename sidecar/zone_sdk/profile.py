"""Zone SDK — pair profile loader for the flat ble_profiles.json schema."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Dict, Optional


# Metadata keys kept in PairProfile.metadata (not derived from triplets)
_METADATA_KEYS = (
    "Serial_Number",
    "Left_MAC_Address",
    "Right_MAC_Address",
    "Left_Firmware_Upload",
    "Right_Firmware_Upload",
    "Left_Deployment_Status",
    "Right_Deployment_Status",
    "Jieli_MAC_Address",
    "QC_Passed",
    "Data_Test_Done",
    "Charge_Case_Complete",
)


def _triplet(flat: dict, prefix: str) -> Optional[Dict[str, str]]:
    """Build a {service, rx, tx} dict from <prefix>_Service_UUID etc.

    Returns None if any of the three values is missing or null.
    """
    service = flat.get(f"{prefix}_Service_UUID")
    rx      = flat.get(f"{prefix}_RX_UUID")
    tx      = flat.get(f"{prefix}_TX_UUID")
    if not service or not rx or not tx:
        return None
    return {"service": service, "rx": rx, "tx": tx}


@dataclass
class PairProfile:
    name: str
    left_eeg:      Optional[Dict[str, str]]
    right_eeg:     Optional[Dict[str, str]]
    left_battery:  Optional[Dict[str, str]]
    right_battery: Optional[Dict[str, str]]
    left_touch:    Optional[Dict[str, str]]
    right_touch:   Optional[Dict[str, str]]
    metadata:      dict = field(default_factory=dict)

    @property
    def has_eeg(self) -> bool:
        return self.left_eeg is not None or self.right_eeg is not None

    @property
    def has_battery(self) -> bool:
        return self.left_battery is not None and self.right_battery is not None

    @property
    def has_touch(self) -> bool:
        return self.left_touch is not None and self.right_touch is not None


def pair_from_flat(name: str, flat: dict) -> PairProfile:
    """Parse one flat JSON entry into a PairProfile."""
    return PairProfile(
        name=name,
        left_eeg=      _triplet(flat, "Left"),
        right_eeg=     _triplet(flat, "Right"),
        left_battery=  _triplet(flat, "Left_Battery"),
        right_battery= _triplet(flat, "Right_Battery"),
        left_touch=    _triplet(flat, "Left_Touch"),
        right_touch=   _triplet(flat, "Right_Touch"),
        metadata={k: flat.get(k) for k in _METADATA_KEYS},
    )


def load_profiles(profiles_path: Path) -> Dict[str, Dict[str, PairProfile]]:
    """Load ble_profiles.json and return {profile_name: {pair_name: PairProfile}}.

    Reads from package resources first, falls back to the given path.
    """
    data = None
    try:
        resource = resources.files("zone_sdk").joinpath("ble_profiles.json")
        with resource.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = None

    if data is None and profiles_path.exists():
        with profiles_path.open("r", encoding="utf-8") as f:
            data = json.load(f)

    if data is None:
        raise FileNotFoundError(f"ble_profiles.json not found at {profiles_path}")

    out: Dict[str, Dict[str, PairProfile]] = {}
    for profile_name, pairs in data.items():
        out[profile_name] = {
            pair_name: pair_from_flat(pair_name, flat)
            for pair_name, flat in pairs.items()
        }
    return out
