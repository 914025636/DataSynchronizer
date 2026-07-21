/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import { logger } from '../logger';

type CcxtInstance = {
  exchangeName: string;
  api: ccxt.Exchange;
};

export type MarketType = 'spot' | 'swap';

type ExchangeConstructor = new (config?: Record<string, unknown>) => ccxt.Exchange;

const getProxyConfig = (): Record<string, string> => {
  const httpsProxy = process.env.CCXT_HTTPS_PROXY?.trim();

  return httpsProxy ? { httpsProxy } : {};
};

class ExchangeAPI {
  exchanges: CcxtInstance[];
  marketTypes: Map<string, MarketType[]>;
  constructor() {
    this.exchanges = [];
    this.marketTypes = new Map();
  }

  configureMarketTypes(config: string | undefined): void {
    this.marketTypes.clear();

    if (!config) {
      return;
    }

    config.split(',').forEach((entry) => {
      const [exchange, types = ''] = entry.split(':');
      const marketTypes = types
        .split('|')
        .map((type) => type.trim())
        .filter((type): type is MarketType => type === 'spot' || type === 'swap');

      if (exchange && marketTypes.length > 0) {
        this.marketTypes.set(exchange.trim().toLowerCase(), marketTypes);
      }
    });
  }

  getMarketTypes(exchange: string): MarketType[] {
    return this.marketTypes.get(exchange.toLowerCase()) || ['spot'];
  }

  private requireCapability(api: ccxt.Exchange, capability: 'fetchTickers' | 'fetchOHLCV'): void {
    if (!api.has[capability]) {
      const alternative = capability === 'fetchTickers' ? 'fetchTicker(symbol)' : 'fetchTrades(symbol)';
      throw new Error(`${api.id} does not support CCXT ${capability}; use ${alternative} instead`);
    }
  }

  async getMarketdata(exchange: string): Promise<any> {
    try {
      const API = this.loadExchangeAPI(exchange);

      const marketdata = await API.loadMarkets();

      const marketTypes = this.getMarketTypes(exchange);

      return Object.entries(marketdata).reduce((markets, [symbol, market]) => {
        if (
          market &&
          marketTypes.some((type) => (type === 'spot' ? market.spot : market.swap && market.linear))
        ) {
          markets[symbol] = market;
        }

        return markets;
      }, {} as Record<string, ccxt.Market>);
    } catch (e) {
      logger.error('CCXT marketdata error ', e);
    }
  }

  async getPriceTickers(exchange: string): Promise<any> {
    try {
      const API = this.loadExchangeAPI(exchange);
      this.requireCapability(API, 'fetchTickers');

      const tickerGroups = await Promise.all(
        this.getMarketTypes(exchange).map((type) =>
          API.fetchTickers(undefined, type === 'swap' ? { type, subType: 'linear' } : { type }),
        ),
      );

      return Object.assign({}, ...tickerGroups);
    } catch (e) {
      logger.error('CCXT marketdata error ', e);
    }
  }

  async getCandlestick(
    symbol: string,
    exchange: string,
    interval: string,
    since: any = undefined,
    limit = 100,
  ): Promise<Array<[number, number, number, number, number, number]> | undefined> {
    try {
      const API = this.loadExchangeAPI(exchange);
      this.requireCapability(API, 'fetchOHLCV');

      const candledata = await API.fetchOHLCV(symbol, interval, since, limit);

      return candledata.filter(
        (candle): candle is [number, number, number, number, number, number] =>
          candle.length >= 6 && candle.slice(0, 6).every((value) => typeof value === 'number'),
      );

      /*
      1504541580000, // UTC timestamp in milliseconds, integer
        4235.4,        // (O)pen price, float
        4240.6,        // (H)highest price, float
        4230.0,        // (L)lowest price, float
        4230.7,        // (C)losing price, float
        37.72941911    // (V)volume (in terms of the base currency), float 
      */
    } catch (e) {
      logger.error('CCXT candlestick error ', e);
    }
  }

  /* CCXT API STUFF */
  _isExchangeLoaded(exchange: string): boolean {
    const exchangeName = exchange.toLowerCase();

    if (this.exchanges.find((e) => e.exchangeName === exchangeName)) {
      return true;
    }

    return false;
  }

  loadExchangeAPI(exchange: string): ccxt.Exchange {
    try {
      const exchangeName = exchange.toLowerCase();

      // Check if CCXT API already loaded
      const exchangeData = this.exchanges.find((e) => e.exchangeName === exchangeName);

      if (exchangeData?.api) {
        return exchangeData.api;
      }

      return this.initNewExchanges(exchangeName).api;
    } catch (e) {
      logger.error('CCXT load API error ', e);
      throw e;
    }
  }

  initNewExchanges(exchange: string): CcxtInstance {
    const exchangeName = exchange.toLowerCase();
    const ExchangeClass = ccxt[exchangeName as keyof typeof ccxt] as ExchangeConstructor | undefined;

    if (typeof ExchangeClass === 'function') {
      const api = new ExchangeClass({ enableRateLimit: true, ...getProxyConfig() });
      const unsupportedMarketTypes = this.getMarketTypes(exchangeName).filter((type) => !api.has[type]);

      if (unsupportedMarketTypes.length > 0) {
        throw new Error(`${exchangeName} does not support ${unsupportedMarketTypes.join(',')} markets`);
      }

      if (!this._isExchangeLoaded(exchange)) {
        this.exchanges.push({ exchangeName, api });
      }

      return { exchangeName, api };
    }
    throw new Error(`Invalid Exchange ${exchangeName}`);
  }

  /* CCXT API STUFF */
}

export const CCXT_API = new ExchangeAPI();
