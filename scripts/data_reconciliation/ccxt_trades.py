from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .models import FetchEvidence, FetchResult, Trade


SUPPORTED_EXCHANGES = {"binance", "okx", "bybit", "gate", "coinbase"}


@dataclass(frozen=True)
class PaginationPolicy:
    default_limit: int
    historical_since_supported: bool


POLICIES = {
    "binance": PaginationPolicy(1000, True),
    "okx": PaginationPolicy(100, True),
    "bybit": PaginationPolicy(1000, False),
    "gate": PaginationPolicy(1000, True),
    "coinbase": PaginationPolicy(100, True),
}


class TradeFetchError(RuntimeError):
    pass


def create_exchange(exchange_id: str, proxy: Optional[str] = None) -> Any:
    try:
        import ccxt  # type: ignore
    except ImportError as exc:
        raise TradeFetchError("Install ccxt from scripts/requirements-data-quality.txt") from exc

    if exchange_id not in SUPPORTED_EXCHANGES or not hasattr(ccxt, exchange_id):
        raise TradeFetchError(f"Unsupported exchange: {exchange_id}")
    options: Dict[str, Any] = {"enableRateLimit": True}
    if proxy:
        options["httpsProxy"] = proxy
    return getattr(ccxt, exchange_id)(options)


def fetch_trade_window(
    exchange: Any,
    exchange_id: str,
    symbol: str,
    start_ms: int,
    end_ms: int,
    limit: Optional[int] = None,
    max_pages: int = 100,
    params: Optional[Mapping[str, Any]] = None,
    retries: int = 3,
) -> FetchResult:
    policy = POLICIES[exchange_id]
    page_limit = limit or policy.default_limit
    request_params = dict(params or {})
    exchange.load_markets()
    if symbol not in exchange.markets:
        raise TradeFetchError(f"Unknown symbol for {exchange_id}: {symbol}")
    if not exchange.has.get("fetchTrades"):
        raise TradeFetchError(f"{exchange_id} does not support fetchTrades")

    market = exchange.markets[symbol]
    market_type = "linear" if market.get("swap") and market.get("linear") else "spot" if market.get("spot") else "unsupported"
    if market_type == "unsupported":
        raise TradeFetchError(f"Only spot and linear markets are supported: {symbol}")

    cursor = start_ms
    pages = 0
    raw_count = 0
    seen: Dict[Tuple[str, str, str], Trade] = {}
    source_complete = False
    reason = "max_pages_reached"

    while pages < max_pages and cursor < end_ms:
        page = _fetch_with_retry(exchange, symbol, cursor, page_limit, request_params, retries)
        pages += 1
        raw_count += len(page)
        normalized = sorted(
            (_normalize_trade(item, exchange_id, symbol) for item in page),
            key=lambda trade: (trade.timestamp, trade.trade_id),
        )

        for trade in normalized:
            if start_ms <= trade.timestamp < end_ms:
                existing = seen.get(trade.business_key)
                if existing is not None and existing.payload != trade.payload:
                    raise TradeFetchError(f"Conflicting source payload for trade id {trade.trade_id}")
                seen[trade.business_key] = trade

        if any(trade.timestamp >= end_ms for trade in normalized):
            source_complete = policy.historical_since_supported
            reason = "end_boundary_observed" if source_complete else "exchange_only_exposes_recent_trades"
            break
        if not normalized:
            if pages > 1 and policy.historical_since_supported:
                source_complete = True
                reason = "empty_page_after_advancing_cursor"
            else:
                reason = "empty_first_page_does_not_prove_history_complete"
            break

        last_timestamp = normalized[-1].timestamp
        if last_timestamp < cursor:
            reason = "exchange_ignored_since_cursor"
            break
        if len(normalized) >= page_limit:
            reason = "native_cursor_required_at_full_page_boundary"
            break
        next_cursor = last_timestamp + 1
        if next_cursor <= cursor:
            reason = "cursor_did_not_advance"
            break
        cursor = next_cursor

    trades = tuple(sorted(seen.values(), key=lambda trade: (trade.timestamp, trade.trade_id)))
    evidence = FetchEvidence(
        exchange=exchange_id,
        symbol=symbol,
        market_type=market_type,
        pages=pages,
        raw_trades=raw_count,
        unique_trades=len(trades),
        source_complete=source_complete,
        reason=reason,
        first_timestamp=trades[0].timestamp if trades else None,
        last_timestamp=trades[-1].timestamp if trades else None,
    )
    return FetchResult(trades, evidence)


def _fetch_with_retry(
    exchange: Any,
    symbol: str,
    since: int,
    limit: int,
    params: Mapping[str, Any],
    retries: int,
) -> List[Mapping[str, Any]]:
    last_error: Optional[Exception] = None
    for attempt in range(retries):
        try:
            return list(exchange.fetch_trades(symbol, since, limit, dict(params)))
        except Exception as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(min(2**attempt, 8))
    raise TradeFetchError(f"fetchTrades failed after {retries} attempts: {last_error}")


def _normalize_trade(item: Mapping[str, Any], exchange: str, symbol: str) -> Trade:
    timestamp = item.get("timestamp")
    trade_id = item.get("id")
    side = item.get("side")
    price = item.get("price")
    quantity = item.get("amount")
    if timestamp is None or trade_id in (None, ""):
        raise TradeFetchError("Historical trade is missing timestamp or stable id")
    try:
        timestamp_value = int(timestamp)
        price_value = float(price)
        quantity_value = float(quantity)
    except (TypeError, ValueError) as exc:
        raise TradeFetchError("Historical trade contains invalid numeric fields") from exc
    if side not in {"buy", "sell"}:
        raise TradeFetchError(f"Historical trade has invalid side: {side}")
    if not math.isfinite(price_value) or not math.isfinite(quantity_value) or price_value <= 0 or quantity_value <= 0:
        raise TradeFetchError("Historical trade contains non-positive price or quantity")
    return Trade(timestamp_value, exchange, symbol, str(trade_id), side, price_value, quantity_value)