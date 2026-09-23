import { logger } from '../../logger';
import { Emitter } from '../emitter';

import { TradepairQueries } from '../../tradepairs/tradepairs';
import { MarketStreamProducer } from '../../redis/market_stream_client';
import { MARKET_STREAMS } from '../../redis/market_streams';

const marketStreamProducer = new MarketStreamProducer(undefined, 'trades');
let lastStreamErrorAt = 0;
let suppressedStreamErrors = 0;

function logStreamError(error: unknown): void {
  const now = Date.now();
  if (now - lastStreamErrorAt < 30000) {
    suppressedStreamErrors += 1;
    return;
  }
  const suffix = suppressedStreamErrors > 0 ? ` (suppressed ${suppressedStreamErrors} similar errors)` : '';
  logger.error(`Redis market trade stream write error${suffix}`, error);
  lastStreamErrorAt = now;
  suppressedStreamErrors = 0;
}

class TradesEmitter {
  constructor() {
    // Event listeners
    logger.verbose('Trade Emitter started!');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Emitter.on('Trades', (exchange: string, trade: any, acknowledge?: (error?: unknown) => void) => {
      TradepairQueries.idToSymbol(exchange, trade.symbol)
        .then((ccxtSymbol) => {
          if (!ccxtSymbol) throw new Error('Trade symbol lookup failed');

          return marketStreamProducer.append(MARKET_STREAMS.trades, {
            schemaVersion: 1,
            eventType: 'trade',
            exchange,
            symbol: ccxtSymbol,
            eventTime: trade.time,
            ingestedAt: Date.now(),
            side: trade.side,
            price: String(trade.price),
            quantity: String(trade.quantity),
            tradeId: String(trade.tradeId),
          });
        })
        .then(() => acknowledge?.())
        .catch((err: unknown) => {
          logStreamError(err);
          acknowledge?.(err);
        });
    });
  }
}

module.exports = new TradesEmitter();
