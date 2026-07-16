import _ from 'lodash';
import { RowDataPacket } from 'mysql2';
import { logger } from '../logger';
import { BaseDB } from '../database';
import { TradepairQueries } from '../tradepairs/tradepairs';

/* Warden intelligent Symbol following system it help to follow new coins or unfollow in-active ones */

export interface WatchPair {
  exchange: string;
  symbol: string;
}

export const parseWatchPair = (value: string): WatchPair => {
  const separatorIndex = value.indexOf('-');

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`Invalid watch pair "${value}", expected exchange-symbol`);
  }

  return {
    exchange: value.slice(0, separatorIndex).trim().toLowerCase(),
    symbol: value.slice(separatorIndex + 1).trim(),
  };
};

class Warden {
  wardenSymbols: string[];
  watchPairs: WatchPair[];

  constructor() {
    this.wardenSymbols = [];
    this.watchPairs = [];
  }

  parseWatchPair(value: string): WatchPair {
    return parseWatchPair(value);
  }

  async start(watchPairs: string[]): Promise<void> {
    try {
      this.watchPairs = watchPairs.map((value) => this.parseWatchPair(value));

      await this.updateLoop();

      logger.verbose('Warden System started');

      return;
    } catch (e) {
      logger.error('Warden System ', e);
    }
  }

  async updateLoop(): Promise<void> {
    try {
      const updatePromises = [];

      for (const watchPair of this.watchPairs) {
        updatePromises.push(this.selectSymbols(watchPair.exchange, watchPair.symbol));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let results: any[] = await Promise.all(updatePromises);

      results = _.flatten(results);

      // Update Tradepairs
      const time = Date.now();

      results.map(async (elem) => {
        await TradepairQueries.addTradepair(elem.exchange, elem.symbol, elem.id, elem.baseId, elem.quoteId, 1, time);
      });

      return;
    } catch (e) {
      logger.error('Warden update loop ', e);
    } finally {
      setTimeout(async () => {
        this.updateLoop();
      }, 60 * 1000);
    }
  }

  /* Add Warden results into the Tradepairs */

  /* Database queries */
  async selectSymbols(exchange: string, quote: string): Promise<RowDataPacket[] | undefined> {
    try {
      const [
        rows,
      ] = await BaseDB.query(
        'SELECT m.exchange, m.symbol, m.id ,m.baseId,m.quoteId FROM `market_datas` as m JOIN `price_tickers` as p ON m.exchange = p.exchange AND m.symbol = p.symbol WHERE m.active = 1 and m.exchange = ? and m.symbol = ? LIMIT 1;',
        [exchange, quote],
      );

      if ((rows as RowDataPacket[]).length > 0) {
        return rows as RowDataPacket[];
      }

      return [] as RowDataPacket[];
    } catch (e) {
      logger.error('Warden SQL error', e);
    }
  }
}

export default new Warden();
