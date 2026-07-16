/* eslint-disable import/first */
require('dotenv').config();
require('./emitter'); // Eventemitter class
require('./redis');

import { logger } from './logger';

import SentimentAPI from './sentiment/sentiment';
import LivefeedAPI from './livefeed/livefeed';
import { MarketDataAPI } from './marketdata';
import PriceTickersAPI from './pricetickers';
import WardenClass, { parseWatchPair } from './warden';
import { CCXT_API } from './exchange/ccxt_controller';
import { QuestDBWriter } from './questdb';

// Load Dotenv variables
const {
  MarketData,
  Sentiment,
  Livefeed,
  PriceTicker,
  Warden,
  exchangeList,
  watchPairs,
  exchangeMarketTypes,
} = process.env;

const wardenWatchPairs =
  watchPairs !== undefined ? watchPairs.split(',').map((elem) => elem.trim()).filter((elem) => elem.length > 0) : [];
const configuredExchanges = exchangeList !== undefined ? exchangeList.split(',').map((elem) => elem.trim()) : [];
const watchPairExchanges = wardenWatchPairs.map((value) => parseWatchPair(value).exchange);
const exchanges = Array.from(new Set(configuredExchanges.concat(watchPairExchanges).filter((elem) => elem.length > 0)));
// Load Dotenv variables

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info(`Received ${signal}, flushing QuestDB data`);
  await QuestDBWriter.close();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function main(): Promise<void> {
  logger.info('StockML Synchronizer started');
  CCXT_API.configureMarketTypes(exchangeMarketTypes);

  // Available Symbols and Precision informations from exchanges
  if (MarketData && parseInt(MarketData) === 1) {
    await MarketDataAPI.start(exchanges);
  }
  // Current prices and other Symbol datas like daily change, daily volume
  if (PriceTicker && parseInt(PriceTicker) === 1) {
    await PriceTickersAPI.start(exchanges);
  }
  // Twitter/Reddit API
  if (Sentiment && parseInt(Sentiment) === 1) {
    await SentimentAPI.start();
  }
  // Websocket support check exchanges/ws_exchanges for support!
  if (Livefeed && parseInt(Livefeed) === 1) {
    await LivefeedAPI.start(exchanges);
    require('./workers/index');
  }
  // Warden initializes the configured exact tradepairs
  if (Warden && parseInt(Warden) === 1) {
    await WardenClass.start(wardenWatchPairs);
  }

  logger.info('Startup finished');
}

main().catch((err) => {
  logger.error('Startup error', err);
  process.exit(1);
});
