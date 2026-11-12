import _ from 'lodash';
import { isArray } from 'util';
import { RowDataPacket } from 'mysql2';
import { logger } from '../logger';
import { CCXT_API } from '../exchange/ccxt_controller';
import { BaseDB } from '../database';

const MARKET_DATA_INSERT_CHUNK_SIZE = 200;

class MarketDataClass {
  exchanges: string[];
  constructor() {
    this.exchanges = [];
  }

  async start(exchanges: string[]): Promise<void> {
    try {
      this.exchanges = exchanges;

      await this.updateLoop();
    } catch (e) {
      logger.error('MarketDatas start ', e);
    }
  }

  async updateLoop(): Promise<void> {
    try {
      const updatePromises: Array<Promise<void>> = [];

      for (let i = 0; i < this.exchanges.length; i++) {
        const exchange = this.exchanges[i];

        updatePromises.push(this.updateMarketData(exchange));
      }

      if (updatePromises.length > 0) {
        logger.verbose('Marketdata initial snapshot');
        await Promise.all(updatePromises);
      }
    } catch (e) {
      logger.error('Marketdata Update ', e);
    }
  }

  async updateMarketData(exchange: string): Promise<void> {
    // Looking after new tradepairs!
    try {
      const marketData = await this.marketDataSelect(exchange);
      const newMarketData = await CCXT_API.getMarketdata(exchange);

      if (_.isObject(newMarketData)) {
        // Add exchange into MarketDatas
        const convertedNewMarketData = Object.values(newMarketData).map((elem) => {
          return { ...elem, ...{ exchange } };
        });

        const storedSymbols = marketData ? marketData.map((market) => market.symbol).sort() : [];
        const newSymbols = convertedNewMarketData.map((market) => market.symbol).sort();

        if (!marketData || !_.isEqual(storedSymbols, newSymbols)) {
          await this.marketDataReplace(exchange, convertedNewMarketData);
          logger.verbose(`New market data for ${exchange}`);
          return;
        }
      }

      return;
    } catch (e) {
      logger.error('Update_tradepairs', e);
    }
  }

  async marketDataSelect(exchange: string): Promise<RowDataPacket[] | undefined> {
    try {
      const [rows] = await BaseDB.query('SELECT * FROM `market_datas` WHERE exchange = ?;', [exchange]);

      if (!isArray(rows)) {
        throw new Error('Market data query failed, reason: not array');
      }

      return rows as RowDataPacket[];
    } catch (e) {
      logger.error('Error', e);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async marketDataReplace(exchange: string, marketData: any[]): Promise<void> {
    const connection = await BaseDB.getConnection();

    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM `market_datas` WHERE exchange = ?;', [exchange]);

      // Stringify JSONs for database storage
      const marketDataValues = marketData.map((e) => {
        // Convert to simple array
        return [
          e.exchange,
          JSON.stringify(e.limits),
          JSON.stringify(e.precision),
          e.tierBased ,
          e.percentage ,
          e.taker,
          e.maker,
          e.id,
          e.symbol,
          e.baseId,
          e.quoteId,
          e.base,
          e.quote,
          e.active ,
          JSON.stringify(e.info),
        ];
      });

      // Large exchanges exceed max_allowed_packet in a single statement
      for (const chunk of _.chunk(marketDataValues, MARKET_DATA_INSERT_CHUNK_SIZE)) {
        await connection.query(
          'REPLACE INTO `market_datas` (`exchange`, `limits`, `precision_data`, `tierBased`, `percentage`, `taker`, `maker`, `id`, `symbol`, `baseId`, `quoteId`, `base`, `quote`, `active`, `info`) VALUES ?',
          [chunk],
        );
      }

      await connection.commit();

      return;
    } catch (e) {
      await connection.rollback().catch(() => undefined);
      logger.error('Error', e);
    } finally {
      connection.release();
    }
  }
}

export const MarketDataAPI = new MarketDataClass();
