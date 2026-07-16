/* eslint-disable no-undef */
'use strict';
require('dotenv').config();

import { CCXT_API } from '../exchange/ccxt_controller';

describe('CCXT Controller Test', () => {
  test('Configure spot and USDT perpetual markets', () => {
    CCXT_API.configureMarketTypes('binance: spot | swap,kucoin:spot');

    expect(CCXT_API.getMarketTypes('binance')).toEqual(['spot', 'swap']);
    expect(CCXT_API.getMarketTypes('kucoin')).toEqual(['spot']);
    expect(CCXT_API.getMarketTypes('kraken')).toEqual(['spot']);
  });

  test('Filter market data by configured types', async () => {
    CCXT_API.configureMarketTypes('binance:spot|swap');
    const loadExchange = jest.spyOn(CCXT_API, 'loadExchangeAPI').mockReturnValue(({
      loadMarkets: async () => ({
        'BTC/USDT': { symbol: 'BTC/USDT', spot: true, swap: false },
        'BTC/USDT:USDT': { symbol: 'BTC/USDT:USDT', spot: false, swap: true, linear: true },
        'BTC/USD:BTC': { symbol: 'BTC/USD:BTC', spot: false, swap: true, linear: false },
      }),
    } as unknown) as any);

    const markets = await CCXT_API.getMarketdata('binance');

    expect(Object.keys(markets)).toEqual(['BTC/USDT', 'BTC/USDT:USDT']);
    loadExchange.mockRestore();
  });

  // Add Binance exhcange
  test('Add valid exchange', async () => {
    const exchange = CCXT_API.initNewExchanges('binance');
    CCXT_API.initNewExchanges('binance');
    CCXT_API.initNewExchanges('binance');

    expect(CCXT_API.exchanges).toHaveLength(1);
    expect(exchange.api.tokenBucket).toBeDefined();
  });

  // Add non-exist exchange should be Throwed
  test('Add invalid exchange', () => {
    expect(() => {
      CCXT_API.initNewExchanges('binancesdfsadf');
    }).toThrow();
  });

  // Load+Init Valid exchange
  test('Load first exchange', async () => {
    const exchange = CCXT_API.loadExchangeAPI('kucoin');

    expect(exchange.tokenBucket).toBeDefined();
  });

  // Get Marketdata
  test('Marketdata check', async () => {
    const result = await CCXT_API.getMarketdata('kucoin');

    expect(result).toBeTruthy();
  });

  // Get PriceTickers
  test('Pricetickers check', async () => {
    const result = await CCXT_API.getPriceTickers('kucoin');

    expect(result).toBeTruthy();
  });
});
