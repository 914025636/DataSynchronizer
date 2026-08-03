/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import { EMITTER_EVENTS } from '../../constants';
import { Emitter } from '../../emitter/emitter';
import { logger } from '../../logger';
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
  const ExchangeClass = ccxt.pro[exchangeName as keyof typeof ccxt.pro] as ProExchangeConstructor | undefined;

  if (typeof ExchangeClass !== 'function') {
    throw new Error(`${exchangeName} does not support CCXT Pro websocket`);
  }

  const httpsProxy = process.env.CCXT_HTTPS_PROXY?.trim();
  const wssProxy = process.env.CCXT_WSS_PROXY?.trim();
  const exchangeOrderbookDepth = exchangeName === 'okx' ? 5 : orderbookDepth;
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
    client.close().catch((err: any) => logger.error(`${exchangeName} websocket close error`, err));
    return true;
  };
};
