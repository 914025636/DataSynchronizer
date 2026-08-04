/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import { EMITTER_EVENTS } from '../../constants';
import { Emitter } from '../../emitter/emitter';
import { logger } from '../../logger';
import {
  createLayeredOrderbook,
  diffLayeredOrderbook,
  hasLayeredChanges,
  LayeredOrderbook,
  LayeredOrderbookConfig,
} from '../layered_orderbook';
import { calculateIndexedOrderbookDelta, IndexedOrderbookState, OrderbookState } from '../orderbook_delta';

type ProExchange = ccxt.Exchange & {
  watchTrades: (symbol: string) => Promise<ccxt.Trade[]>;
  watchOrderBook: (symbol: string, limit?: number) => Promise<ccxt.OrderBook>;
  close: () => Promise<void>;
};

type ProExchangeConstructor = new (config?: Record<string, unknown>) => ProExchange;
type CloseSocket = () => boolean;

const websocketRetryBaseDelay = Number(process.env.CCXT_WEBSOCKET_RETRY_BASE_MS || 1000);
const websocketRetryMaxDelay = Number(process.env.CCXT_WEBSOCKET_RETRY_MAX_MS || 30 * 1000);
const websocketRetryJitter = Number(process.env.CCXT_WEBSOCKET_RETRY_JITTER || 0.25);
const retryDelayMs = (attempt = 0): number => {
  const cappedDelay = Math.min(websocketRetryBaseDelay * 2 ** attempt, websocketRetryMaxDelay);
  const jitter = cappedDelay * websocketRetryJitter * Math.random();
  return Math.round(cappedDelay + jitter);
};
const retryDelay = (attempt = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
const websocketIdleTimeout = Number(process.env.CCXT_WEBSOCKET_IDLE_TIMEOUT_MS || 2 * 60 * 1000);
const websocketIdleExitEnabled = process.env.CCXT_WEBSOCKET_IDLE_EXIT === '1';
const websocketErrorWindow = Number(process.env.CCXT_WEBSOCKET_ERROR_WINDOW_MS || 30 * 1000);
const eventLoopCheckInterval = Number(process.env.EVENT_LOOP_CHECK_INTERVAL_MS || 10 * 1000);
const eventLoopDelayWarning = Number(process.env.EVENT_LOOP_DELAY_WARNING_MS || 1000);
const orderbookDepth = Number(process.env.CCXT_ORDERBOOK_DEPTH || 50);
const orderbookExactDepth = Number(process.env.ORDERBOOK_EXACT_DEPTH || 100);
const orderbookPersistInterval = Number(process.env.ORDERBOOK_PERSIST_INTERVAL_MS || 1000);
const orderbookSnapshotInterval = Number(process.env.ORDERBOOK_FULL_SNAPSHOT_INTERVAL_MS || 60000);
const aggregationTickSteps = (process.env.ORDERBOOK_AGGREGATION_TICK_STEPS || '10,20,40,80,160')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
let marketInitializationQueue = Promise.resolve();
let rejectionHandlerInstalled = false;
let eventLoopMonitorInstalled = false;
const recoverableErrorTimes = new Map<string, number>();

const logRecoverableWebsocketError = (key: string, message: string, error: unknown): void => {
  const now = Date.now();
  const lastLogged = recoverableErrorTimes.get(key) || 0;

  if (now - lastLogged >= websocketErrorWindow) {
    recoverableErrorTimes.set(key, now);
    logger.error(message, error);
  }
};

const isRecoverableWebsocketError = (reason: unknown): boolean => {
  const error = reason as { name?: string; message?: string } | null;
  const name = error && typeof error.name === 'string' ? error.name : '';
  const message = error && typeof error.message === 'string' ? error.message : String(reason);

  return (
    ['NetworkError', 'RequestTimeout', 'ExchangeNotAvailable'].includes(name) ||
    /websocket|wss:\/\/|ping-pong|connection closed|socket disconnected|connect timeout/i.test(message)
  );
};

const installRejectionHandler = (): void => {
  if (rejectionHandlerInstalled) return;

  process.on('unhandledRejection', (reason: unknown) => {
    if (isRecoverableWebsocketError(reason)) {
      const error = reason as { message?: string } | null;
      const message = error && typeof error.message === 'string' ? error.message : String(reason);
      const key = message.replace(/\d+/g, '#');
      logRecoverableWebsocketError(`unhandled:${key}`, 'Recovered unhandled CCXT websocket rejection', reason);
      return;
    }

    setImmediate(() => {
      throw reason instanceof Error ? reason : new Error(String(reason));
    });
  });
  rejectionHandlerInstalled = true;
};

const installEventLoopMonitor = (): void => {
  if (eventLoopMonitorInstalled) return;

  let expected = Date.now() + eventLoopCheckInterval;
  const monitor = setInterval(() => {
    const now = Date.now();
    const delay = Math.max(0, now - expected);
    expected = now + eventLoopCheckInterval;

    if (delay >= eventLoopDelayWarning) {
      logger.warn(`Node event loop delayed by ${delay}ms; websocket heartbeats may be affected`);
    }
  }, eventLoopCheckInterval);
  monitor.unref();
  eventLoopMonitorInstalled = true;
};

const runBackgroundTask = (label: string, operation: () => Promise<void>): void => {
  operation().catch((err: unknown) => logger.error(`${label} background task stopped unexpectedly`, err));
};

const enqueueMarketInitialization = async (operation: () => Promise<unknown>): Promise<void> => {
  const queuedOperation = marketInitializationQueue.then(operation, operation);
  marketInitializationQueue = queuedOperation.then(
    () => undefined,
    () => undefined,
  );
  await queuedOperation;
};

export const openSocket = (exchange: string, symbols: string[]): CloseSocket => {
  installRejectionHandler();
  installEventLoopMonitor();
  const exchangeName = exchange.toLowerCase();
  const configuredExchangeDepth = Number(process.env[`CCXT_ORDERBOOK_DEPTH_${exchangeName.toUpperCase()}`]);
  const exchangeOrderbookDepth = Number.isFinite(configuredExchangeDepth)
    ? configuredExchangeDepth
    : orderbookDepth;
  const ExchangeClass = ccxt.pro[exchangeName as keyof typeof ccxt.pro] as ProExchangeConstructor | undefined;

  if (typeof ExchangeClass !== 'function') {
    throw new Error(`${exchangeName} does not support CCXT Pro websocket`);
  }

  const httpsProxy = process.env.CCXT_HTTPS_PROXY?.trim();
  const wssProxy = process.env.CCXT_WSS_PROXY?.trim();
  const client = new ExchangeClass({
    enableRateLimit: true,
    newUpdates: true,
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(wssProxy ? { wssProxy } : {}),
  });

  if (!client.has.watchTrades || !client.has.watchOrderBook) {
    throw new Error(`${exchangeName} must support CCXT Pro watchTrades and watchOrderBook`);
  }

  let closed = false;
  let lastActivity = Date.now();
  let loggedFirstTrade = false;
  let loggedFirstOrderbook = false;
  const orderbooks = new Map<string, IndexedOrderbookState>();
  const latestOrderbooks = new Map<string, OrderbookState>();
  const persistedOrderbooks = new Map<string, LayeredOrderbook>();
  const persistenceConfigs = new Map<string, LayeredOrderbookConfig>();
  const sourceUpdateCounts = new Map<string, number>();
  const lastSequences = new Map<string, number | undefined>();
  const lastSnapshotTimes = new Map<string, number>();

  const inferTickSize = (symbol: string, orderbook: OrderbookState): number => {
    const market = client.market(symbol);
    const configuredTick = Number(market && market.precision && market.precision.price);
    if (Number.isFinite(configuredTick) && configuredTick > 0 && configuredTick < 1) return configuredTick;

    const prices = orderbook.asks.concat(orderbook.bids).map(([price]) => Number(price)).sort((a, b) => a - b);
    let minimumDifference = Number.POSITIVE_INFINITY;
    for (let index = 1; index < prices.length; index += 1) {
      const difference = prices[index] - prices[index - 1];
      if (difference > 0 && difference < minimumDifference) minimumDifference = difference;
    }
    return Number.isFinite(minimumDifference) ? Number(minimumDifference.toPrecision(15)) : 1;
  };

  const persistOrderbooks = (): void => {
    const timestamp = Math.floor(Date.now() / orderbookPersistInterval) * orderbookPersistInterval;

    latestOrderbooks.forEach((latest, symbol) => {
      let config = persistenceConfigs.get(symbol);
      if (!config) {
        const bestAsk = Number(latest.asks[0]?.[0]);
        const bestBid = Number(latest.bids[0]?.[0]);
        config = {
          exactDepth: Math.min(orderbookExactDepth, exchangeOrderbookDepth),
          tickSize: inferTickSize(symbol, latest),
          referencePrice: Number(((bestAsk + bestBid) / 2).toPrecision(15)),
          aggregationTickSteps,
        };
        persistenceConfigs.set(symbol, config);
      }

      const current = createLayeredOrderbook(latest, config);
      const previous = persistedOrderbooks.get(symbol);
      const lastSnapshot = lastSnapshotTimes.get(symbol) || 0;
      const snapshotDue = !previous || timestamp - lastSnapshot >= orderbookSnapshotInterval;
      const payload = snapshotDue ? current : diffLayeredOrderbook(previous, current);

      if (snapshotDue || hasLayeredChanges(payload)) {
        Emitter.emit(EMITTER_EVENTS.OrderBookPersist, exchangeName, {
          symbol,
          ...payload,
          timestamp,
          sequence: lastSequences.get(symbol),
          updateType: snapshotDue ? 'snapshot' : 'second_delta',
          exactDepth: config.exactDepth,
          tickSize: config.tickSize,
          referencePrice: config.referencePrice,
          sourceUpdateCount: sourceUpdateCounts.get(symbol) || 0,
        });
      }

      persistedOrderbooks.set(symbol, current);
      sourceUpdateCounts.set(symbol, 0);
      if (snapshotDue) lastSnapshotTimes.set(symbol, timestamp);
    });
  };

  const persistenceTimer = setInterval(persistOrderbooks, orderbookPersistInterval);
  persistenceTimer.unref();
  const idleWatcher = setInterval(() => {
    const idleTime = Date.now() - lastActivity;

    if (!closed && idleTime >= websocketIdleTimeout) {
      logger.error(`${exchangeName} websocket idle for ${idleTime}ms`);
      if (websocketIdleExitEnabled) {
        logger.error(`${exchangeName} websocket idle watchdog is configured to exit process`);
        process.exit(1);
      }

      // Keep process alive: close the client to force watch loops to reconnect.
      lastActivity = Date.now();
      client.close().catch((err: any) => logger.error(`${exchangeName} websocket reset error`, err));
    }
  }, Math.min(websocketIdleTimeout, 30 * 1000));

  const watchTrades = async (symbol: string): Promise<void> => {
    let retryAttempt = 0;
    let reconnecting = false;

    while (!closed) {
      try {
        const trades = await client.watchTrades(symbol);
        retryAttempt = 0;
        lastActivity = Date.now();
        if (reconnecting) {
          reconnecting = false;
          logger.info(`${exchangeName} trades websocket reconnected for ${symbol}`);
        }
        if (!loggedFirstTrade) {
          loggedFirstTrade = true;
          logger.info(`${exchangeName} received first trade update for ${symbol}`);
        }

        trades.forEach((trade) => {
          Emitter.emit('Trades', exchangeName, {
            time: trade.timestamp || Date.now(),
            symbol: trade.symbol,
            side: trade.side,
            quantity: trade.amount,
            price: trade.price,
            tradeId: trade.id,
          });
        });
      } catch (err) {
        if (!closed) {
          reconnecting = true;
          logRecoverableWebsocketError(
            `${exchangeName}:trades:${symbol}`,
            `${exchangeName} trades websocket error for ${symbol}`,
            err,
          );
          await retryDelay(retryAttempt);
          retryAttempt += 1;
        }
      }
    }
  };

  const watchOrderBook = async (symbol: string): Promise<void> => {
    let retryAttempt = 0;
    let reconnecting = false;

    while (!closed) {
      try {
        const orderbook = await client.watchOrderBook(symbol, exchangeOrderbookDepth);
        retryAttempt = 0;
        lastActivity = Date.now();
        if (reconnecting) {
          reconnecting = false;
          logger.info(`${exchangeName} orderbook websocket reconnected for ${symbol}`);
        }
        if (!loggedFirstOrderbook) {
          loggedFirstOrderbook = true;
          logger.info(`${exchangeName} received first orderbook update for ${symbol}`);
        }
        const current = {
          asks: orderbook.asks
            .slice(0, exchangeOrderbookDepth)
            .map((order) => [Number(order[0]), Number(order[1])]),
          bids: orderbook.bids
            .slice(0, exchangeOrderbookDepth)
            .map((order) => [Number(order[0]), Number(order[1])]),
        } as OrderbookState;
        const previous = orderbooks.get(symbol);
        const { delta, indexed } = calculateIndexedOrderbookDelta(previous, current);

        orderbooks.set(symbol, indexed);
        latestOrderbooks.set(symbol, current);
        sourceUpdateCounts.set(symbol, (sourceUpdateCounts.get(symbol) || 0) + 1);
        lastSequences.set(symbol, orderbook.nonce);

        if (delta.asks.length > 0 || delta.bids.length > 0) {
          Emitter.emit(EMITTER_EVENTS.OrderBookUpdate, exchangeName, {
            symbol,
            asks: delta.asks,
            bids: delta.bids,
            timestamp: orderbook.timestamp || Date.now(),
            sequence: orderbook.nonce,
            updateType: previous ? 'delta' : 'snapshot',
          });
        }
      } catch (err) {
        if (!closed) {
          reconnecting = true;
          logRecoverableWebsocketError(
            `${exchangeName}:orderbook:${symbol}`,
            `${exchangeName} orderbook websocket error for ${symbol}`,
            err,
          );
          await retryDelay(retryAttempt);
          retryAttempt += 1;
        }
      }
    }
  };

  const initialize = async (): Promise<void> => {
    let retryAttempt = 0;

    while (!closed) {
      try {
        await enqueueMarketInitialization(() => client.loadMarkets());
        symbols.forEach((symbol) => {
          runBackgroundTask(`${exchangeName} ${symbol} trades`, () => watchTrades(symbol));
          runBackgroundTask(`${exchangeName} ${symbol} orderbook`, () => watchOrderBook(symbol));
        });
        return;
      } catch (err) {
        if (!closed) {
          const delay = Math.min(1000 * 2 ** retryAttempt, 30 * 1000);
          logger.error(`${exchangeName} websocket initialization error; retrying in ${delay}ms`, err);
          await retryDelay(retryAttempt);
          retryAttempt += 1;
        }
      }
    }
  };

  runBackgroundTask(`${exchangeName} initialization`, initialize);

  return (): boolean => {
    closed = true;
    clearInterval(idleWatcher);
    clearInterval(persistenceTimer);
    client.close().catch((err: any) => logger.error(`${exchangeName} websocket close error`, err));
    return true;
  };
};
