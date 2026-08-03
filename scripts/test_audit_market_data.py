import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from audit_market_data import (
    audit_questdb,
    classify_mysql_table,
    interval_milliseconds_from_table,
    is_valid_candle,
    validate_orderbook_payload,
)


class AuditMarketDataTests(unittest.TestCase):
    def test_classifies_dynamic_tables_by_schema(self):
        candle = [(name, "double") for name in ("time", "open", "high", "low", "close", "volume")]
        orderbook = [("time", "bigint"), ("orderbook", "mediumtext")]
        self.assertEqual(classify_mysql_table(candle), "candlestick")
        self.assertEqual(classify_mysql_table(orderbook), "orderbook")
        self.assertIsNone(classify_mysql_table([("time", "bigint"), ("price", "double")]))

    def test_validates_ohlcv_invariants(self):
        self.assertTrue(is_valid_candle(100, 110, 90, 105, 12))
        self.assertFalse(is_valid_candle(100, 99, 90, 105, 12))
        self.assertFalse(is_valid_candle(100, 110, 90, 105, -1))
        self.assertFalse(is_valid_candle(float("nan"), 110, 90, 105, 1))

    def test_extracts_supported_interval_from_table_name(self):
        self.assertEqual(interval_milliseconds_from_table("binance_btcusdt_1m"), 60_000)
        self.assertEqual(interval_milliseconds_from_table("binance_btcusdt_24h"), 86_400_000)
        self.assertIsNone(interval_milliseconds_from_table("binance_btcusdt_orderbook"))

    def test_validates_orderbook_payload(self):
        valid = json.dumps({"asks": [[101, 1]], "bids": [[100, 2]]})
        crossed = json.dumps({"asks": [[100, 1]], "bids": [[101, 2]]})
        duplicate = json.dumps({"asks": [[101, 1], [101, 2]], "bids": []})
        self.assertIsNone(validate_orderbook_payload(valid))
        self.assertEqual(validate_orderbook_payload(crossed), "crossed orderbook")
        self.assertEqual(validate_orderbook_payload(duplicate), "asks contains duplicate price levels")
        self.assertTrue(validate_orderbook_payload("not-json").startswith("invalid JSON"))

    def test_audits_catalog_market_tables_and_marks_legacy_tables(self):
        class FakeClient:
            def __init__(self):
                self.queries = []

            def query(self, sql, params=()):
                self.queries.append(sql)
                if sql == "SELECT table_name FROM tables()":
                    return [
                        ("market_data_catalog",),
                        ("binance_btc_usdt_spot_trades",),
                        ("binance_btc_usdt_spot_orderbook_delta",),
                        ("trades",),
                        ("orderbook_delta",),
                    ]
                if "LATEST ON timestamp" in sql:
                    return [("binance", "BTC/USDT", "binance_btc_usdt_spot_trades", "binance_btc_usdt_spot_orderbook_delta")]
                if "min(timestamp)" in sql:
                    return [(1, "start", "end")]
                return [(0,)]

        client = FakeClient()
        findings = audit_questdb(client)

        self.assertTrue(any(item.table == "binance_btc_usdt_spot_trades" and item.check == "summary" for item in findings))
        self.assertTrue(any(item.table == "binance_btc_usdt_spot_orderbook_delta" and item.check == "summary" for item in findings))
        self.assertEqual(sum(item.check == "legacy_table" for item in findings), 2)
        self.assertTrue(any('FROM "binance_btc_usdt_spot_trades"' in sql for sql in client.queries))


if __name__ == "__main__":
    unittest.main()