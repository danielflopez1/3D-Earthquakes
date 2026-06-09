"""Train an offline earthquake forecast artifact for the browser app.

This is intentionally an artifact generator, not a Python server. It learns from
USGS catalog history, scores the next 30 days over active spatial cells, and
writes a compact JSON file the static browser app can consume:

    python scripts/train_forecast_model.py

If data/quakes.csv exists, it is used. Otherwise the script fetches an M4+
catalog from USGS for the configured lookback window.
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

try:
    from xgboost import XGBRegressor
except Exception:  # pragma: no cover - optional dependency
    XGBRegressor = None


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "data" / "quakes.csv"
DEFAULT_OUT = ROOT / "data" / "forecast_model.json"
DEFAULT_BACKTEST_OUT = ROOT / "data" / "forecast_backtest.json"
DEFAULT_SWEEP_OUT = ROOT / "data" / "forecast_sweep.json"
DAY_MS = 86_400_000
HORIZON_DAYS = 30
CELL_DEG = 4.0
MIN_MAG = 4.0
YEARS = 5
MIN_SPLIT_MS = DAY_MS


@dataclass
class Event:
    time: int
    lat: float
    lon: float
    depth: float
    mag: float


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
                ))
            except (KeyError, TypeError, ValueError):
                continue
    events.sort(key=lambda e: e.time)
    return events


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
    rows = csv.DictReader(text.splitlines())
    events: list[Event] = []
    for row in rows:
        try:
            events.append(Event(
                time=parse_time(row["time"]),
                lat=float(row["latitude"]),
                lon=float(row["longitude"]),
                depth=max(0.0, float(row.get("depth") or 0.0)),
                mag=float(row["mag"]),
            ))
        except (KeyError, TypeError, ValueError):
            continue
    events.sort(key=lambda e: e.time)
    return events


def fetch_usgs(min_mag: float, years: int) -> list[Event]:
    now = datetime.now(timezone.utc)
    start = datetime(now.year - years, now.month, now.day, tzinfo=timezone.utc)
    print(f"Fetching USGS M{min_mag}+ catalog: {start.date()} to {now.date()}")
    events = fetch_range(int(start.timestamp() * 1000), int(now.timestamp() * 1000), min_mag)
    by_key = {(e.time, e.lat, e.lon, e.mag): e for e in events}
    return sorted(by_key.values(), key=lambda e: e.time)


def cell_id(lat: float, lon: float) -> tuple[int, int]:
    return (math.floor((lat + 90.0) / CELL_DEG), math.floor((lon + 180.0) / CELL_DEG))


def cell_center(cell: tuple[int, int]) -> tuple[float, float]:
    iy, ix = cell
    return -90.0 + (iy + 0.5) * CELL_DEG, -180.0 + (ix + 0.5) * CELL_DEG


def intensity_value(mag: float, depth: float) -> float:
    return max(1.0, min(10.0, 1.4 * mag - 1.6 - math.log10(max(1.0, depth)) * 0.45))


def mmi_label(value: float) -> str:
    roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
    return roman[max(1, min(10, round(value))) - 1]


def feature_row(cell: tuple[int, int], now_ms: int, history: list[Event]) -> list[float]:
    lat, lon = cell_center(cell)
    past = [e for e in history if e.time < now_ms]
    ages = np.array([(now_ms - e.time) / DAY_MS for e in past], dtype=float)
    mags = np.array([e.mag for e in past], dtype=float)
    depths = np.array([e.depth for e in past], dtype=float)
    if len(ages) == 0:
        return [
            lat / 90, lon / 180, math.sin(math.radians(lon)), math.cos(math.radians(lon)),
            0, 0, 0, 0, 0, 3650, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0,
        ]
    counts = [float(np.sum(ages <= d)) for d in (7, 30, 90, 365)]
    band_counts = []
    for mag_floor in (5, 6, 7, 8):
        mask = mags >= mag_floor
        band_counts.append(float(np.sum((ages <= 30) & mask)))
        band_counts.append(float(np.sum((ages <= 365) & mask)))
    energy30 = sum(math.pow(10, 1.5 * e.mag) for e in past if (now_ms - e.time) / DAY_MS <= 30)
    energy365 = sum(math.pow(10, 1.5 * e.mag) for e in past if (now_ms - e.time) / DAY_MS <= 365)
    return [
        lat / 90,
        lon / 180,
        math.sin(math.radians(lon)),
        math.cos(math.radians(lon)),
        math.log1p(counts[0]),
        math.log1p(counts[1]),
        math.log1p(counts[2]),
        math.log1p(counts[3]),
        float(np.max(mags)),
        float(np.min(ages)),
        float(np.median(depths)),
        float(np.percentile(mags, 90)),
        *[math.log1p(x) for x in band_counts],
        math.log10(energy30 + 1),
        math.log10(energy365 + 1),
        float(np.max(mags[ages <= 30])) if np.any(ages <= 30) else 0.0,
        float(np.max(mags[ages <= 365])) if np.any(ages <= 365) else 0.0,
        float(np.mean(depths[mags >= 5])) if np.any(mags >= 5) else float(np.median(depths)),
    ]


def build_training(events: list[Event], max_rows: int) -> tuple[np.ndarray, np.ndarray, list[tuple[int, int]], dict[tuple[int, int], list[Event]]]:
    by_cell: dict[tuple[int, int], list[Event]] = {}
    for e in events:
        by_cell.setdefault(cell_id(e.lat, e.lon), []).append(e)

    active_cells = [cell for cell, evs in by_cell.items() if len(evs) >= 4]
    if not active_cells:
        raise RuntimeError("not enough events to train forecast cells")

    t_min, t_max = events[0].time, events[-1].time
    step = HORIZON_DAYS * DAY_MS
    cutoffs = list(range(t_min + 365 * DAY_MS, t_max - step, step))
    rows: list[list[float]] = []
    target: list[float] = []

    for cutoff in cutoffs:
        for cell in active_cells:
            evs = by_cell[cell]
            past = [e for e in evs if e.time < cutoff]
            if len(past) < 3:
                continue
            future_count = sum(cutoff <= e.time < cutoff + step for e in evs)
            rows.append(feature_row(cell, cutoff, past))
            target.append(math.log1p(future_count))

    if len(rows) > max_rows:
        rng = np.random.default_rng(42)
        idx = rng.choice(len(rows), size=max_rows, replace=False)
        rows = [rows[i] for i in idx]
        target = [target[i] for i in idx]

    return np.asarray(rows, dtype=np.float32), np.asarray(target, dtype=np.float32), active_cells, by_cell


def train_quantile_models(x: np.ndarray, y: np.ndarray) -> dict[str, GradientBoostingRegressor]:
    models: dict[str, GradientBoostingRegressor] = {}
    for name, alpha in (("p10", 0.10), ("p50", 0.50), ("p90", 0.90)):
        model = GradientBoostingRegressor(
            loss="quantile",
            alpha=alpha,
            n_estimators=260,
            max_depth=3,
            learning_rate=0.045,
            min_samples_leaf=4,
            subsample=0.85,
            random_state=100 + int(alpha * 100),
        )
        model.fit(x, y)
        models[name] = model
    return models


def make_point_model():
    if XGBRegressor is not None:
        return "xgboost-regressor", XGBRegressor(
            n_estimators=360,
            max_depth=5,
            learning_rate=0.045,
            subsample=0.85,
            colsample_bytree=0.85,
            objective="reg:squarederror",
            n_jobs=-1,
            random_state=42,
        )
    return "sklearn-random-forest-regressor", RandomForestRegressor(
        n_estimators=220,
        min_samples_leaf=3,
        n_jobs=-1,
        random_state=42,
    )


def predict_interval(row: np.ndarray, point_model, quantile_models) -> tuple[float, float, float, float, float]:
    point_rate = float(np.expm1(point_model.predict(row)[0]))
    q10 = float(np.expm1(quantile_models["p10"].predict(row)[0]))
    q50 = float(np.expm1(quantile_models["p50"].predict(row)[0]))
    q90 = float(np.expm1(quantile_models["p90"].predict(row)[0]))
    q10, q50, q90 = sorted((max(0.0, q10), max(0.0, q50), max(0.0, q90)))
    forecast_score = max(q50, 0.5 * max(0.0, point_rate), 0.25 * q90)
    return point_rate, q10, q50, q90, forecast_score


def run_backtest(events: list[Event], max_rows: int, holdout_days: int, top_k: int) -> dict:
    end_ms = events[-1].time
    split_ms = end_ms - holdout_days * DAY_MS
    train_events = [e for e in events if e.time < split_ms]
    if len(train_events) < 100:
        raise RuntimeError("not enough pre-holdout events for backtest")

    x, y, cells, _ = build_training(train_events, max_rows)
    _, point_model = make_point_model()
    point_model.fit(x, y)
    quantile_models = train_quantile_models(x, y)

    by_cell: dict[tuple[int, int], list[Event]] = {}
    for e in events:
        by_cell.setdefault(cell_id(e.lat, e.lon), []).append(e)

    windows = list(range(split_ms, end_ms - HORIZON_DAYS * DAY_MS + 1, HORIZON_DAYS * DAY_MS))
    rows = []
    actuals = []
    preds = []
    covered_10_90 = 0
    covered_50_90 = 0
    total = 0
    top_hits = 0
    top_possible = 0

    for cutoff in windows:
        scored = []
        actual_by_cell = {}
        for cell in cells:
            evs = by_cell.get(cell, [])
            past = [e for e in evs if e.time < cutoff]
            if len(past) < 3:
                continue
            actual = sum(cutoff <= e.time < cutoff + HORIZON_DAYS * DAY_MS for e in evs)
            row = np.asarray([feature_row(cell, cutoff, past)], dtype=np.float32)
            _, q10, q50, q90, score = predict_interval(row, point_model, quantile_models)
            actuals.append(actual)
            preds.append(q50)
            covered_10_90 += int(q10 <= actual <= q90)
            covered_50_90 += int(actual <= q90)
            total += 1
            scored.append((score, cell))
            actual_by_cell[cell] = actual

        scored.sort(reverse=True, key=lambda x: x[0])
        top_cells = {cell for _, cell in scored[:top_k]}
        window_events = sum(actual_by_cell.values())
        if window_events:
            top_hits += sum(actual_by_cell.get(cell, 0) for cell in top_cells)
            top_possible += window_events
        rows.append({
            "start": datetime.fromtimestamp(cutoff / 1000, timezone.utc).isoformat(),
            "actualEvents": window_events,
            "topKEvents": sum(actual_by_cell.get(cell, 0) for cell in top_cells),
        })

    actual_arr = np.asarray(actuals, dtype=float)
    pred_arr = np.asarray(preds, dtype=float)
    err = pred_arr - actual_arr
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "holdoutDays": holdout_days,
        "horizonDays": HORIZON_DAYS,
        "windows": len(windows),
        "cellWindows": total,
        "mae": round(float(np.mean(np.abs(err))), 4) if total else None,
        "rmse": round(float(np.sqrt(np.mean(err * err))), 4) if total else None,
        "meanActual": round(float(np.mean(actual_arr)), 4) if total else None,
        "meanPredictedP50": round(float(np.mean(pred_arr)), 4) if total else None,
        "coverageP10P90": round(covered_10_90 / total, 4) if total else None,
        "coverageBelowP90": round(covered_50_90 / total, 4) if total else None,
        "topK": top_k,
        "topKCapture": round(top_hits / top_possible, 4) if top_possible else None,
        "topKEvents": top_hits,
        "totalHeldoutEvents": top_possible,
        "windowSummaries": rows,
    }


def parse_mag_list(value: str) -> list[float]:
    out = []
    for part in value.split(','):
        part = part.strip()
        if not part:
            continue
        out.append(float(part))
    return out


def run_sweep(events: list[Event], mags: list[float], max_rows: int, holdout_days: int, top_k: int) -> dict:
    results = []
    for mag in mags:
        subset = [e for e in events if e.mag >= mag]
        print(f"Sweep M{mag:g}+: {len(subset):,} events")
        if len(subset) < 100:
            results.append({"minMag": mag, "ok": False, "reason": f"only {len(subset)} events"})
            continue
        try:
            report = run_backtest(subset, max_rows, holdout_days, top_k)
            report["minMag"] = mag
            report["ok"] = True
            results.append(report)
            print(
                f"  MAE={report['mae']} RMSE={report['rmse']} "
                f"P10-P90={report['coverageP10P90']} topK={report['topKCapture']}"
            )
        except Exception as exc:
            results.append({"minMag": mag, "ok": False, "reason": str(exc)})
            print(f"  failed: {exc}")
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "holdoutDays": holdout_days,
        "horizonDays": HORIZON_DAYS,
        "topK": top_k,
        "results": results,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--max-rows", type=int, default=80_000)
    p.add_argument("--top-cells", type=int, default=600)
    p.add_argument("--min-mag", type=float, default=MIN_MAG)
    p.add_argument("--backtest-out", type=Path, default=DEFAULT_BACKTEST_OUT)
    p.add_argument("--backtest-days", type=int, default=365)
    p.add_argument("--backtest-top-k", type=int, default=25)
    p.add_argument("--skip-backtest", action="store_true")
    p.add_argument("--sweep-min-mags", default="", help="Comma-separated target floors, e.g. 3,4,5,6,7,8")
    p.add_argument("--sweep-out", type=Path, default=DEFAULT_SWEEP_OUT)
    args = p.parse_args()

    sweep_mags = parse_mag_list(args.sweep_min_mags) if args.sweep_min_mags else []
    fetch_min_mag = min([args.min_mag, *sweep_mags]) if sweep_mags else args.min_mag
    events = read_csv(args.csv) if args.csv.exists() else fetch_usgs(fetch_min_mag, YEARS)
    events = [e for e in events if e.mag >= fetch_min_mag]
    if len(events) < 100:
        raise RuntimeError(f"only {len(events)} events available; need a larger catalog")

    if sweep_mags:
        print(f"Running magnitude sweep: {', '.join('M' + str(m).rstrip('0').rstrip('.') + '+' for m in sweep_mags)}")
        sweep = run_sweep(events, sweep_mags, args.max_rows, args.backtest_days, args.backtest_top_k)
        args.sweep_out.parent.mkdir(parents=True, exist_ok=True)
        args.sweep_out.write_text(json.dumps(sweep, separators=(",", ":")), encoding="utf-8")
        print(f"Wrote {args.sweep_out}")

    events = [e for e in events if e.mag >= args.min_mag]

    if not args.skip_backtest:
        print(f"Backtesting latest {args.backtest_days} days with top-{args.backtest_top_k} capture")
        report = run_backtest(events, args.max_rows, args.backtest_days, args.backtest_top_k)
        args.backtest_out.parent.mkdir(parents=True, exist_ok=True)
        args.backtest_out.write_text(json.dumps(report, separators=(",", ":")), encoding="utf-8")
        print(
            "Backtest: "
            f"MAE={report['mae']} RMSE={report['rmse']} "
            f"P10-P90 coverage={report['coverageP10P90']} "
            f"below-P90={report['coverageBelowP90']} "
            f"topK capture={report['topKCapture']}"
        )

    x, y, cells, by_cell = build_training(events, args.max_rows)
    print(f"Training ensemble on {len(x):,} rows from {len(cells):,} active cells")
    model_name, model = make_point_model()
    model.fit(x, y)
    print("Training 10/50/90% quantile interval models")
    quantile_models = train_quantile_models(x, y)

    now_ms = events[-1].time
    scored = []
    for cell in cells:
        evs = by_cell[cell]
        row = np.asarray([feature_row(cell, now_ms, evs)], dtype=np.float32)
        point_rate, q10, q50, q90, forecast_score = predict_interval(row, model, quantile_models)
        recent = [e for e in evs if now_ms - e.time <= 365 * DAY_MS] or evs[-20:]
        mags = np.asarray([e.mag for e in recent], dtype=float)
        depths = np.asarray([e.depth for e in recent], dtype=float)
        lat, lon = cell_center(cell)
        mag50 = float(np.percentile(mags, 50))
        mag90 = float(np.percentile(mags, 90))
        dep50 = float(np.percentile(depths, 50))
        dep90 = float(np.percentile(depths, 90))
        scored.append({
            "lat": round(lat, 3),
            "lon": round(lon, 3),
            "cellDeg": CELL_DEG,
            "rate30": round(q50, 4),
            "rate30Point": round(max(0.0, point_rate), 4),
            "rate30P10": round(q10, 4),
            "rate30P50": round(q50, 4),
            "rate30P90": round(q90, 4),
            "forecastScore": round(forecast_score, 4),
            "mag50": round(mag50, 2),
            "mag90": round(mag90, 2),
            "depth50": round(dep50, 1),
            "depth90": round(dep90, 1),
            "mmi50": mmi_label(intensity_value(mag50, dep50)),
            "mmi90": mmi_label(intensity_value(mag90, dep50)),
            "nRecent": len(recent),
        })

    scored.sort(key=lambda r: r["forecastScore"], reverse=True)
    artifact = {
        "kind": model_name + "-earthquake-forecast",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "catalogNewest": datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(),
        "horizonDays": HORIZON_DAYS,
        "minMag": args.min_mag,
        "cellDeg": CELL_DEG,
        "cells": scored[: args.top_cells],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {args.out} with {len(artifact['cells'])} forecast cells")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
