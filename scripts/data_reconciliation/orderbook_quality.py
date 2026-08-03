from __future__ import annotations

import math
from typing import Dict, Iterable, List, Optional, Tuple

from .models import OrderbookFrame, QualityInterval, QualityStatus


Book = Dict[str, Dict[float, float]]


def classify_orderbook_intervals(frames: Iterable[OrderbookFrame]) -> Tuple[QualityInterval, ...]:
    ordered = sorted(frames, key=lambda frame: frame.timestamp)
    if not ordered:
        return ()

    intervals: List[QualityInterval] = []
    status = QualityStatus.UNRECOVERABLE
    reason = "missing_initial_snapshot"
    interval_start = ordered[0].timestamp
    interval_start_sequence: Optional[int] = None
    previous_sequence: Optional[int] = None
    book: Book = {"ask": {}, "bid": {}}

    def transition(frame: OrderbookFrame, new_status: QualityStatus, new_reason: str) -> None:
        nonlocal status, reason, interval_start, interval_start_sequence
        if new_status == status:
            if frame.timestamp == interval_start:
                reason = new_reason
                interval_start_sequence = frame.sequence
            return
        intervals.append(
            QualityInterval(
                start_timestamp=interval_start,
                end_timestamp=frame.timestamp,
                status=status,
                reason=reason,
                start_sequence=interval_start_sequence,
                end_sequence=previous_sequence,
            )
        )
        status = new_status
        reason = new_reason
        interval_start = frame.timestamp
        interval_start_sequence = frame.sequence

    for frame in ordered:
        frame_error = _validate_frame(frame)
        is_snapshot = frame.update_type == "snapshot"

        if is_snapshot:
            candidate = _empty_book()
            if frame_error is None:
                _apply_levels(candidate, frame)
                frame_error = _validate_book(candidate, require_both_sides=True)
            if frame_error is not None:
                transition(frame, QualityStatus.UNRECOVERABLE, frame_error)
                book = _empty_book()
                previous_sequence = frame.sequence
                continue

            book = candidate
            if frame.sequence in (None, 0) or frame.ambiguous:
                transition(frame, QualityStatus.SUSPECT, "snapshot_sequence_unknown")
            else:
                transition(frame, QualityStatus.TRUSTED, "valid_snapshot")
            previous_sequence = frame.sequence
            continue

        if status == QualityStatus.UNRECOVERABLE:
            previous_sequence = frame.sequence
            continue
        if frame_error is not None:
            transition(frame, QualityStatus.UNRECOVERABLE, frame_error)
            book = _empty_book()
            previous_sequence = frame.sequence
            continue
        if frame.sequence in (None, 0) or frame.ambiguous:
            transition(frame, QualityStatus.SUSPECT, "sequence_unknown")
        elif previous_sequence not in (None, 0):
            if frame.sequence <= previous_sequence:
                transition(frame, QualityStatus.UNRECOVERABLE, "sequence_regression")
            elif frame.sequence != previous_sequence + 1:
                transition(frame, QualityStatus.UNRECOVERABLE, "sequence_gap")

        if status != QualityStatus.UNRECOVERABLE:
            candidate = {side: levels.copy() for side, levels in book.items()}
            _apply_levels(candidate, frame)
            book_error = _validate_book(candidate, require_both_sides=True)
            if book_error is not None:
                transition(frame, QualityStatus.UNRECOVERABLE, book_error)
                book = _empty_book()
            else:
                book = candidate
        previous_sequence = frame.sequence

    intervals.append(
        QualityInterval(
            start_timestamp=interval_start,
            end_timestamp=ordered[-1].timestamp + 1,
            status=status,
            reason=reason,
            start_sequence=interval_start_sequence,
            end_sequence=previous_sequence,
        )
    )
    return tuple(interval for interval in intervals if interval.start_timestamp < interval.end_timestamp)


def clip_quality_intervals(
    intervals: Iterable[QualityInterval], start_timestamp: int, end_timestamp: int
) -> Tuple[QualityInterval, ...]:
    source = list(intervals)
    clipped = []
    for index, interval in enumerate(source):
        clipped_start = max(interval.start_timestamp, start_timestamp)
        interval_end = end_timestamp if index == len(source) - 1 else interval.end_timestamp
        clipped_end = min(interval_end, end_timestamp)
        if clipped_start < clipped_end:
            clipped.append(
                QualityInterval(
                    start_timestamp=clipped_start,
                    end_timestamp=clipped_end,
                    status=interval.status,
                    reason=interval.reason,
                    start_sequence=interval.start_sequence,
                    end_sequence=interval.end_sequence,
                    evidence=interval.evidence,
                )
            )
    return tuple(clipped)


def _empty_book() -> Book:
    return {"ask": {}, "bid": {}}


def _validate_frame(frame: OrderbookFrame) -> Optional[str]:
    if frame.update_type not in {"snapshot", "delta"}:
        return "invalid_update_type"
    for level in frame.levels:
        if level.side not in {"ask", "bid"}:
            return "invalid_side"
        if not math.isfinite(level.price) or not math.isfinite(level.quantity):
            return "invalid_numeric_level"
        if level.price <= 0 or level.quantity < 0:
            return "invalid_numeric_level"
    return None


def _apply_levels(book: Book, frame: OrderbookFrame) -> None:
    for level in frame.levels:
        if level.quantity == 0:
            book[level.side].pop(level.price, None)
        else:
            book[level.side][level.price] = level.quantity


def _validate_book(book: Book, require_both_sides: bool) -> Optional[str]:
    asks = book["ask"]
    bids = book["bid"]
    if require_both_sides and (not asks or not bids):
        return "incomplete_orderbook"
    if asks and bids and max(bids) >= min(asks):
        return "crossed_orderbook"
    return None
