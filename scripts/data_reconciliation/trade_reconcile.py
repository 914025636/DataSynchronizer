from __future__ import annotations

from typing import Dict, Iterable, List, Tuple

from .models import ReconciliationResult, Trade


def reconcile_trades(source: Iterable[Trade], stored: Iterable[Trade]) -> ReconciliationResult:
    stored_by_key: Dict[Tuple[str, str, str], Trade] = {}
    for trade in stored:
        stored_by_key.setdefault(trade.business_key, trade)

    source_by_key: Dict[Tuple[str, str, str], Trade] = {}
    existing: List[Trade] = []
    missing: List[Trade] = []
    duplicates: List[Trade] = []
    conflicts: List[Tuple[Trade, Trade]] = []

    for trade in source:
        prior_source = source_by_key.get(trade.business_key)
        if prior_source is not None:
            if prior_source.payload == trade.payload:
                duplicates.append(trade)
            else:
                conflicts.append((prior_source, trade))
            continue

        source_by_key[trade.business_key] = trade
        stored_trade = stored_by_key.get(trade.business_key)
        if stored_trade is None:
            missing.append(trade)
        elif stored_trade.payload == trade.payload:
            existing.append(trade)
        else:
            conflicts.append((stored_trade, trade))

    return ReconciliationResult(
        existing=tuple(existing),
        missing=tuple(missing),
        source_duplicates=tuple(duplicates),
        conflicts=tuple(conflicts),
    )
