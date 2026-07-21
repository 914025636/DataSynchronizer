import { logger } from '../../logger';
import { Emitter } from '../emitter';

import { TradepairQueries } from '../../tradepairs/tradepairs';
import { QuestDBWriter } from '../../questdb';

class TradesEmitter {
  constructor() {
    // Event listeners
    logger.verbose('Trade Emitter started!');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Emitter.on('Trades', (exchange: string, trade: any) => {
      setImmediate(async () => {
        try {
          // Get CCXT standard symbol
          const ccxtSymbol = await TradepairQueries.idToSymbol(exchange, trade.symbol);

          if (ccxtSymbol) {
            // 写入 QuestDB（非阻塞，高性能）
            QuestDBWriter.writeTrade(
              exchange,
              ccxtSymbol,
              trade.side,
              String(trade.price),
              String(trade.quantity),
              String(trade.tradeId),
              trade.time,
            ).catch((err: unknown) => logger.error('QuestDB writeTrade error', err));
          }
        } catch (err) {
          logger.error('Error', err);
        }
      });
    });
  }
}

module.exports = new TradesEmitter();
