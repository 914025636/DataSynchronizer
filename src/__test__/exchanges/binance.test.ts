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
    const close = BinanceWS();
    // Assert
    expect(close).toBe(true);
  });
});
