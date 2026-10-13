/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import { EMITTER_EVENTS } from '../../constants';
import { Emitter } from '../../emitter/emitter';
import { logger } from '../../logger';
import { configureCcxtTransport, getCcxtProxy } from '../ccxt_proxy';
import { recoverBinanceTrades, TradeCheckpoint } from '../trade_recovery';
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
const orderbookPersistInterval = Number(process.env.ORDERBOOK_PERSIST_INTERVAL_MS || 1000);
const orderbookSnapshotInterval = Number(process.env.ORDERBOOK_FULL_SNAPSHOT_INTERVAL_MS || 60000);
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

  const httpsProxy = getCcxtProxy('CCXT_HTTPS_PROXY', exchangeName);
  const wssProxy = getCcxtProxy('CCXT_WSS_PROXY', exchangeName);
  const socksProxy = getCcxtProxy('CCXT_SOCKS_PROXY', exchangeName);
  const wsSocksProxy = getCcxtProxy('CCXT_WS_SOCKS_PROXY', exchangeName);
  if (httpsProxy && socksProxy) {
    throw new Error('Configure only one of CCXT_HTTPS_PROXY or CCXT_SOCKS_PROXY');
  }
  if (wssProxy && wsSocksProxy) {
    throw new Error('Configure only one of CCXT_WSS_PROXY or CCXT_WS_SOCKS_PROXY');
  }
  const exchangeOptions =
    exchangeName === 'bybit' || exchangeName === 'binance'
      ? {
          options: {
            fetchMarkets: {
              types: Array.from(
                new Set(symbols.map((symbol) => (symbol.includes(':') ? 'linear' : 'spot'))),
              ),
            },
          },
        }
      : {};
  const client = new ExchangeClass({
    ...(exchangeName === 'binance' && process.env.BINANCE_API_KEY ? { apiKey: process.env.BINANCE_API_KEY } : {}),
    enableRateLimit: true,
    newUpdates: true,
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(wssProxy ? { wssProxy } : {}),
    ...(socksProxy ? { socksProxy } : {}),
    ...(wsSocksProxy ? { wsSocksProxy } : {}),
    ...exchangeOptions,
  });
  configureCcxtTransport(client);

  if (!client.has.watchTrades || !client.has.watchOrderBook) {
    throw new Error(`${exchangeName} must support CCXT Pro watchTrades and watchOrderBook`);
  }

  let closed = false;
  let lastActivity = Date.now();
  let loggedFirstTrade = false;
  let loggedFirstOrderbook = false;
  const latestOrderbooks = new Map<string, OrderbookState>();
  const persistedOrderbooks = new Map<string, IndexedOrderbookState>();
  const sourceUpdateCounts = new Map<string, number>();
  const lastSequences = new Map<string, number | undefined>();
  const lastSnapshotTimes = new Map<string, number>();

  const persistOrderbook = async (symbol: string, latest: OrderbookState, timestamp: number): Promise<void> => {
    const updateCount = sourceUpdateCounts.get(symbol) || 0;
    const previous = persistedOrderbooks.get(symbol);
    const snapshotDue = !previous || timestamp - (lastSnapshotTimes.get(symbol) || 0) >= orderbookSnapshotInterval;
    if (!snapshotDue && updateCount === 0) return;
    const { delta, indexed } = calculateIndexedOrderbookDelta(snapshotDue ? undefined : previous, latest);

    if (snapshotDue || delta.asks.length > 0 || delta.bids.length > 0) {
      await new Promise<void>((resolve, reject) => Emitter.emit(EMITTER_EVENTS.OrderBookPersist, exchangeName, {
        symbol,
        asks: delta.asks,
        bids: delta.bids,
        timestamp,
        sequence: lastSequences.get(symbol),
        updateType: snapshotDue ? 'snapshot' : 'delta',
        sourceUpdateCount: updateCount,
      }, (error?: unknown) => error ? reject(error) : resolve()));
    }

    persistedOrderbooks.set(symbol, indexed);
    sourceUpdateCounts.set(symbol, Math.max(0, (sourceUpdateCounts.get(symbol) || 0) - updateCount));
    if (snapshotDue) lastSnapshotTimes.set(symbol, timestamp);
  };

  let persisting = false;
  const persistOrderbooks = async (): Promise<void> => {
    if (persisting) return;
    persisting = true;
    try {
      const timestamp = Math.floor(Date.now() / orderbookPersistInterval) * orderbookPersistInterval;
      const failures = await Promise.all(
        Array.from(latestOrderbooks, ([symbol, latest]) =>
          persistOrderbook(symbol, latest, timestamp).then(() => undefined, (error: unknown) => error || new Error(String(error)))),
      );
      const failure = failures.find((error) => error !== undefined);
      if (failure) throw failure;
    } finally {
      persisting = false;
    }
  };

  const persistenceTimer = setInterval(() => {
    persistOrderbooks().catch((error) => logger.error('Orderbook persistence failed; baseline retained', error));
  }, orderbookPersistInterval);
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

  const emitTrade = (trade: ccxt.Trade): Promise<void> => {
    const accepted = new Promise<void>((resolve, reject) => Emitter.emit('Trades', exchangeName, {
      time: trade.timestamp || Date.now(),
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.amount,
      price: trade.price,
      tradeId: trade.id,
    }, (error?: unknown) => error ? reject(error) : resolve()));
    // Prevents an unhandled rejection when a later recovery error abandons this batch.
    accepted.catch(() => undefined);
    return accepted;
  };

  const watchTrades = async (symbol: string): Promise<void> => {
    let retryAttempt = 0;
    let reconnecting = false;
    const checkpoint = exchangeName === 'binance' ? new TradeCheckpoint(exchangeName, symbol) : undefined;
    let lastTrade = checkpoint?.load();
    let pendingTrades: ccxt.Trade[] = [];

    while (!closed) {
      try {
        if (!pendingTrades.length) pendingTrades = await client.watchTrades(symbol);
        const trades = pendingTrades;
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

        const accepted: Promise<void>[] = [];
        let lastEmitted = lastTrade;
        for (const trade of trades) {
          if (exchangeName === 'binance' && lastEmitted) {
            if (Number(trade.id) <= Number(lastEmitted.id)) continue;
            const recovered = await recoverBinanceTrades(client, symbol, lastEmitted, trade);
            recovered.forEach((missed) => accepted.push(emitTrade(missed)));
          }
          accepted.push(emitTrade(trade));
          lastEmitted = trade;
        }
        await Promise.all(accepted);
        if (checkpoint && lastEmitted && lastEmitted !== lastTrade) await checkpoint.save(lastEmitted);
        lastTrade = lastEmitted;
        pendingTrades = [];
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

        latestOrderbooks.set(symbol, current);
        sourceUpdateCounts.set(symbol, (sourceUpdateCounts.get(symbol) || 0) + 1);
        lastSequences.set(symbol, orderbook.nonce);

        // Diffing is deferred to the persistence timer; listeners receive the full book.
        Emitter.emit(EMITTER_EVENTS.OrderBookUpdate, exchangeName, {
          symbol,
          asks: current.asks,
          bids: current.bids,
          timestamp: orderbook.timestamp || Date.now(),
          sequence: orderbook.nonce,
          updateType: 'snapshot',
        });
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
