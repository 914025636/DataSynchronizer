const closeClient = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.mock('ccxt', () => ({
  pro: {
    binance: jest.fn(() => ({
      watchTrades: jest.fn(() => new Promise(() => undefined)),
      watchOrderBook: jest.fn(() => new Promise(() => undefined)),
      close: closeClient,
    })),
  },
}));

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { openSocket } from '../../exchange/ws_exchanges/binance_ws';

describe('Binance WS Handler', () => {
  let BinanceWS: any = {};
  const tradepairIDs = ['BTC/USDT', 'BTC/USDT:USDT'];

  beforeEach(() => {
    BinanceWS = openSocket(tradepairIDs);
  });
  it('Should stop at call', async () => {
    // Arrange
    // Act
    const close = await BinanceWS();
    // Assert
    expect(close).toBe(true);
    expect(closeClient).toHaveBeenCalledTimes(1);
  });
});
