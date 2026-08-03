from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable, List, Sequence, Tuple

from .models import OrderbookFrame, OrderbookLevel, QualityInterval, Trade
from .questdb_table_names import questdb_market_tables, quote_identifier


def fetch_trades(client: Any, exchange: str, symbol: str, start_ms: int, end_ms: int) -> Tuple[Trade, ...]:
    table = quote_identifier(questdb_market_tables(exchange, symbol).trades_table)
    rows = client.query(
        f"SELECT timestamp, exchange, symbol, trade_id, side, price, quantity FROM {table} "
        "WHERE exchange = %s AND symbol = %s AND timestamp >= %s AND timestamp < %s ORDER BY timestamp",
        (exchange, symbol, _utc_datetime(start_ms), _utc_datetime(end_ms)),
    )
    return tuple(
        Trade(_timestamp_ms(row[0]), str(row[1]), str(row[2]), str(row[3]), str(row[4]), float(row[5]), float(row[6]))
        for row in rows
    )


def fetch_orderbook_frames(client: Any, exchange: str, symbol: str, start_ms: int, end_ms: int) -> Tuple[OrderbookFrame, ...]:
    table = quote_identifier(questdb_market_tables(exchange, symbol).orderbook_delta_table)
    anchor_rows = client.query(
        f"SELECT max(timestamp) FROM {table} WHERE exchange = %s AND symbol = %s "
        "AND update_type = 'snapshot' AND timestamp < %s",
        (exchange, symbol, _utc_datetime(start_ms)),
    )
    anchor = anchor_rows[0][0] if anchor_rows and anchor_rows[0][0] is not None else _utc_datetime(start_ms)
    rows = client.query(
        f"SELECT timestamp, update_type, sequence, side, price, qty FROM {table} "
        "WHERE exchange = %s AND symbol = %s AND timestamp >= %s AND timestamp < %s "
        "ORDER BY timestamp, sequence",
        (exchange, symbol, anchor, _utc_datetime(end_ms)),
    )
    frames: List[OrderbookFrame] = []
    current_key: Any = None
    current_levels: List[OrderbookLevel] = []
    current_timestamp = 0
    current_type = ""
    current_sequence = None
    for row in rows:
        timestamp = _timestamp_ms(row[0])
        sequence = int(row[2]) if row[2] not in (None, 0) else 0
        key = (timestamp, str(row[1]), sequence)
        if current_key is not None and key != current_key:
            frames.append(OrderbookFrame(current_timestamp, current_type, current_sequence, tuple(current_levels)))
            current_levels = []
        current_key = key
        current_timestamp = timestamp
        current_type = str(row[1])
        current_sequence = sequence
        current_levels.append(OrderbookLevel(str(row[3]), float(row[4]), float(row[5])))
    if current_key is not None:
        frames.append(OrderbookFrame(current_timestamp, current_type, current_sequence, tuple(current_levels)))
    return tuple(frames)


def ensure_reconciliation_tables(client: Any) -> None:
    statements = [
        "CREATE TABLE IF NOT EXISTS trades_repair_staging ("
        "timestamp TIMESTAMP, exchange SYMBOL, symbol SYMBOL, trade_id STRING, side SYMBOL, "
        "price DOUBLE, quantity DOUBLE, run_id STRING, fetched_at TIMESTAMP"
        ") TIMESTAMP(timestamp) PARTITION BY DAY WAL",
        "CREATE TABLE IF NOT EXISTS trades_repair ("
        "timestamp TIMESTAMP, exchange SYMBOL, symbol SYMBOL, trade_id STRING, side SYMBOL, "
        "price DOUBLE, quantity DOUBLE, run_id STRING, fetched_at TIMESTAMP"
        ") TIMESTAMP(timestamp) PARTITION BY DAY WAL DEDUP UPSERT KEYS(timestamp, exchange, symbol, trade_id)",
        "CREATE TABLE IF NOT EXISTS orderbook_quality_intervals ("
        "timestamp TIMESTAMP, end_timestamp TIMESTAMP, exchange SYMBOL, symbol SYMBOL, status SYMBOL, "
        "reason SYMBOL, start_sequence LONG, end_sequence LONG, run_id STRING"
        ") TIMESTAMP(timestamp) PARTITION BY DAY WAL",
    ]
    for statement in statements:
        _execute(client, statement)


def insert_repairs(client: Any, trades: Sequence[Trade], run_id: str) -> int:
    if not trades:
        return 0
    existing = {
        str(row[0]): Trade(_timestamp_ms(row[1]), trades[0].exchange, trades[0].symbol, str(row[0]), str(row[2]), float(row[3]), float(row[4]))
        for row in client.query(
            "SELECT trade_id, timestamp, side, price, quantity FROM trades_repair "
            "WHERE exchange = %s AND symbol = %s",
            (trades[0].exchange, trades[0].symbol),
        )
    }
    pending = []
    for trade in trades:
        repaired = existing.get(trade.trade_id)
        if repaired is None:
            pending.append(trade)
        elif repaired.payload != trade.payload:
            raise RuntimeError(f"Repair table contains conflicting payload for trade id {trade.trade_id}")
    fetched_at = datetime.now(timezone.utc)
    for trade in pending:
        _execute(
            client,
            "INSERT INTO trades_repair_staging VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (_utc_datetime(trade.timestamp), trade.exchange, trade.symbol, trade.trade_id, trade.side, trade.price, trade.quantity, run_id, fetched_at),
        )
    _commit(client)
    staged = client.query("SELECT count() FROM trades_repair_staging WHERE run_id = %s", (run_id,))[0][0]
    if int(staged) != len(pending):
        raise RuntimeError(f"Staging validation failed: expected {len(pending)}, found {staged}")
    for trade in pending:
        _execute(
            client,
            "INSERT INTO trades_repair VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (_utc_datetime(trade.timestamp), trade.exchange, trade.symbol, trade.trade_id, trade.side, trade.price, trade.quantity, run_id, fetched_at),
        )
    _commit(client)
    return len(pending)


def insert_quality_intervals(
    client: Any,
    exchange: str,
    symbol: str,
    intervals: Iterable[QualityInterval],
    run_id: str,
) -> int:
    count = 0
    for interval in intervals:
        _execute(
            client,
            "INSERT INTO orderbook_quality_intervals VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                _utc_datetime(interval.start_timestamp),
                _utc_datetime(interval.end_timestamp),
                exchange,
                symbol,
                interval.status.value,
                interval.reason,
                interval.start_sequence,
                interval.end_sequence,
                run_id,
            ),
        )
        count += 1
    _commit(client)
    return count


def _execute(client: Any, sql: str, params: Sequence[Any] = ()) -> None:
    cursor = client.connection.cursor()
    try:
        cursor.execute(sql, params)
    finally:
        cursor.close()


def _commit(client: Any) -> None:
    commit = getattr(client.connection, "commit", None)
    if commit:
        commit()


def _utc_datetime(timestamp_ms: int) -> datetime:
    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc)


def _timestamp_ms(value: Any) -> int:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp() * 1000)
    return int(value)