import { Utils } from '../../utils';
import { logger } from '../../logger';
import { Emitter } from '../emitter';

import { TradepairQueries } from '../../tradepairs/tradepairs';
import { DBQueries } from '../../database/queries';
import { TableTemplates } from '../../database/queries/enums';
import { QuestDBWriter } from '../../questdb';

const tableNameCache: Set<string> = new Set();

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

            const tableName = Utils.tradesName(exchange, ccxtSymbol);

            // Use Set for Table name check cache
            if (tableNameCache.has(tableName)) {
              await DBQueries.tradesReplace(tableName, trade);
              return;
            }

            await this.createTable(tableName);
          }
        } catch (err) {
          logger.error('Error', err);
        }
      });
    });
  }

  async createTable(tableName: string): Promise<void> {
    try {
      if (await DBQueries.tableCheck(tableName)) {
        tableNameCache.add(tableName);
        return;
      }

      await DBQueries.createNewTableFromTemplate(TableTemplates.Trades, tableName);
    } catch (err) {
      logger.error('Error', err);
    }
  }
}

module.exports = new TradesEmitter();
