from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Optional, Tuple


class QualityStatus(str, Enum):
    TRUSTED = "trusted"
    SUSPECT = "suspect"
    UNRECOVERABLE = "unrecoverable"


@dataclass(frozen=True)
class Trade:
    timestamp: int
    exchange: str
    symbol: str
    trade_id: str
    side: str
    price: float
    quantity: float

    @property
    def business_key(self) -> Tuple[str, str, str]:
        return self.exchange, self.symbol, self.trade_id

    @property
    def payload(self) -> Tuple[int, str, float, float]:
        return self.timestamp, self.side, self.price, self.quantity


@dataclass(frozen=True)
class ReconciliationResult:
    existing: Tuple[Trade, ...] = ()
    missing: Tuple[Trade, ...] = ()
    source_duplicates: Tuple[Trade, ...] = ()
    conflicts: Tuple[Tuple[Trade, Trade], ...] = ()


@dataclass(frozen=True)
class FetchEvidence:
    exchange: str
    symbol: str
    market_type: str
    pages: int
    raw_trades: int
    unique_trades: int
    source_complete: bool
    reason: str
    first_timestamp: Optional[int] = None
    last_timestamp: Optional[int] = None


@dataclass(frozen=True)
class FetchResult:
    trades: Tuple[Trade, ...]
    evidence: FetchEvidence


@dataclass(frozen=True)
class OrderbookLevel:
    side: str
    price: float
    quantity: float


@dataclass(frozen=True)
class OrderbookFrame:
    timestamp: int
    update_type: str
    sequence: Optional[int]
    levels: Tuple[OrderbookLevel, ...]
    ambiguous: bool = False


@dataclass(frozen=True)
class QualityInterval:
    start_timestamp: int
    end_timestamp: int
    status: QualityStatus
    reason: str
    start_sequence: Optional[int] = None
    end_sequence: Optional[int] = None
    evidence: Mapping[str, Any] = field(default_factory=dict)
