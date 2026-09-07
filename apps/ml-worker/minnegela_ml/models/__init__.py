class ModelUnavailable(RuntimeError):
    """Raised when an ML dependency or model file is missing. Jobs fail with this message
    instead of crashing the worker, so the queue keeps moving for non-ML work."""
