"""Train strong-event trigger/repercussion models.

This model answers a different question from forecast_model.json:

    Given an initializer event of M5/M6/M7/M8+, how many M3+ or M4+ post-tremors
    tend to occur nearby in the next 1/7/30 days?

It writes a compact JSON artifact with validation metrics and magnitude-bucket
effect curves. The browser can consume this later for strong-quake post-tremor
overlays, while the current run gives us a hard sanity check on whether M5/M6
initializers have useful signal for M3/M4 repercussions.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "data" / "quakes.csv"
DEFAULT_OUT = ROOT / "data" / "trigger_model.json"
DAY_MS = 86_400_000
YEARS = 5
MIN_SPLIT_MS = DAY_MS
TARGET_MAGS = (3.0, 4.0)
INIT_MAGS = (5.0, 6.0, 7.0, 8.0)
HORIZONS = (1, 7, 30)


@dataclass
class Event:
    time: int
    lat: float
    lon: float
    depth: float
    mag: float
    id: str


def parse_time(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def read_csv(path: Path) -> list[Event]:
    events: list[Event] = []
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                events.append(Event(
                    time=parse_time(row["time"]),
                    lat=float(row["latitude"]),
                    lon=float(row["longitude"]),
                    depth=max(0.0, float(row.get("depth") or 0.0)),
                    mag=float(row["mag"]),
                    id=row.get("id") or f"{row['time']}:{row['latitude']}:{row['longitude']}",
                ))
            except (KeyError, TypeError, ValueError):
                continue
    return sorted(events, key=lambda e: e.time)


def fetch_range(start_ms: int, end_ms: int, min_mag: float) -> list[Event]:
    start = datetime.fromtimestamp(start_ms / 1000, timezone.utc)
    end = datetime.fromtimestamp(end_ms / 1000, timezone.utc)
    params = {
        "format": "csv",
        "starttime": start.isoformat(),
        "endtime": end.isoformat(),
        "minmagnitude": str(min_mag),
        "orderby": "time-asc",
    }
    url = "https://earthquake.usgs.gov/fdsnws/event/1/query?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=180) as res:
            text = res.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 400 and end_ms - start_ms > MIN_SPLIT_MS:
            mid = (start_ms + end_ms) // 2
            return fetch_range(start_ms, mid, min_mag) + fetch_range(mid + 1, end_ms, min_mag)
        raise
    out: list[Event] = []
    for row in csv.DictReader(text.splitlines()):
        try:
            out.append(Event(
                time=parse_time(row["time"]),
                lat=float(row["latitude"]),
                lon=float(row["longitude"]),
                depth=max(0.0, float(row.get("depth") or 0.0)),
                mag=float(row["mag"]),
                id=row.get("id") or f"{row['time']}:{row['latitude']}:{row['longitude']}",
            ))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(out, key=lambda e: e.time)


def fetch_usgs(min_mag: float) -> list[Event]:
    now = datetime.now(timezone.utc)
    start = datetime(now.year - YEARS, now.month, now.day, tzinfo=timezone.utc)
    print(f"Fetching USGS M{min_mag:g}+ catalog: {start.date()} to {now.date()}")
    events = fetch_range(int(start.timestamp() * 1000), int(now.timestamp() * 1000), min_mag)
    by_id = {e.id: e for e in events}
    return sorted(by_id.values(), key=lambda e: e.time)


def gc_km(a: Event, b: Event) -> float:
    r = 6371.0
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp = p2 - p1
    dl = math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def radius_for_mag(mag: float) -> float:
    return min(900.0, 45.0 * math.pow(10.0, 0.32 * (mag - 4.0)))


def features(init: Event, before: list[Event]) -> list[float]:
    ages = np.array([(init.time - e.time) / DAY_MS for e in before if e.time < init.time], dtype=float)
    mags = np.array([e.mag for e in before if e.time < init.time], dtype=float)
    if len(ages) == 0:
        recent = [0.0] * 8
        max_recent = 0.0
    else:
        recent = []
        for floor in (3, 4, 5, 6):
            mask = mags >= floor
            recent.append(float(np.sum((ages <= 30) & mask)))
            recent.append(float(np.sum((ages <= 365) & mask)))
        max_recent = float(np.max(mags[ages <= 365])) if np.any(ages <= 365) else 0.0
    return [
        init.mag,
        math.log1p(init.depth),
        math.sin(math.radians(init.lat)),
        math.cos(math.radians(init.lat)),
        math.sin(math.radians(init.lon)),
        math.cos(math.radians(init.lon)),
        math.log1p(radius_for_mag(init.mag)),
        *[math.log1p(x) for x in recent],
        max_recent,
    ]


def build_rows(events: list[Event], target_mag: float, horizon: int, init_floor: float) -> tuple[np.ndarray, np.ndarray, list[Event]]:
    targets = [e for e in events if e.mag >= target_mag]
    initializers = [e for e in events if e.mag >= init_floor]
    rows, y = [], []
    for init in initializers:
        before = [e for e in targets if init.time - 365 * DAY_MS <= e.time < init.time]
        rad = radius_for_mag(init.mag)
        count = 0
        for e in targets:
            if e.id == init.id:
                continue
            if not (init.time < e.time <= init.time + horizon * DAY_MS):
                continue
            if gc_km(init, e) <= rad:
                count += 1
        rows.append(features(init, before))
        y.append(math.log1p(count))
    return np.asarray(rows, dtype=np.float32), np.asarray(y, dtype=np.float32), initializers


def train_eval(events: list[Event], target_mag: float, horizon: int, init_floor: float, holdout_days: int) -> dict:
    x, y, inits = build_rows(events, target_mag, horizon, init_floor)
    if len(y) < 30:
        return {"ok": False, "reason": f"only {len(y)} initializer rows"}
    cutoff = events[-1].time - holdout_days * DAY_MS
    train_idx = np.array([i for i, e in enumerate(inits) if e.time < cutoff], dtype=int)
    test_idx = np.array([i for i, e in enumerate(inits) if e.time >= cutoff], dtype=int)
    if len(train_idx) < 20 or len(test_idx) < 5:
        return {"ok": False, "reason": f"train/test too small ({len(train_idx)}/{len(test_idx)})"}

    model = RandomForestRegressor(n_estimators=220, min_samples_leaf=2, n_jobs=-1, random_state=42)
    q90 = GradientBoostingRegressor(loss="quantile", alpha=0.9, n_estimators=220, max_depth=3, learning_rate=0.045, random_state=90)
    model.fit(x[train_idx], y[train_idx])
    q90.fit(x[train_idx], y[train_idx])
    pred = np.expm1(model.predict(x[test_idx]))
    upper = np.maximum(pred, np.expm1(q90.predict(x[test_idx])))
    actual = np.expm1(y[test_idx])
    total_actual = float(np.sum(actual))
    total_pred = float(np.sum(pred))
    covered = float(np.mean(actual <= upper))
    return {
        "ok": True,
        "rows": int(len(y)),
        "trainRows": int(len(train_idx)),
        "testRows": int(len(test_idx)),
        "actualTotal": round(total_actual, 2),
        "predictedTotal": round(total_pred, 2),
        "mae": round(float(mean_absolute_error(actual, pred)), 4),
        "rmse": round(float(math.sqrt(mean_squared_error(actual, pred))), 4),
        "p90Coverage": round(covered, 4),
        "meanActual": round(float(np.mean(actual)), 4),
        "meanPredicted": round(float(np.mean(pred)), 4),
        "liftVsMean": round(float(np.mean(pred[actual > 0]) / (np.mean(pred) + 1e-9)), 4) if np.any(actual > 0) else None,
    }


def bucket_effects(events: list[Event], target_mag: float, horizon: int) -> list[dict]:
    out = []
    targets = [e for e in events if e.mag >= target_mag]
    for floor in INIT_MAGS:
        vals = []
        for init in events:
            if init.mag < floor:
                continue
            rad = radius_for_mag(init.mag)
            c = sum(
                1 for e in targets
                if e.id != init.id and init.time < e.time <= init.time + horizon * DAY_MS and gc_km(init, e) <= rad
            )
            vals.append(c)
        if vals:
            arr = np.asarray(vals, dtype=float)
            out.append({
                "initMag": floor,
                "n": int(len(vals)),
                "mean": round(float(np.mean(arr)), 3),
                "p50": round(float(np.percentile(arr, 50)), 3),
                "p90": round(float(np.percentile(arr, 90)), 3),
                "p99": round(float(np.percentile(arr, 99)), 3),
            })
        else:
            out.append({"initMag": floor, "n": 0})
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--holdout-days", type=int, default=365)
    args = p.parse_args()

    events = read_csv(args.csv) if args.csv.exists() else fetch_usgs(3.0)
    events = [e for e in events if e.mag >= 3]
    print(f"Loaded {len(events):,} M3+ events")

    results = []
    for target_mag in TARGET_MAGS:
        for init_floor in INIT_MAGS:
            for horizon in HORIZONS:
                print(f"Target M{target_mag:g}+ from M{init_floor:g}+ initializers, {horizon}d")
                res = train_eval(events, target_mag, horizon, init_floor, args.holdout_days)
                res.update({"targetMag": target_mag, "initMag": init_floor, "horizonDays": horizon})
                results.append(res)

    effects = []
    for target_mag in TARGET_MAGS:
        for horizon in HORIZONS:
            effects.append({
                "targetMag": target_mag,
                "horizonDays": horizon,
                "buckets": bucket_effects(events, target_mag, horizon),
            })

    artifact = {
        "kind": "strong-initializer-post-tremor-model",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "catalogNewest": datetime.fromtimestamp(events[-1].time / 1000, timezone.utc).isoformat(),
        "holdoutDays": args.holdout_days,
        "radiusFormula": "min(900, 45 * 10 ** (0.32 * (mag - 4))) km",
        "results": results,
        "effects": effects,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
