const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['binance', 'bybit', 'okx'];
const GOLD = /^(XAU|XAUT|PAXG|TXAU)\b/;

function configure(id, env) {
  const exchange = new ccxt[id]({ enableRateLimit: true, timeout: 30000 });
  exchange.fetchImplementation = require('node-fetch');
  const socks = env['CCXT_SOCKS_PROXY_' + id.toUpperCase()] || env.CCXT_SOCKS_PROXY;
  const https = env['CCXT_HTTPS_PROXY_' + id.toUpperCase()] || env.CCXT_HTTPS_PROXY;
  if (socks) exchange.socksProxy = socks;
  else if (https) exchange.httpsProxy = https;
  return exchange;
}

async function firstCandle(exchange, symbol, timeframe) {
  const rows = await exchange.fetchOHLCV(symbol, timeframe, 0, 1);
  return rows.length ? new Date(rows[0][0]).toISOString() : null;
}

async function probe(id, env) {
  const exchange = configure(id, env);
  try {
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets).filter(symbol => GOLD.test(symbol) && markets[symbol].quote === 'USDT' && markets[symbol].active);
    for (const symbol of symbols) {
      const market = markets[symbol];
      const finest = ['1s', '1m'].find(timeframe => exchange.timeframes && exchange.timeframes[timeframe]);
      const result = { exchange: id, symbol, type: market.type, finestTimeframe: finest || null };
      for (const timeframe of ['1s', '1m']) {
        if (!exchange.timeframes || !exchange.timeframes[timeframe]) continue;
        try { result[timeframe + 'Start'] = await firstCandle(exchange, symbol, timeframe); }
        catch (error) { result[timeframe + 'Start'] = 'ERR:' + error.constructor.name; }
      }
      console.log(JSON.stringify(result));
    }
    if (!symbols.length) console.log(JSON.stringify({ exchange: id, symbol: null, note: 'no active gold/USDT market' }));
  } catch (error) {
    console.log(JSON.stringify({ exchange: id, error: error.constructor.name, message: String(error.message).slice(0, 160) }));
  } finally {
    await exchange.close();
  }
}

async function main() {
  const env = { ...require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../.env'))), ...process.env };
  for (const id of IDS) await probe(id, env);
}

main();
