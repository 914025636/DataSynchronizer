import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from data_reconciliation.models import OrderbookFrame, OrderbookLevel, QualityStatus
from data_reconciliation.orderbook_quality import classify_orderbook_intervals, clip_quality_intervals


def frame(timestamp, update_type, sequence, *levels, ambiguous=False):
    return OrderbookFrame(timestamp, update_type, sequence, tuple(levels), ambiguous)


class OrderbookQualityTests(unittest.TestCase):
    def test_isolates_gap_until_next_valid_snapshot(self):
        frames = [
            frame(100, "snapshot", 10, OrderbookLevel("ask", 101, 1), OrderbookLevel("bid", 100, 1)),
            frame(110, "delta", 11, OrderbookLevel("bid", 100, 2)),
            frame(120, "delta", 13, OrderbookLevel("ask", 102, 1)),
            frame(130, "delta", 14, OrderbookLevel("bid", 99, 1)),
            frame(140, "snapshot", 20, OrderbookLevel("ask", 103, 1), OrderbookLevel("bid", 102, 1)),
        ]

        intervals = classify_orderbook_intervals(frames)

        self.assertEqual([item.status for item in intervals], [
            QualityStatus.TRUSTED,
            QualityStatus.UNRECOVERABLE,
            QualityStatus.TRUSTED,
        ])
        self.assertEqual([(item.start_timestamp, item.end_timestamp) for item in intervals], [
            (100, 120),
            (120, 140),
            (140, 141),
        ])

    def test_unknown_sequence_is_suspect_not_trusted(self):
        intervals = classify_orderbook_intervals([
            frame(100, "snapshot", 0, OrderbookLevel("ask", 101, 1), OrderbookLevel("bid", 100, 1)),
            frame(110, "delta", 0, OrderbookLevel("bid", 100, 2)),
        ])

        self.assertEqual([item.status for item in intervals], [QualityStatus.SUSPECT])

    def test_rejects_crossed_snapshot(self):
        intervals = classify_orderbook_intervals([
            frame(100, "snapshot", 10, OrderbookLevel("ask", 100, 1), OrderbookLevel("bid", 101, 1)),
        ])

        self.assertEqual(intervals[0].status, QualityStatus.UNRECOVERABLE)
        self.assertEqual(intervals[0].reason, "crossed_orderbook")

    def test_clips_anchor_interval_to_requested_window(self):
        intervals = classify_orderbook_intervals([
            frame(90, "snapshot", 10, OrderbookLevel("ask", 101, 1), OrderbookLevel("bid", 100, 1)),
            frame(110, "delta", 11, OrderbookLevel("bid", 100, 2)),
        ])

        clipped = clip_quality_intervals(intervals, 100, 120)

        self.assertEqual([(item.start_timestamp, item.end_timestamp) for item in clipped], [(100, 120)])
        self.assertEqual(clipped[0].status, QualityStatus.TRUSTED)


if __name__ == "__main__":
    unittest.main()