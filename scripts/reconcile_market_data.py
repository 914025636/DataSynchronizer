#!/usr/bin/env python3
"""Reconcile a bounded market-data window without modifying raw tables."""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

from audit_market_data import connect_questdb
from check_mysql_table_latest_update import connect_mysql, load_env_file
from data_reconciliation.ccxt_trades import SUPPORTED_EXCHANGES, TradeFetchError, create_exchange, fetch_trade_window
from data_reconciliation.models import QualityInterval, QualityStatus
from data_reconciliation.mysql_audit import audit_mysql_window
from data_reconciliation.orderbook_quality import classify_orderbook_intervals, clip_quality_intervals
from data_reconciliation.questdb_store import (
    ensure_reconciliation_tables,
    fetch_orderbook_frames,
    fetch_trades,
    insert_quality_intervals,
    insert_repairs,
)
from data_reconciliation.reporting import write_report
from data_reconciliation.trade_reconcile import reconcile_trades


EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE = 2
EXIT_UNRECOVERABLE = 3
EXIT_RUNTIME = 4


def parse_utc_milliseconds(value: str) -> int:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Invalid RFC 3339 timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("Timestamp must include a timezone")
    return int(parsed.astimezone(timezone.utc).timestamp() * 1000)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconcile QuestDB trades and classify orderbook quality")
    parser.add_argument("--start", required=True, type=parse_utc_milliseconds)
    parser.add_argument("--end", required=True, type=parse_utc_milliseconds)
    parser.add_argument("--exchange", required=True, choices=sorted(SUPPORTED_EXCHANGES))
    parser.add_argument("--symbol", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Read and report only (default)")
    mode.add_argument("--apply", action="store_true", help="Write companion repair and quality tables")
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--output-dir", default="reports/data-reconciliation")
    parser.add_argument("--page-limit", type=int)
    parser.add_argument("--max-pages", type=int, default=100)
    parser.add_argument("--ccxt-params-json", default="{}")
    parser.add_argument("--skip-orderbook", action="store_true")
    parser.add_argument("--skip-mysql-audit", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.start >= args.end:
        parser.error("--start must be earlier than --end")
    if args.max_pages <= 0 or (args.page_limit is not None and args.page_limit <= 0):
        parser.error("page limits must be positive")
    try:
        ccxt_params = json.loads(args.ccxt_params_json)
        if not isinstance(ccxt_params, dict):
            raise ValueError("must be an object")
    except (json.JSONDecodeError, ValueError) as exc:
        parser.error(f"--ccxt-params-json {exc}")

    environment = load_env_file(args.env_file)
    environment.update(os.environ)
    client = None
    exchange_api = None
    run_id = str(uuid.uuid4())
    try:
        exchange_api = create_exchange(args.exchange, environment.get("CCXT_HTTPS_PROXY"))
        fetched = fetch_trade_window(
            exchange_api,
            args.exchange,
            args.symbol,
            args.start,
            args.end,
            args.page_limit,
            args.max_pages,
            ccxt_params,
        )
        client = connect_questdb(
            environment.get("QUESTDB_SQL_HOST", environment.get("QUESTDB_HOST", "127.0.0.1")),
            int(environment.get("QUESTDB_SQL_PORT", "18812")),
            environment.get("QUESTDB_SQL_USER", "admin"),
            environment.get("QUESTDB_SQL_PASSWORD", "quest"),
            environment.get("QUESTDB_SQL_DATABASE", "qdb"),
        )
        stored = fetch_trades(client, args.exchange, args.symbol, args.start, args.end)
        reconciliation = reconcile_trades(fetched.trades, stored)
        frames = () if args.skip_orderbook else fetch_orderbook_frames(client, args.exchange, args.symbol, args.start, args.end)
        if args.skip_orderbook:
            intervals = ()
        elif frames:
            intervals = clip_quality_intervals(classify_orderbook_intervals(frames), args.start, args.end)
        else:
            intervals = (QualityInterval(args.start, args.end, QualityStatus.UNRECOVERABLE, "no_orderbook_data"),)
        mysql_findings = []
        if not args.skip_mysql_audit:
            mysql_targets = [
                (
                    environment.get("MYSQL_HOST", "127.0.0.1"),
                    int(environment.get("MYSQL_PORT", "3306")),
                    environment.get("MYSQL_USER", ""),
                    environment.get("MYSQL_PASS", ""),
                    environment.get("MYSQL_DB"),
                ),
                (
                    environment.get("MYSQL_HOST_EXCHANGE", environment.get("MYSQL_HOST", "127.0.0.1")),
                    int(environment.get("MYSQL_PORT_EXCHANGE", environment.get("MYSQL_PORT", "3306"))),
                    environment.get("MYSQL_USER_EXCHANGE", environment.get("MYSQL_USER", "")),
                    environment.get("MYSQL_PASS_EXCHANGE", environment.get("MYSQL_PASS", "")),
                    environment.get("MYSQL_DB_EXCHANGE"),
                ),
            ]
            scanned = set()
            for host, port, user, password, database in mysql_targets:
                target = (host, port, user, database)
                if not database or target in scanned:
                    continue
                scanned.add(target)
                mysql_client = connect_mysql(host, port, user, password)
                try:
                    mysql_findings.append(audit_mysql_window(mysql_client, database, args.exchange, args.symbol, args.start, args.end))
                finally:
                    mysql_client.close()
        has_unrecoverable = any(item.status == QualityStatus.UNRECOVERABLE for item in intervals)
        has_suspect = any(item.status == QualityStatus.SUSPECT for item in intervals)
        can_apply = fetched.evidence.source_complete and not reconciliation.conflicts
        inserted_repairs = 0
        inserted_intervals = 0
        if args.apply:
            if not can_apply:
                raise TradeFetchError("Apply refused because source completeness or trade identity could not be proven")
            ensure_reconciliation_tables(client)
            inserted_repairs = insert_repairs(client, reconciliation.missing, run_id)
            inserted_intervals = insert_quality_intervals(client, args.exchange, args.symbol, intervals, run_id)

        summary: Dict[str, Any] = {
            "run_id": run_id,
            "mode": "apply" if args.apply else "dry-run",
            "window": {"start_ms": args.start, "end_ms": args.end},
            "exchange": args.exchange,
            "symbol": args.symbol,
            "fetch": asdict(fetched.evidence),
            "trades": {
                "stored": len(stored),
                "existing": len(reconciliation.existing),
                "missing": len(reconciliation.missing),
                "source_duplicates": len(reconciliation.source_duplicates),
                "conflicts": len(reconciliation.conflicts),
                "inserted_repairs": inserted_repairs,
            },
            "orderbook": {"frames": len(frames), "intervals": len(intervals), "inserted_intervals": inserted_intervals},
            "mysql": mysql_findings,
        }
        json_path, csv_path = write_report(summary, intervals, Path(args.output_dir))
        print(json.dumps(summary, indent=2, default=str))
        print(f"JSON report: {json_path}")
        print(f"CSV report:  {csv_path}")

        if not fetched.evidence.source_complete or reconciliation.conflicts or has_unrecoverable:
            return EXIT_UNRECOVERABLE
        if (not args.apply and reconciliation.missing) or has_suspect:
            return EXIT_FINDINGS
        return EXIT_OK
    except TradeFetchError as exc:
        print(f"UNRECOVERABLE: {exc}", file=sys.stderr)
        return EXIT_UNRECOVERABLE
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return EXIT_RUNTIME
    finally:
        if client is not None:
            client.close()
        close = getattr(exchange_api, "close", None)
        if close:
            close()


if __name__ == "__main__":
    raise SystemExit(main())