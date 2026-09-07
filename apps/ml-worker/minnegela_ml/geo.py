from __future__ import annotations

import math

import numpy as np

EARTH_R = 6_371_000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def centroid(latlons: np.ndarray) -> tuple[float, float] | None:
    """Mean position on the unit sphere (correct across the antimeridian)."""
    if latlons.shape[0] == 0:
        return None
    lat = np.radians(latlons[:, 0])
    lon = np.radians(latlons[:, 1])
    x, y, z = np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)
    mx, my, mz = x.mean(), y.mean(), z.mean()
    return float(np.degrees(np.arctan2(mz, np.hypot(mx, my)))), float(np.degrees(np.arctan2(my, mx)))


def to_local_xy(latlons: np.ndarray, ref: tuple[float, float]) -> np.ndarray:
    """Equirectangular projection to metres around `ref`; fine for DBSCAN at city scale."""
    lat0 = math.radians(ref[0])
    x = np.radians(latlons[:, 1] - ref[1]) * math.cos(lat0) * EARTH_R
    y = np.radians(latlons[:, 0] - ref[0]) * EARTH_R
    return np.stack([x, y], axis=1)
