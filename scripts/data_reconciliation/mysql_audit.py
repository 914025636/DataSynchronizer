from __future__ import annotations

import json
import math
from typing import Any, Dict, Optional

from check_mysql_table_latest_update import DBClient, escape_identifier, list_columns, list_tables


def legacy_table_name(exchange: str, symbol: str, suffix: str) -> str:
    clean_symbol = symbol.replace("/", "").replace("-", "").replace("_", "")
    return f"{exchange}_{clean_symbol}_{suffix}".lower()


def audit_mysql_window(
    client: DBClient,
    database: str,
    exchange: str,
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> Dict[str, Any]:
    available = set(list_tables(client, database))
    return {
        "database": database,
        "trades": _audit_trade_table(
            client,
            database,
            legacy_table_name(exchange, symbol, "trades"),
            available,
            start_ms,
            end_ms,
        ),
        "orderbook": _audit_orderbook_table(
            client,
            database,
            legacy_table_name(exchange, symbol, "orderbook"),
            available,
            start_ms,
            end_ms,
        ),
    }


def _audit_trade_table(
    client: DBClient,
    database: str,
    table: str,
    available: set[str],
    start_ms: int,
    end_ms: int,
) -> Dict[str, Any]:
    if table not in available:
        return {"table": table, "exists": False}
    names = {name.lower() for name, _ in list_columns(client, database, table)}
    required = {"time", "side", "quantity", "price", "tradeid"}
    if not required.issubset(names):
        return {"table": table, "exists": True, "schema_valid": False}
    qualified = f"{escape_identifier(database)}.{escape_identifier(table)}"
    row = client.query(
        f"SELECT COUNT(*), MIN(time), MAX(time), "
        "SUM(CASE WHEN price <= 0 OR quantity <= 0 OR tradeId IS NULL OR tradeId = '' "
        "OR side NOT IN ('buy', 'sell') THEN 1 ELSE 0 END) "
        f"FROM {qualified} WHERE time >= %s AND time < %s",
        (start_ms, end_ms),
    )[0]
    duplicates = client.query(
        "SELECT COALESCE(SUM(duplicate_count), 0) FROM ("
        f"SELECT COUNT(*) - 1 duplicate_count FROM {qualified} WHERE time >= %s AND time < %s "
        "GROUP BY tradeId HAVING COUNT(*) > 1) duplicate_groups",
        (start_ms, end_ms),
    )[0][0]
    return {
        "table": table,
        "exists": True,
        "schema_valid": True,
        "rows": int(row[0]),
        "min_time": row[1],
        "max_time": row[2],
        "invalid_rows": int(row[3] or 0),
        "duplicate_trade_ids": int(duplicates or 0),
    }


def _audit_orderbook_table(
    client: DBClient,
    database: str,
    table: str,
    available: set[str],
    start_ms: int,
    end_ms: int,
) -> Dict[str, Any]:
    if table not in available:
        return {"table": table, "exists": False}
    names = {name.lower() for name, _ in list_columns(client, database, table)}
    if not {"time", "orderbook"}.issubset(names):
        return {"table": table, "exists": True, "schema_valid": False}
    qualified = f"{escape_identifier(database)}.{escape_identifier(table)}"
    cursor = client.connection.cursor()
    rows = 0
    invalid_rows = 0
    crossed_rows = 0
    try:
        cursor.execute(
            f"SELECT time, orderbook FROM {qualified} WHERE time >= %s AND time < %s ORDER BY time",
            (start_ms, end_ms),
        )
        while True:
            batch = cursor.fetchmany(1000)
            if not batch:
                break
            for _, payload in batch:
                rows += 1
                error = _validate_orderbook(payload)
                if error:
                    invalid_rows += 1
                    if error == "crossed_orderbook":
                        crossed_rows += 1
    finally:
        cursor.close()
    return {
        "table": table,
        "exists": True,
        "schema_valid": True,
        "rows": rows,
        "invalid_rows": invalid_rows,
        "crossed_rows": crossed_rows,
    }


def _validate_orderbook(payload: Any) -> Optional[str]:
    try:
        value = json.loads(payload) if isinstance(payload, str) else payload
    except (TypeError, json.JSONDecodeError):
        return "invalid_json"
    if not isinstance(value, dict):
        return "invalid_shape"
    best_ask: Optional[float] = None
    best_bid: Optional[float] = None
    for side in ("asks", "bids"):
        levels = value.get(side)
        if not isinstance(levels, list):
            return "invalid_shape"
        prices = set()
        for level in levels:
            if not isinstance(level, (list, tuple)) or len(level) < 2:
                return "invalid_level"
            try:
                price = float(level[0])
                quantity = float(level[1])
            except (TypeError, ValueError):
                return "invalid_level"
            if not math.isfinite(price) or not math.isfinite(quantity) or price <= 0 or quantity < 0 or price in prices:
                return "invalid_level"
            prices.add(price)
        if prices:
            if side == "asks":
                best_ask = min(prices)
            else:
                best_bid = max(prices)
    if best_ask is not None and best_bid is not None and best_bid >= best_ask:
        return "crossed_orderbook"
    return None