const MAX_TABLE_NAME_LENGTH = 127;

export type QuestDBMarketTables = {
  marketKey: string;
  tradesTable: string;
  orderbookDeltaTable: string;
};

function readableComponent(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_') || 'market'
  );
}

export function marketTableName(exchange: string, symbol: string, suffix: string): string {
  const [marketSymbol, settlementCurrency] = symbol.split(':', 2);
  const marketType = settlementCurrency ? 'swap' : 'spot';
  const readable = `${readableComponent(exchange)}_${readableComponent(marketSymbol)}`;
  const reservedLength = marketType.length + suffix.length + 2;
  const base = readable.slice(0, MAX_TABLE_NAME_LENGTH - reservedLength).replace(/_+$/g, '') || 'market';

  return `${base}_${marketType}_${suffix}`;
}

export function questdbTradesTableName(exchange: string, symbol: string): string {
  return marketTableName(exchange, symbol, 'trades');
}

export function questdbOrderbookDeltaTableName(exchange: string, symbol: string): string {
  return marketTableName(exchange, symbol, 'orderbook_delta');
}

export function questdbMarketTables(exchange: string, symbol: string): QuestDBMarketTables {
  return {
    marketKey: `${exchange}\0${symbol}`,
    tradesTable: questdbTradesTableName(exchange, symbol),
    orderbookDeltaTable: questdbOrderbookDeltaTableName(exchange, symbol),
  };
}
