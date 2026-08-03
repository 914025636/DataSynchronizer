-- Companion objects for non-destructive reconciliation. Raw tables remain unchanged.
CREATE TABLE IF NOT EXISTS market_data_catalog (
    timestamp TIMESTAMP,
    exchange SYMBOL,
    symbol SYMBOL,
    trades_table STRING,
    orderbook_delta_table STRING
) TIMESTAMP(timestamp) PARTITION BY DAY;

CREATE TABLE IF NOT EXISTS trades_repair_staging (
    timestamp TIMESTAMP,
    exchange SYMBOL,
    symbol SYMBOL,
    trade_id STRING,
    side SYMBOL,
    price DOUBLE,
    quantity DOUBLE,
    run_id STRING,
    fetched_at TIMESTAMP
) TIMESTAMP(timestamp) PARTITION BY DAY WAL;

CREATE TABLE IF NOT EXISTS trades_repair (
    timestamp TIMESTAMP,
    exchange SYMBOL,
    symbol SYMBOL,
    trade_id STRING,
    side SYMBOL,
    price DOUBLE,
    quantity DOUBLE,
    run_id STRING,
    fetched_at TIMESTAMP
) TIMESTAMP(timestamp) PARTITION BY DAY WAL
DEDUP UPSERT KEYS(timestamp, exchange, symbol, trade_id);

CREATE TABLE IF NOT EXISTS orderbook_quality_intervals (
    timestamp TIMESTAMP,
    end_timestamp TIMESTAMP,
    exchange SYMBOL,
    symbol SYMBOL,
    status SYMBOL,
    reason SYMBOL,
    start_sequence LONG,
    end_sequence LONG,
    run_id STRING
) TIMESTAMP(timestamp) PARTITION BY DAY WAL;

-- Global reconciled/trusted views cannot automatically include future market tables.
-- Resolve the target table through market_data_catalog, then substitute the validated
-- table identifier in the following per-market query patterns.
--
-- SELECT * FROM "binance_btc_usdt_spot_trades"
-- UNION ALL
-- SELECT r.timestamp, r.exchange, r.symbol, r.side, r.price, r.quantity, r.trade_id
-- FROM trades_repair r
-- WHERE r.exchange = 'binance' AND r.symbol = 'BTC/USDT'
--   AND NOT EXISTS (
--     SELECT 1 FROM "binance_btc_usdt_spot_trades" t
--     WHERE t.trade_id = r.trade_id
--   );
--
-- SELECT d.*
-- FROM "binance_btc_usdt_spot_orderbook_delta" d
-- JOIN orderbook_quality_intervals q
--   ON q.exchange = d.exchange AND q.symbol = d.symbol
--  AND q.status = 'trusted'
--  AND d.timestamp >= q.timestamp AND d.timestamp < q.end_timestamp;