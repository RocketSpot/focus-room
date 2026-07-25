"""Zone SDK — exception hierarchy."""


class ZoneError(Exception):
    """Base class for all Zone SDK errors."""


class ZoneFeatureUnavailable(ZoneError):
    """Raised when a feature is called but prerequisites are missing.

    Examples:
      - get_battery() called with no active pair
      - get_battery() called on a pair whose battery UUIDs are null
      - start_impedance() called before connect
    """
