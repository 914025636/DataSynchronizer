'use strict';
require('dotenv').config();

process.env.logLevel = 'info';

import Warden from '../warden/index';

describe('Tradepair', () => {
  test('Warden Select Symbols', async () => {
    const result = await Warden.selectSymbols('kucoin', 'BTC/USDT');

    expect(result).toBeDefined();
  });

  test('Warden Start', async () => {
    const result = await Warden.start(['kucoin-BTC/USDT', 'binance-BTC/USDT:USDT']);

    expect(result).toBeUndefined();
  });

  test('Parse exchange and contract symbol', () => {
    expect(Warden.parseWatchPair('OKX-BTC/USD:BTC-260925')).toEqual({
      exchange: 'okx',
      symbol: 'BTC/USD:BTC-260925',
    });
  });
});
