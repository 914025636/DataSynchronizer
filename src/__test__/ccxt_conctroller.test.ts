/* eslint-disable no-undef */
'use strict';
require('dotenv').config();

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { CCXT_API } from '../exchange/ccxt_controller';

describe('CCXT Controller Test', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('Filter market data by supported types', async () => {
    const loadExchange = jest.spyOn(CCXT_API, 'loadExchangeAPI').mockReturnValue(({
      has: { spot: true, swap: true },
      loadMarkets: async () => ({
        'BTC/USDT': { symbol: 'BTC/USDT', spot: true, swap: false },
        'BTC/USDT:USDT': { symbol: 'BTC/USDT:USDT', spot: false, swap: true, linear: true },
        'BTC/USD:BTC': { symbol: 'BTC/USD:BTC', spot: false, swap: true, linear: false },
      }),
    } as unknown) as any);

    const markets = await CCXT_API.getMarketdata('binance');

    expect(Object.keys(markets)).toEqual(['BTC/USDT', 'BTC/USDT:USDT']);
    expect(loadExchange).toHaveBeenCalledWith('binance');
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
  test(
    'Marketdata check',
    async () => {
      const result = await CCXT_API.getMarketdata('kucoin');

      expect(result).toBeTruthy();
    },
    15000,
  );

  // Get PriceTickers
  test(
    'Pricetickers check',
    async () => {
      const result = await CCXT_API.getPriceTickers('kucoin');

      expect(result).toBeTruthy();
    },
    15000,
  );
});
