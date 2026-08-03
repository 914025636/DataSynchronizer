#!/usr/bin/env python3
"""Read-only data-quality audit for MySQL market tables and QuestDB."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from check_mysql_table_latest_update import (
    DBClient,
    connect_mysql,
    escape_identifier,
    list_columns,
    list_tables,
    load_env_file,
)
from data_reconciliation.questdb_table_names import questdb_market_tables, quote_identifier


CANDLE_COLUMNS = {"time", "open", "high", "low", "close", "volume"}
ORDERBOOK_COLUMNS = {"time", "orderbook"}
INTERVAL_SECONDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "8h": 28800,
    "12h": 43200,
    "24h": 86400,
}


@dataclass
class AuditResult:
    source: str
    database: str
    table: str
    check: str
    status: str
    count: Optional[int]
    details: str


def classify_mysql_table(columns: Sequence[Tuple[str, str]]) -> Optional[str]:
    names = {name.lower() for name, _ in columns}
    if CANDLE_COLUMNS.issubset(names):
        return "candlestick"
    if ORDERBOOK_COLUMNS.issubset(names):
        return "orderbook"
    return None


def interval_milliseconds_from_table(table: str) -> Optional[int]:
    match = re.search(r"_(1m|3m|5m|15m|30m|1h|2h|4h|8h|12h|24h)$", table, re.IGNORECASE)
    if not match:
        return None
    return INTERVAL_SECONDS[match.group(1).lower()] * 1000


def is_valid_candle(open_price: Any, high: Any, low: Any, close: Any, volume: Any) -> bool:
    try:
        values = [float(open_price), float(high), float(low), float(close), float(volume)]
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(value) for value in values):
        return False
    open_value, high_value, low_value, close_value, volume_value = values
    return (
        open_value > 0
        and close_value > 0
        and low_value > 0
        and volume_value >= 0
        and low_value <= min(open_value, close_value)
        and max(open_value, close_value) <= high_value
    )


def validate_orderbook_payload(payload: Any) -> Optional[str]:
    try:
        value = json.loads(payload) if isinstance(payload, str) else payload
    except (TypeError, json.JSONDecodeError) as exc:
        return f"invalid JSON: {exc}"
    if not isinstance(value, dict):
        return "root must be an object"

    best: Dict[str, Optional[float]] = {"asks": None, "bids": None}
    for side in ("asks", "bids"):
        levels = value.get(side)
        if not isinstance(levels, list):
            return f"{side} must be an array"
        prices = set()
        parsed_prices: List[float] = []
        for level in levels:
            if not isinstance(level, (list, tuple)) or len(level) < 2:
                return f"{side} contains an invalid level"
            try:
                price = float(level[0])
                quantity = float(level[1])
            except (TypeError, ValueError):
                return f"{side} contains a non-numeric level"
            if not math.isfinite(price) or not math.isfinite(quantity) or price <= 0 or quantity < 0:
                return f"{side} contains an invalid price or quantity"
            if price in prices:
                return f"{side} contains duplicate price levels"
            prices.add(price)
            parsed_prices.append(price)
        if parsed_prices:
            best[side] = min(parsed_prices) if side == "asks" else max(parsed_prices)

    if best["asks"] is not None and best["bids"] is not None and best["bids"] >= best["asks"]:
        return "crossed orderbook"
    return None


def result(source: str, database: str, table: str, check: str, count: int, details: str = "") -> AuditResult:
    return AuditResult(source, database, table, check, "pass" if count == 0 else "fail", count, details)


def audit_mysql_table(client: DBClient, database: str, table: str, kind: str) -> List[AuditResult]:
    qualified = f"{escape_identifier(database)}.{escape_identifier(table)}"
    rows = client.query(f"SELECT COUNT(*), MIN(time), MAX(time) FROM {qualified}")
    row_count, minimum_time, maximum_time = rows[0] if rows else (0, None, None)
    findings = [
        AuditResult("mysql", database, table, "summary", "info", int(row_count), f"time={minimum_time}..{maximum_time}"),
    ]

    duplicate_rows = client.query(
        f"SELECT COALESCE(SUM(duplicates), 0) FROM ("
        f"SELECT COUNT(*) - 1 AS duplicates FROM {qualified} GROUP BY time HAVING COUNT(*) > 1"
        f") AS duplicate_groups"
    )
    findings.append(result("mysql", database, table, "duplicate_time", int(duplicate_rows[0][0])))

    if kind == "candlestick":
        invalid_rows = client.query(
            f"SELECT COUNT(*) FROM {qualified} WHERE "
            "open <= 0 OR high <= 0 OR low <= 0 OR close <= 0 OR volume < 0 "
            "OR low > LEAST(open, close) OR high < GREATEST(open, close)"
        )
        findings.append(result("mysql", database, table, "invalid_ohlcv", int(invalid_rows[0][0])))
        interval_ms = interval_milliseconds_from_table(table)
        if interval_ms is None:
            findings.append(AuditResult("mysql", database, table, "missing_candles", "warn", None, "interval not recognized from table name"))
        else:
            gap_rows = client.query(
                f"SELECT COUNT(*), COALESCE(SUM((next_time - time) DIV {interval_ms} - 1), 0) FROM ("
                f"SELECT time, LEAD(time) OVER (ORDER BY time) AS next_time FROM {qualified}"
                ") AS ordered WHERE next_time IS NOT NULL AND next_time - time > %s",
                (interval_ms,),
            )[0]
            gap_count, missing_count = int(gap_rows[0]), int(gap_rows[1])
            findings.append(result("mysql", database, table, "missing_candles", missing_count, f"gap_ranges={gap_count}; interval_ms={interval_ms}"))
        return findings

    invalid_payloads = 0
    samples: List[str] = []
    cursor = client.connection.cursor()
    try:
        cursor.execute(f"SELECT time, orderbook FROM {qualified}")
        while True:
            batch = cursor.fetchmany(1000)
            if not batch:
                break
            for timestamp, payload in batch:
                error = validate_orderbook_payload(payload)
                if error:
                    invalid_payloads += 1
                    if len(samples) < 5:
                        samples.append(f"{timestamp}: {error}")
    finally:
        cursor.close()
    findings.append(result("mysql", database, table, "invalid_orderbook", invalid_payloads, "; ".join(samples)))
    return findings


def audit_mysql(client: DBClient, databases: Sequence[str]) -> List[AuditResult]:
    findings: List[AuditResult] = []
    for database in databases:
        for table in list_tables(client, database):
            kind = classify_mysql_table(list_columns(client, database, table))
            if kind:
                findings.extend(audit_mysql_table(client, database, table, kind))
    return findings


def connect_questdb(host: str, port: int, user: str, password: str, database: str) -> DBClient:
    try:
        import psycopg  # type: ignore
    except ImportError:
        try:
            import psycopg2  # type: ignore
        except ImportError as exc:
            raise RuntimeError("Install psycopg or psycopg2-binary to audit QuestDB") from exc
        connection = psycopg2.connect(host=host, port=port, user=user, password=password, dbname=database, connect_timeout=10)
        return DBClient(connection, "psycopg2")

    connection = psycopg.connect(host=host, port=port, user=user, password=password, dbname=database, connect_timeout=10)
    return DBClient(connection, "psycopg")


def audit_questdb_table(client: DBClient, table: str, kind: str) -> List[AuditResult]:
    identifier = quote_identifier(table)
    summary = client.query(f"SELECT count(), min(timestamp), max(timestamp) FROM {identifier}")[0]
    findings = [AuditResult("questdb", "qdb", table, "summary", "info", int(summary[0]), f"time={summary[1]}..{summary[2]}")]
    if kind == "trades":
        invalid_numeric = client.query(
            f"SELECT count() FROM {identifier} WHERE price <= 0 OR quantity <= 0 OR price != price OR quantity != quantity"
        )[0][0]
        invalid_trade_id = client.query(
            f"SELECT count() FROM {identifier} WHERE trade_id IS NULL OR trade_id = '' OR trade_id = 'undefined'"
        )[0][0]
        invalid_side = client.query(f"SELECT count() FROM {identifier} WHERE side NOT IN ('buy', 'sell')")[0][0]
        duplicate = client.query(
            "SELECT COALESCE(sum(duplicates), 0) FROM ("
            f"SELECT count() - 1 duplicates FROM {identifier} "
            "GROUP BY timestamp, exchange, symbol, side, price, quantity, trade_id)"
        )[0][0]
        findings.append(result("questdb", "qdb", table, "invalid_price_quantity", int(invalid_numeric)))
        findings.append(result("questdb", "qdb", table, "invalid_trade_id", int(invalid_trade_id)))
        findings.append(result("questdb", "qdb", table, "invalid_side", int(invalid_side)))
        findings.append(result("questdb", "qdb", table, "exact_duplicate", int(duplicate)))
    else:
        invalid = client.query(
            f"SELECT count() FROM {identifier} WHERE price <= 0 OR qty < 0 "
            "OR price != price OR qty != qty OR side NOT IN ('ask', 'bid') "
            "OR update_type NOT IN ('snapshot', 'delta')"
        )[0][0]
        zero_sequence = client.query(f"SELECT count() FROM {identifier} WHERE sequence = 0")[0][0]
        findings.append(result("questdb", "qdb", table, "invalid_orderbook_delta", int(invalid)))
        findings.append(AuditResult("questdb", "qdb", table, "zero_sequence", "warn" if zero_sequence else "pass", int(zero_sequence), "zero may mean missing sequence"))
    return findings


def audit_questdb(client: DBClient) -> List[AuditResult]:
    tables = {str(row[0]) for row in client.query("SELECT table_name FROM tables()")}
    findings: List[AuditResult] = []
    if "market_data_catalog" not in tables:
        return [AuditResult("questdb", "qdb", "market_data_catalog", "table_exists", "fail", 1, "table not found")]

    catalog_rows = client.query(
        "SELECT exchange, symbol, trades_table, orderbook_delta_table FROM market_data_catalog "
        "LATEST ON timestamp PARTITION BY exchange, symbol"
    )
    for exchange, symbol, trades_table, orderbook_table in catalog_rows:
        expected = questdb_market_tables(str(exchange), str(symbol))
        routes = ((str(trades_table), expected.trades_table, "trades"), (str(orderbook_table), expected.orderbook_delta_table, "orderbook_delta"))
        for table, expected_table, kind in routes:
            if table != expected_table:
                findings.append(AuditResult("questdb", "qdb", table, "catalog_route", "fail", 1, f"expected {expected_table}"))
            elif table not in tables:
                findings.append(AuditResult("questdb", "qdb", table, "table_exists", "fail", 1, "table not found"))
            else:
                findings.extend(audit_questdb_table(client, table, kind))

    for legacy_table in ("trades", "orderbook_delta"):
        if legacy_table in tables:
            findings.append(AuditResult("questdb", "qdb", legacy_table, "legacy_table", "info", None, "read-only; excluded from current market audit"))
    return findings


def write_reports(findings: Sequence[AuditResult], output_dir: Path) -> Tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = output_dir / f"market-data-audit-{stamp}.json"
    csv_path = output_dir / f"market-data-audit-{stamp}.csv"
    records = [asdict(item) for item in findings]
    json_path.write_text(json.dumps(records, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(asdict(AuditResult("", "", "", "", "", None, "")).keys()))
        writer.writeheader()
        writer.writerows(records)
    return json_path, csv_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only audit for MySQL market tables and QuestDB")
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--output-dir", default="reports/data-quality")
    parser.add_argument("--skip-mysql", action="store_true")
    parser.add_argument("--skip-questdb", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    environment = load_env_file(args.env_file)
    environment.update(os.environ)
    findings: List[AuditResult] = []

    if not args.skip_mysql:
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
        scanned_targets = set()
        for host, port, user, password, database in mysql_targets:
            target = (host, port, user, database)
            if not database or target in scanned_targets:
                continue
            scanned_targets.add(target)
            try:
                mysql_client = connect_mysql(host, port, user, password)
                findings.extend(audit_mysql(mysql_client, [database]))
                mysql_client.close()
            except Exception as exc:
                findings.append(AuditResult("mysql", database, "", "connection", "error", None, str(exc)))

    if not args.skip_questdb:
        try:
            questdb_client = connect_questdb(
                environment.get("QUESTDB_SQL_HOST", environment.get("QUESTDB_HOST", "127.0.0.1")),
                int(environment.get("QUESTDB_SQL_PORT", "18812")),
                environment.get("QUESTDB_SQL_USER", "admin"),
                environment.get("QUESTDB_SQL_PASSWORD", "quest"),
                environment.get("QUESTDB_SQL_DATABASE", "qdb"),
            )
            findings.extend(audit_questdb(questdb_client))
            questdb_client.close()
        except Exception as exc:
            findings.append(AuditResult("questdb", "qdb", "", "connection", "error", None, str(exc)))

    json_path, csv_path = write_reports(findings, Path(args.output_dir))
    for item in findings:
        print(f"{item.status.upper():5} {item.source:7} {item.table:32} {item.check:24} {item.count if item.count is not None else '-'} {item.details}")
    print(f"JSON report: {json_path}")
    print(f"CSV report:  {csv_path}")
    return 1 if any(item.status in {"fail", "error"} for item in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())