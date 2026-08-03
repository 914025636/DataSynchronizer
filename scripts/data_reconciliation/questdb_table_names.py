from __future__ import annotations

import re
from dataclasses import dataclass


MAX_TABLE_NAME_LENGTH = 127


@dataclass(frozen=True)
class QuestDBMarketTables:
    market_key: str
    trades_table: str
    orderbook_delta_table: str


def _readable_component(value: str) -> str:
    readable = re.sub(r"[^a-z0-9]+", "_", value.lower())
    return re.sub(r"_+", "_", readable).strip("_") or "market"


def _table_name(exchange: str, symbol: str, suffix: str) -> str:
    market_symbol, separator, _ = symbol.partition(":")
    market_type = "swap" if separator else "spot"
    readable = f"{_readable_component(exchange)}_{_readable_component(market_symbol)}"
    reserved_length = len(market_type) + len(suffix) + 2
    base = readable[: MAX_TABLE_NAME_LENGTH - reserved_length].rstrip("_") or "market"
    return f"{base}_{market_type}_{suffix}"


def questdb_trades_table_name(exchange: str, symbol: str) -> str:
    return _table_name(exchange, symbol, "trades")


def questdb_orderbook_delta_table_name(exchange: str, symbol: str) -> str:
    return _table_name(exchange, symbol, "orderbook_delta")


def questdb_market_tables(exchange: str, symbol: str) -> QuestDBMarketTables:
    return QuestDBMarketTables(
        market_key=f"{exchange}\0{symbol}",
        trades_table=questdb_trades_table_name(exchange, symbol),
        orderbook_delta_table=questdb_orderbook_delta_table_name(exchange, symbol),
    )


def quote_identifier(table_name: str) -> str:
    if re.fullmatch(r"[a-z0-9_]{1,127}", table_name) is None:
        raise ValueError(f"Invalid QuestDB table name: {table_name}")
    return f'"{table_name}"'