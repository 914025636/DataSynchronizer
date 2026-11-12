#!/usr/bin/env python3
"""Read-only quality check of one recording window in QuestDB.

Trades are checked for raw trade ID continuity and against Binance aggTrades
(each aggregate trade names its first and last raw trade ID). Orderbook deltas
are replayed from the last snapshot before the window to verify the delta chain.
"""

from __future__ import annotations

import argparse
import io
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import numpy as np
import pandas as pd
import requests

from check_mysql_table_latest_update import load_env_file


PRICE_BAND = 0.002  # trades further than 0.2% outside the persisted best bid/ask are flagged
PAD_US = 5_000_000  # raw trades of one aggregate can carry later timestamps than the aggregate itself
AGG_TRADE_URLS = {
    False: "https://api.binance.com/api/v3/aggTrades",
    True: "https://fapi.binance.com/fapi/v1/aggTrades",
}


def parse_utc_microseconds(value: str) -> int:
    parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("Timestamp must include a timezone")
    return int(parsed.astimezone(timezone.utc).timestamp() * 1_000_000)


def iso(microseconds: int) -> str:
    return datetime.fromtimestamp(microseconds / 1_000_000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class QuestDB:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.trust_env = False

    def frame(self, query: str) -> pd.DataFrame:
        response = self.session.get(f"{self.base_url}/exp", params={"query": query}, timeout=120)
        response.raise_for_status()
        return pd.read_csv(io.StringIO(response.text))

    def rows(self, query: str) -> List[List[Any]]:
        response = self.session.get(f"{self.base_url}/exec", params={"query": query}, timeout=120)
        payload = response.json()
        if "error" in payload:
            raise RuntimeError(f"{payload['error']} in: {query}")
        return payload["dataset"]


def id_ranges(ids: np.ndarray, limit: int = 10) -> List[str]:
    """Missing ID ranges between consecutive present IDs."""
    steps = np.diff(ids)
    gaps = np.nonzero(steps > 1)[0]
    return [f"{ids[i] + 1}-{ids[i + 1] - 1}" for i in gaps[:limit]]


def check_trades(trades: pd.DataFrame) -> Dict[str, Any]:
    result: Dict[str, Any] = {"rows": len(trades)}
    if trades.empty:
        return result
    ids = pd.to_numeric(trades["trade_id"], errors="coerce")
    result["invalid_trade_id"] = int(ids.isna().sum())
    result["invalid_price_quantity"] = int(
        (trades["price"].isna() | trades["quantity"].isna() | (trades["price"] <= 0) | (trades["quantity"] <= 0)).sum()
    )
    result["invalid_side"] = int((~trades["side"].isin(["buy", "sell"])).sum())
    valid = ids.dropna().astype("int64")
    result["duplicate_trade_id"] = int(valid.duplicated().sum())
    unique = np.unique(valid.to_numpy())
    result["first_trade_id"] = int(unique[0])
    result["last_trade_id"] = int(unique[-1])
    result["missing_ids_inside_range"] = int(unique[-1] - unique[0] + 1 - len(unique))
    result["missing_id_ranges"] = id_ranges(unique)

    by_id = trades.assign(id=ids).dropna(subset=["id"]).sort_values("id")
    result["ts_regressions_by_trade_id"] = int((by_id["ts"].diff() < 0).sum())
    times = np.sort(trades["ts"].to_numpy())
    result["first_ts"] = iso(int(times[0]))
    result["last_ts"] = iso(int(times[-1]))
    result["max_gap_seconds"] = round(float(np.diff(times).max()) / 1_000_000, 3) if len(times) > 1 else None
    minutes = pd.Series(times // 60_000_000 * 60_000_000)
    result["rows_per_minute"] = {iso(int(k))[11:16]: int(v) for k, v in minutes.value_counts().sort_index().items()}
    return result


def fetch_json(url: str, params: Dict[str, Any], proxy: Optional[str]) -> Any:
    # curl (Schannel) is used because Python TLS handshakes through the local proxy are aborted on this host
    command = ["curl", "-s", "--fail", "--max-time", "30", f"{url}?{urlencode(params)}"]
    if proxy:
        command[1:1] = ["--proxy", proxy]
    completed = subprocess.run(command, capture_output=True, text=True, check=True)
    return json.loads(completed.stdout)


def fetch_agg_trades(proxy: Optional[str], market_id: str, futures: bool, start_ms: int, end_ms: int) -> List[Dict[str, Any]]:
    url = AGG_TRADE_URLS[futures]
    params: Dict[str, Any] = {"symbol": market_id, "startTime": start_ms, "endTime": end_ms - 1, "limit": 1000}
    collected: List[Dict[str, Any]] = []
    while True:
        page = fetch_json(url, params, proxy)
        collected.extend(item for item in page if start_ms <= item["T"] < end_ms)
        if len(page) < 1000 or page[-1]["T"] >= end_ms:
            return collected
        # startTime/endTime cap a page at the first 1000 rows; continue by aggregate ID
        params = {"symbol": market_id, "fromId": page[-1]["a"] + 1, "limit": 1000}
        time.sleep(0.05)


def compare_with_agg_trades(trades: pd.DataFrame, aggs: List[Dict[str, Any]], start_us: int, end_us: int) -> Dict[str, Any]:
    """Both inputs cover a padded window; aggregates are judged by their time, stored rows by theirs."""
    stored = {
        int(row.trade_id): (int(row.ts), float(row.price), float(row.quantity), str(row.side))
        for row in trades.dropna(subset=["trade_id"]).itertuples(index=False)
    }
    covered = set()
    for agg in aggs:
        covered.update(range(int(agg["f"]), int(agg["l"]) + 1))
    window_aggs = [agg for agg in aggs if start_us <= agg["T"] * 1000 < end_us]

    expected = absent = absent_quantity_complete = price_mismatch = side_mismatch = 0
    short_aggs: List[int] = []
    excess_aggs: List[int] = []
    offsets_ms: List[float] = []
    for agg in window_aggs:
        first, last = int(agg["f"]), int(agg["l"])
        price, quantity = float(agg["p"]), float(agg["q"])
        side = "sell" if agg["m"] else "buy"  # buyer is maker, so the taker sold
        expected += last - first + 1
        present = [stored[trade_id] for trade_id in range(first, last + 1) if trade_id in stored]
        missing = last - first + 1 - len(present)
        absent += missing
        price_mismatch += sum(1 for row in present if abs(row[1] - price) > 1e-9 * price)
        side_mismatch += sum(1 for row in present if row[3] != side)
        shortfall = quantity - sum(row[2] for row in present)
        if shortfall > 1e-9 + 1e-9 * quantity:
            short_aggs.append(first)
        elif shortfall < -(1e-9 + 1e-9 * quantity):
            excess_aggs.append(first)
        else:
            # Raw IDs inside an aggregate that the public trade stream never carries
            absent_quantity_complete += missing
        if first in stored:
            offsets_ms.append((stored[first][0] - agg["T"] * 1000) / 1000)

    extra = [
        trade_id for trade_id, row in stored.items() if start_us <= row[0] < end_us and trade_id not in covered
    ]
    offsets = np.array(offsets_ms)
    return {
        "agg_trades": len(window_aggs),
        "exchange_raw_ids": expected,
        "ids_absent": absent,
        "ids_absent_but_agg_quantity_complete": absent_quantity_complete,
        "aggs_with_quantity_shortfall": len(short_aggs),
        "shortfall_sample_first_ids": short_aggs[:20],
        "aggs_with_excess_quantity": len(excess_aggs),
        "stored_not_in_exchange_aggs": len(extra),
        "extra_sample_ids": sorted(extra)[:20],
        "price_mismatch": price_mismatch,
        "side_mismatch": side_mismatch,
        "first_trade_ts_minus_agg_time_ms": {
            "compared": len(offsets),
            "zero": int((offsets == 0).sum()),
            "min": float(offsets.min()),
            "median": float(np.median(offsets)),
            "p99": float(np.percentile(offsets, 99)),
            "max": float(offsets.max()),
        }
        if len(offsets)
        else None,
    }


def level_difference(left: Dict[str, Dict[float, float]], right: Dict[str, Dict[float, float]]) -> int:
    return sum(len(set(left[side].items()) ^ set(right[side].items())) for side in ("ask", "bid"))


def check_orderbook(
    rows: pd.DataFrame, start_us: int, end_us: int, expected_depth: int
) -> Tuple[Dict[str, Any], pd.DataFrame]:
    window = rows[(rows["ts"] >= start_us) & (rows["ts"] < end_us)]
    result: Dict[str, Any] = {
        "rows": len(window),
        "invalid_levels": int(
            (window["price"].isna() | window["qty"].isna() | (window["price"] <= 0) | (window["qty"] < 0)).sum()
        ),
        "snapshot_rows_with_zero_qty": int(((window["update_type"] == "snapshot") & (window["qty"] == 0)).sum()),
        "invalid_update_type": int((~window["update_type"].isin(["snapshot", "delta"])).sum()),
        "invalid_side": int((~window["side"].isin(["ask", "bid"])).sum()),
    }
    book: Optional[Dict[str, Dict[float, float]]] = None
    deltas_before_snapshot = mixed_frames = noop_deltas = removed_missing = 0
    crossed = empty_side = depth_off = sequence_regressions = zero_sequence = 0
    previous_sequence: Optional[float] = None
    frame_times: List[int] = []
    snapshot_times: List[int] = []
    snapshot_drift: List[int] = []
    delta_sizes: List[int] = []
    spreads: List[float] = []
    depth_seen: List[int] = []
    best: List[Tuple[int, float, float]] = []

    for ts, frame in rows.groupby("ts", sort=True):
        ts = int(ts)
        in_window = start_us <= ts < end_us
        kinds = set(frame["update_type"])
        mixed_frames += int(in_window and len(kinds) > 1)
        if "snapshot" in kinds:
            snapshot: Dict[str, Dict[float, float]] = {"ask": {}, "bid": {}}
            for level in frame[frame["update_type"] == "snapshot"].itertuples(index=False):
                snapshot[level.side][float(level.price)] = float(level.qty)
            if book is not None and in_window:
                # A snapshot carries one more second of changes than the replayed book
                snapshot_drift.append(level_difference(book, snapshot))
            book = snapshot
            if in_window:
                snapshot_times.append(ts)
        elif book is None:
            deltas_before_snapshot += len(frame)
            continue
        else:
            for level in frame.itertuples(index=False):
                levels = book[level.side]
                price, qty = float(level.price), float(level.qty)
                if qty == 0:
                    if price in levels:
                        del levels[price]
                    elif in_window:
                        removed_missing += 1
                else:
                    if in_window and levels.get(price) == qty:
                        noop_deltas += 1
                    levels[price] = qty
            if in_window:
                delta_sizes.append(len(frame))

        if not in_window:
            continue
        frame_times.append(ts)
        sequence = float(frame["sequence"].max())
        zero_sequence += int(sequence == 0)
        if previous_sequence is not None and sequence < previous_sequence:
            sequence_regressions += 1
        previous_sequence = sequence
        asks, bids = book["ask"], book["bid"]
        depth_seen.extend((len(asks), len(bids)))
        depth_off += int(len(asks) != expected_depth or len(bids) != expected_depth)
        if not asks or not bids:
            empty_side += 1
            continue
        best_ask, best_bid = min(asks), max(bids)
        crossed += int(best_bid >= best_ask)
        spreads.append((best_ask - best_bid) / ((best_ask + best_bid) / 2) * 10_000)
        best.append((ts, best_bid, best_ask))

    window_seconds = (end_us - start_us) / 1_000_000
    gaps = np.diff(np.array(frame_times)) / 1_000_000 if len(frame_times) > 1 else np.array([])
    result.update(
        {
            "frames": len(frame_times),
            "seconds_covered_pct": round(len(frame_times) / window_seconds * 100, 2),
            "max_frame_gap_seconds": float(gaps.max()) if len(gaps) else None,
            "frame_gaps_over_2s": [
                f"{iso(frame_times[i])[11:19]}+{gaps[i]:.0f}s" for i in np.nonzero(gaps > 2)[0][:20]
            ],
            "snapshots": len(snapshot_times),
            "snapshot_intervals_seconds": sorted(set(np.diff(snapshot_times) // 1_000_000)) if len(snapshot_times) > 1 else [],
            "deltas_before_first_snapshot": deltas_before_snapshot,
            "mixed_snapshot_delta_frames": mixed_frames,
            "noop_delta_levels": noop_deltas,
            "removed_levels_not_in_book": removed_missing,
            "frames_with_depth_not_expected": depth_off,
            "depth_min_max": [min(depth_seen), max(depth_seen)] if depth_seen else None,
            "empty_side_frames": empty_side,
            "crossed_frames": crossed,
            "spread_bps_median_max": [round(median(spreads), 3), round(max(spreads), 3)] if spreads else None,
            "delta_levels_per_frame_median": median(delta_sizes) if delta_sizes else None,
            "delta_levels_per_frame_max": max(delta_sizes) if delta_sizes else None,
            "snapshot_vs_replayed_level_diff": snapshot_drift,
            "sequence_regressions": sequence_regressions,
            "zero_sequence_frames": zero_sequence,
        }
    )
    return result, pd.DataFrame(best, columns=["ts", "best_bid", "best_ask"])


def check_trades_against_book(trades: pd.DataFrame, best: pd.DataFrame) -> Dict[str, Any]:
    if trades.empty or best.empty:
        return {}
    merged = pd.merge_asof(trades.sort_values("ts"), best.sort_values("ts"), on="ts", direction="backward").dropna(
        subset=["best_bid"]
    )
    low = merged["best_bid"] * (1 - PRICE_BAND)
    high = merged["best_ask"] * (1 + PRICE_BAND)
    outside = merged[(merged["price"] < low) | (merged["price"] > high)]
    return {"trades_compared": len(merged), "trades_outside_book_band": len(outside)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--start", required=True, type=parse_utc_microseconds)
    parser.add_argument("--end", required=True, type=parse_utc_microseconds)
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--questdb", default="http://127.0.0.1:9000")
    parser.add_argument("--skip-exchange", action="store_true", help="Do not fetch Binance aggTrades")
    parser.add_argument("--output-dir", default="reports/data-quality")
    args = parser.parse_args()

    environment = load_env_file(args.env_file)
    proxy = environment.get("CCXT_SOCKS_PROXY_BINANCE")
    expected_depth = int(environment.get("CCXT_ORDERBOOK_DEPTH", "500"))
    questdb = QuestDB(args.questdb)

    start, end = iso(args.start), iso(args.end)
    markets = questdb.rows(
        "select distinct exchange, symbol, trades_table, orderbook_delta_table from market_data_catalog order by symbol"
    )
    report: Dict[str, Any] = {"window": {"start": start, "end": end}, "markets": {}}
    for exchange, symbol, trades_table, orderbook_table in markets:
        market: Dict[str, Any] = {"trades_table": trades_table, "orderbook_table": orderbook_table}
        padded = questdb.frame(
            f"select cast(ts as long) ts, side, price, quantity, trade_id from '{trades_table}' "
            f"where ts >= '{iso(args.start - PAD_US)}' and ts < '{iso(args.end + PAD_US)}'"
        )
        trades = padded[(padded["ts"] >= args.start) & (padded["ts"] < args.end)]
        market["trades"] = check_trades(trades)
        market["trades"]["latest_stored_ts"] = questdb.rows(f"select max(ts) from '{trades_table}'")[0][0]
        if exchange == "binance" and not args.skip_exchange:
            futures = ":" in symbol
            market_id = symbol.split(":")[0].replace("/", "")
            aggs = fetch_agg_trades(proxy, market_id, futures, (args.start - PAD_US) // 1000, (args.end + PAD_US) // 1000)
            market["trades"]["vs_binance_agg_trades"] = compare_with_agg_trades(padded, aggs, args.start, args.end)

        anchor = questdb.rows(
            f"select max(ts) from '{orderbook_table}' where update_type = 'snapshot' and ts < '{start}'"
        )[0][0] or start
        book_rows = questdb.frame(
            f"select cast(ts as long) ts, update_type, side, price, qty, sequence from '{orderbook_table}' "
            f"where ts >= '{anchor}' and ts < '{end}' order by ts"
        )
        market["orderbook"], best = check_orderbook(book_rows, args.start, args.end, expected_depth)
        market["orderbook"]["replay_anchor_snapshot"] = anchor
        market["trades"]["vs_orderbook"] = check_trades_against_book(trades, best)
        report["markets"][f"{exchange} {symbol}"] = market

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"window-{start[:19].replace(':', '')}.json"
    path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(json.dumps(report, indent=2, default=str))
    print(f"Report: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
