import {
  questdbMarketTables,
  questdbOrderbookDeltaTableName,
  questdbTradesTableName,
} from '../questdb/table_names';

describe('QuestDB market table names', () => {
  it('keeps standard spot market names readable', () => {
    expect(questdbTradesTableName('binance', 'BTC/USDT')).toBe('binance_btc_usdt_spot_trades');
    expect(questdbOrderbookDeltaTableName('binance', 'BTC/USDT')).toBe('binance_btc_usdt_spot_orderbook_delta');
  });

  it('uses explicit spot and swap market type suffixes', () => {
    expect(questdbTradesTableName('okx', 'BTC/USDT')).toBe('okx_btc_usdt_spot_trades');
    expect(questdbTradesTableName('okx', 'BTC/USDT:USDT')).toBe('okx_btc_usdt_swap_trades');
    expect(questdbOrderbookDeltaTableName('gate', 'BTC/USDT:USDT')).toBe(
      'gate_btc_usdt_swap_orderbook_delta',
    );
  });

  it('produces legal bounded names for unusual and long inputs', () => {
    const names = [
      questdbTradesTableName('交易所', '比特币/美元'),
      questdbOrderbookDeltaTableName('exchange.with.dot', `${'LONG/'.repeat(80)}USD`),
      questdbTradesTableName('', ''),
    ];

    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9_]+$/);
      expect(name.length).toBeLessThanOrEqual(127);
    }
  });

  it('returns both target tables and a stable market key', () => {
    expect(questdbMarketTables('bybit', 'ETH/USDT')).toEqual({
      marketKey: 'bybit\0ETH/USDT',
      tradesTable: 'bybit_eth_usdt_spot_trades',
      orderbookDeltaTable: 'bybit_eth_usdt_spot_orderbook_delta',
    });
  });
});
