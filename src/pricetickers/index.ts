import _ from 'lodash';
import { BaseDB } from '../database';
import { CCXT_API } from '../exchange/ccxt_controller';
import { logger } from '../logger';

class PriceTickers {
  exchanges: string[];
  updateFrequency: number;
  constructor() {
    this.exchanges = [];
    this.updateFrequency = 30 * 1000; // in ms
  }

  async start(exchanges: string[]): Promise<void> {
    try {
      this.exchanges = exchanges;

      await this.updateLoop();
    } catch (e) {
      logger.error('PriceTickers start ', e);
    }
  }

  async updateLoop(): Promise<void> {
    try {
      const updatePromises = [];

      for (const exchange of this.exchanges) {
        updatePromises.push(this.update(exchange));
      }

      if (updatePromises.length > 0) {
        logger.verbose('PriceTickers Update loop');
        await Promise.all(updatePromises);
      }
    } catch (e) {
      logger.error('PriceTickers Update loop', e);
    } finally {
      setTimeout(() => {
        this.updateLoop();
      }, this.updateFrequency);
    }
  }

  async update(exchange: string): Promise<void> {
    // Looking after new tradepairs!
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let priceTickers: any[] = [];

      priceTickers = await CCXT_API.getPriceTickers(exchange);

      const time = Date.now();

      if (_.isObject(priceTickers) === false) {
        return;
      }
      // Add exchange,time,quoteVolume into PriceTickers
      priceTickers = Object.values(priceTickers).map((elem) => {
        // eslint-disable-next-line no-param-reassign
        elem.exchange = exchange;
        // eslint-disable-next-line no-param-reassign
        elem.timestamp = time;

        // Calculate quoteVolume where it is missing
        if (elem.quoteVolume === undefined && elem.baseVolume > 0) {
          // eslint-disable-next-line no-param-reassign
          elem.quoteVolume = elem.baseVolume * ((elem.high + elem.low) / 2);
        }

        return elem;
      });

      priceTickers = priceTickers.filter((elem) => typeof elem.symbol === 'string');

      if (priceTickers.length > 0) {
        await this.replaceDB(priceTickers);
      }

      return;
    } catch (e) {
      logger.error('PriceTickers Update ', e);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async replaceDB(priceTickers: any[]): Promise<void> {
    const nullable = (value: unknown): unknown => (value === undefined ? null : value);

    // Stringify JSON for database storage
    const values = priceTickers.map((e) => [
      e.exchange,
      e.symbol || e.info.symbol,
      e.timestamp,
      nullable(e.high),
      nullable(e.low),
      nullable(e.bid),
      nullable(e.ask),
      nullable(e.last),
      nullable(e.change),
      nullable(e.percentage),
      nullable(e.baseVolume),
      nullable(e.quoteVolume),
      JSON.stringify(e.info),
    ]);

    try {
      await BaseDB.query(
        'REPLACE INTO `price_tickers` (`exchange`, `symbol`, `timestamp`, `high`, `low`, `bid`, `ask`, `last`, `change`, `percentage`, `baseVolume`, `quoteVolume`, `info`) VALUES ?',
        [values],
      );
    } catch (err) {
      logger.error('Price ticker batch write failed', err);
    }
  }
}

export default new PriceTickers();
