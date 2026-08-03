import { Utils } from '../utils';

describe('Utils', () => {
  it('should candlestickName format as expected', () => {
    const candlestickName1 = Utils.candlestickName('binance', 'btc-/_bnb', 60);
    const candlestickName2 = Utils.candlestickName('binance', 'btc-/_bnb', '1m');

    expect(candlestickName1).toBe('binance_btcbnb_1m');
    expect(candlestickName2).toBe('binance_btcbnb_1m');
  });

  it('uses QuestDB-compatible names for one-minute orderbook snapshots', () => {
    expect(Utils.orderbookName('binance', 'BTC/USDT')).toBe('binance_btc_usdt_spot_orderbook_1m');
    expect(Utils.orderbookName('okx', 'BTC/USDT:USDT')).toBe('okx_btc_usdt_swap_orderbook_1m');
    expect(Utils.orderbookName('exchange.with.dot', 'ETH-USDC')).toBe(
      'exchange_with_dot_eth_usdc_spot_orderbook_1m',
    );
  });
});
