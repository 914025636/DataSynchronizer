import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from data_reconciliation.models import Trade
from data_reconciliation.ccxt_trades import fetch_trade_window
from data_reconciliation.mysql_audit import legacy_table_name
from data_reconciliation.questdb_store import fetch_trades
from data_reconciliation.questdb_table_names import (
    questdb_market_tables,
    questdb_orderbook_delta_table_name,
    questdb_trades_table_name,
)
from data_reconciliation.trade_reconcile import reconcile_trades
from reconcile_market_data import parse_utc_milliseconds


def trade(trade_id, timestamp=1, price=100.0):
    return Trade(timestamp, "binance", "BTC/USDT", trade_id, "buy", price, 1.0)


class TradeReconciliationTests(unittest.TestCase):
    def test_classifies_existing_missing_and_source_duplicates(self):
        existing = trade("1")
        missing = trade("2", timestamp=2)

        result = reconcile_trades([existing, missing, missing], [existing])

        self.assertEqual(result.existing, (existing,))
        self.assertEqual(result.missing, (missing,))
        self.assertEqual(result.source_duplicates, (missing,))
        self.assertEqual(result.conflicts, ())

    def test_reports_payload_conflict_for_same_business_key(self):
        stored = trade("1", price=100.0)
        source = trade("1", price=101.0)

        result = reconcile_trades([source], [stored])

        self.assertEqual(result.missing, ())
        self.assertEqual(result.conflicts, ((stored, source),))

    def test_requires_timezone_in_cli_window(self):
        self.assertEqual(parse_utc_milliseconds("2026-07-20T00:00:00Z"), 1_784_505_600_000)
        with self.assertRaises(Exception):
            parse_utc_milliseconds("2026-07-20T00:00:00")

    def test_fetches_pages_until_end_boundary(self):
        class FakeExchange:
            has = {"fetchTrades": True}
            markets = {"BTC/USDT": {"spot": True}}

            def load_markets(self):
                return self.markets

            def fetch_trades(self, symbol, since, limit, params):
                if since == 100:
                    return [
                        {"timestamp": 100, "id": "1", "side": "buy", "price": 10, "amount": 1},
                        {"timestamp": 110, "id": "2", "side": "sell", "price": 11, "amount": 2},
                    ]
                return [{"timestamp": 200, "id": "3", "side": "buy", "price": 12, "amount": 1}]

        result = fetch_trade_window(FakeExchange(), "binance", "BTC/USDT", 100, 200, limit=3)

        self.assertTrue(result.evidence.source_complete)
        self.assertEqual([item.trade_id for item in result.trades], ["1", "2"])

    def test_empty_first_page_is_not_completeness_evidence(self):
        class EmptyExchange:
            has = {"fetchTrades": True}
            markets = {"BTC/USDT": {"spot": True}}

            def load_markets(self):
                return self.markets

            def fetch_trades(self, symbol, since, limit, params):
                return []

        result = fetch_trade_window(EmptyExchange(), "binance", "BTC/USDT", 100, 200)

        self.assertFalse(result.evidence.source_complete)
        self.assertEqual(result.evidence.reason, "empty_first_page_does_not_prove_history_complete")

    def test_matches_legacy_mysql_table_naming(self):
        self.assertEqual(legacy_table_name("binance", "BTC/USDT", "trades"), "binance_btcusdt_trades")
        self.assertEqual(legacy_table_name("okx", "BTC/USDT:USDT", "orderbook"), "okx_btcusdt:usdt_orderbook")

    def test_builds_questdb_market_table_names(self):
        tables = questdb_market_tables("binance", "BTC/USDT")
        self.assertEqual(tables.trades_table, "binance_btc_usdt_spot_trades")
        self.assertEqual(tables.orderbook_delta_table, "binance_btc_usdt_spot_orderbook_delta")
        self.assertEqual(
            questdb_trades_table_name("okx", "BTC/USDT:USDT"),
            "okx_btc_usdt_swap_trades",
        )
        self.assertEqual(
            questdb_orderbook_delta_table_name("gate", "BTC/USDT:USDT"),
            "gate_btc_usdt_swap_orderbook_delta",
        )
        self.assertLessEqual(len(questdb_orderbook_delta_table_name("exchange.with.dot", "LONG/" * 80)), 127)

    def test_fetches_trades_from_the_market_table(self):
        class RecordingClient:
            def __init__(self):
                self.sql = ""

            def query(self, sql, params=()):
                self.sql = sql
                return []

        client = RecordingClient()
        self.assertEqual(fetch_trades(client, "binance", "BTC/USDT", 100, 200), ())
        self.assertIn('FROM "binance_btc_usdt_spot_trades"', client.sql)


if __name__ == "__main__":
    unittest.main()
