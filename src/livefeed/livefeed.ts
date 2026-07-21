import { isEqual } from 'lodash';
import { RowDataPacket } from 'mysql2';
import { logger } from '../logger';

import { TradepairQueries } from '../tradepairs/tradepairs';

import { openSocket } from '../exchange/ws_exchanges/ccxt_ws';

const watcherTimeout = 5 * 60 * 1000; // 5 minute

class LivefeedAPI {
  public tradepairs: RowDataPacket[];
  public exchanges: string[];
  public websocketAPI: {};
  private allowedTradepairs: Set<string>;

  constructor() {
    this.tradepairs = [];
    this.exchanges = [];
    this.websocketAPI = {};
    this.allowedTradepairs = new Set();
  }

  public async start(exchanges: string[], allowedTradepairs: string[] = []): Promise<void> {
    try {
      this.exchanges = exchanges;
      this.allowedTradepairs = new Set(allowedTradepairs);

      await this.tradepairsWatcher();

      logger.info('LiveFeed API started');
    } catch (e) {
      logger.error('LiveFeed start ', e);
    }
  }

  private async tradepairsWatcher(): Promise<void> {
    // Looking after new tradepairs!
    try {
      const selectedTradepairs = await TradepairQueries.selectTradepairsAll();

      if (!selectedTradepairs) {
        throw new Error('LiveFeed Tradepairs are empty');
      }
      const tradepairs =
        this.allowedTradepairs.size > 0
          ? selectedTradepairs.filter((elem) => this.allowedTradepairs.has(`${elem.exchange}:${elem.symbol}`))
          : selectedTradepairs;

      const newSymbols = tradepairs.map((elem) => `${elem.exchange}:${elem.symbol}`);

      const oldSymbols = this.tradepairs.map((elem) => `${elem.exchange}:${elem.symbol}`);

      // There is no new tradepairs
      if (isEqual(newSymbols, oldSymbols) === true) {
        return;
      }
      this.tradepairs = tradepairs;

      for (const exchange of this.exchanges) {
        if (typeof this.websocketAPI[exchange] !== 'undefined') {
          logger.info(`Close old websocket ${exchange}`);
          this.websocketAPI[exchange]();
        }
        // Open Websockets
        const opened = await this.openWebsocketCandlestick(exchange);

        if (opened) {
          logger.info(`Load new websocket for ${exchange}`);
        }
      }
    } catch (e) {
      logger.error('LiveFeed Tradepairs watcher error ', e);
    } finally {
      setTimeout(() => {
        this.tradepairsWatcher();
      }, watcherTimeout);
    }
  }

  private async openWebsocketCandlestick(exchange: string): Promise<boolean> {
    const websocketSymbols = [];

    for (const tradepair of this.tradepairs) {
      if (tradepair.exchange === exchange) {
        websocketSymbols.push(tradepair.symbol);
      }
    }

    if (websocketSymbols.length > 0) {
      this.websocketAPI[exchange] = openSocket(exchange, websocketSymbols);
      return true;
    }

    return false;
  }
}

export default new LivefeedAPI();
