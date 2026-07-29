# 历史逐笔成交数据接口指南

本文汇总 Binance、OKX、Bybit、Gate 和 Coinbase 的公共市场成交数据接口，重点说明能否向历史回溯、分页方式，以及是否有官方批量归档。

核对日期：2026-07-18。交易所会调整接口参数、保留周期和限频，生产接入前应再次检查文末官方文档。

## 1. 结论总览

| 交易所   | REST 历史回溯       | 主要接口                                                 | 回溯键                                                     | 官方批量归档                                | 结论                                                               |
| -------- | ------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| Binance  | 支持                | `/api/v3/historicalTrades`、`/fapi/v1/historicalTrades`  | `fromId`                                                   | 有                                          | 原始逐笔可按成交 ID 回溯；大规模回补优先归档                       |
| OKX      | 支持                | `/api/v5/market/history-trades`                          | `after`、`before`、`type`                                  | 有历史市场数据下载服务                      | 可按成交 ID 或时间戳向旧数据分页，但成交存在聚合语义               |
| Bybit    | REST 不支持任意回溯 | `/v5/market/recent-trade`                                | 无历史游标                                                 | 有                                          | REST 仅适合最近窗口；完整历史使用按日 CSV 归档                     |
| Gate     | 支持                | `/api/v4/spot/trades`、`/api/v4/futures/{settle}/trades` | `from`、`to`、`last_id`、`reverse` 或 `offset`，依市场而定 | 未发现与 Binance/Bybit 同类的通用公共归档站 | 按时间或 ID 分页回溯，具体参数随产品线不同                         |
| Coinbase | 支持                | `/products/{product_id}/trades`                          | `after` 响应游标                                           | 未发现通用公共成交归档站                    | Exchange API 可连续向旧数据翻页；Advanced Trade 还支持时间区间查询 |

> “支持历史回溯”不等于能够用一次请求下载完整历史。所有 REST 接口都有单页数量、限频、保留范围或稳定性限制。

## 2. 数据口径

- **原始逐笔成交（raw trade）**：尽量对应撮合产生的独立成交记录，通常带唯一成交 ID。
- **聚合成交（aggregate/compressed trade）**：可能把同一 taker 订单、同一价格或同一时间条件下的多笔撮合合并，不能当成严格的撮合层逐笔。
- 本文只讨论公共市场成交。账户私有成交应使用 `fetchMyTrades` 或交易所的 fills/order history 接口，不属于本文范围。
- `side` 的含义并不统一。Coinbase Exchange/Advanced Trade 返回 maker side；其他交易所应按其字段定义转换，不能直接假设为 taker side。

## 3. Binance

### 3.1 现货

Base URL：`https://api.binance.com`。仅访问公开行情时也可考虑 `https://data-api.binance.vision`。

| 数据类型     | 完整地址                                          | 关键参数                                            | 单页限制            | 说明                                                                                         |
| ------------ | ------------------------------------------------- | --------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| 最近原始逐笔 | `https://api.binance.com/api/v3/trades`           | `symbol`、`limit`                                   | 默认 500，最大 1000 | 只返回最近成交                                                                               |
| 历史原始逐笔 | `https://api.binance.com/api/v3/historicalTrades` | `symbol`、`fromId`、`limit`                         | 默认 500，最大 1000 | 从指定成交 ID 开始返回；通常要求 `X-MBX-APIKEY` 请求头，但不需要请求签名，按当前安全定义复核 |
| 聚合成交     | `https://api.binance.com/api/v3/aggTrades`        | `symbol`、`fromId`、`startTime`、`endTime`、`limit` | 默认 500，最大 1000 | 是 compressed/aggregate trades，不是严格原始逐笔                                             |

历史原始逐笔示例：

```text
GET https://api.binance.com/api/v3/historicalTrades?symbol=BTCUSDT&fromId=123456789&limit=1000
X-MBX-APIKEY: <api-key>
```

持续回溯时保存本页最后一个成交 ID，下一页使用 `fromId = lastId + 1`，并对边界记录去重。

### 3.2 合约

| 市场           | 最近原始逐笔                              | 历史原始逐笔                                        | 聚合成交                                     |
| -------------- | ----------------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| USD-M Futures  | `https://fapi.binance.com/fapi/v1/trades` | `https://fapi.binance.com/fapi/v1/historicalTrades` | `https://fapi.binance.com/fapi/v1/aggTrades` |
| COIN-M Futures | `https://dapi.binance.com/dapi/v1/trades` | `https://dapi.binance.com/dapi/v1/historicalTrades` | `https://dapi.binance.com/dapi/v1/aggTrades` |

合约历史原始逐笔同样以 `symbol`、`fromId` 和 `limit` 为主。USD-M 文档中 `limit` 默认 500、最大 1000；COIN-M 接入时以当前接口页为准。

### 3.3 批量归档

- 归档站：<https://data.binance.vision/>
- 目录与说明：<https://github.com/binance/binance-public-data/>
- 提供现货和合约的日/月 ZIP 文件，适合大范围初始化回补。
- 现货 `trades` 归档来源对应 `/api/v3/historicalTrades`；`aggTrades` 归档仍是聚合口径。
- 2025-01-01 之后部分现货归档时间戳使用微秒，导入前必须识别单位。

## 4. OKX

Base URL：`https://www.okx.com`。

| 数据类型 | 完整地址                                           | 关键参数                                     | 说明                   |
| -------- | -------------------------------------------------- | -------------------------------------------- | ---------------------- |
| 最近成交 | `https://www.okx.com/api/v5/market/trades`         | `instId`、`limit`                            | 最近市场成交           |
| 历史成交 | `https://www.okx.com/api/v5/market/history-trades` | `instId`、`type`、`after`、`before`、`limit` | 公共接口，可向历史分页 |

示例：

```text
GET https://www.okx.com/api/v5/market/history-trades?instId=BTC-USDT&type=1&after=123456789&limit=100
```

官方变更记录给出的分页语义：

- `type=1`：游标按 `tradeId` 解释，也是默认方式。
- `type=2`：游标按毫秒时间戳解释。
- `after`：返回早于指定 `tradeId` 或时间戳的记录，用于向更旧数据翻页。
- `before`：返回新于指定 `tradeId` 的记录，不支持时间戳分页。
- 当前 `limit` 范围和历史保留范围应以 OKX 接口页为准。

OKX 的 trades 数据可能按每个 taker order 和每个成交价聚合。若策略需要“每个 maker fill 一条”的撮合层严格逐笔，需要先用样本核对 `tradeId`、成交量和同时间记录，不能只凭接口名判断。

OKX 已提供历史市场数据服务，支持 trade history 的日/月聚合下载。入口和可用市场可能随区域及版本变化，使用时从官方 Market Data 文档或 Historical Market Data 页面进入，不要硬编码未确认的下载路径。

## 5. Bybit

Bybit V5 公共 REST 只有最近成交接口：

```text
GET https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=1000
```

| 参数       | 说明                                                    |
| ---------- | ------------------------------------------------------- |
| `category` | `spot`、`linear`、`inverse` 或 `option`                 |
| `symbol`   | 交易对或合约代码；期权还可使用 `baseCoin`、`optionType` |
| `limit`    | Spot 为 1-60，默认 60；其他类别为 1-1000，默认 500      |

返回包含 `execId`、`price`、`size`、`side`、`time`、`seq` 等字段。该接口没有时间、成交 ID 或 cursor 参数，因此不能用于任意日期的 REST 历史回溯。

完整回补应使用官方归档：

- 根目录：<https://public.bybit.com/trading/>
- 品种目录示例：<https://public.bybit.com/trading/BTCUSDT/>
- 文件示例：`BTCUSDT2024-01-01.csv.gz`
- 文件按品种、按日组织；不同品种的最早日期不一致，应以目录实际文件为准。

推荐方案是“归档回补到最近完整日 + WebSocket/REST 衔接当前增量”，并对衔接区间重叠采集后去重。

## 6. Gate

Base URL：`https://api.gateio.ws/api/v4`。

| 市场              | 完整地址                                                | 常用历史参数                                                         |
| ----------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Spot              | `https://api.gateio.ws/api/v4/spot/trades`              | `currency_pair`、`limit`、`last_id`、`reverse`、`from`、`to`、`page` |
| Perpetual Futures | `https://api.gateio.ws/api/v4/futures/{settle}/trades`  | `contract`、`limit`、`from`、`to`、`offset`                          |
| Delivery Futures  | `https://api.gateio.ws/api/v4/delivery/{settle}/trades` | `contract`、`limit`、`from`、`to`、`offset`                          |
| Options           | `https://api.gateio.ws/api/v4/options/trades`           | `contract`、`limit`、时间或分页参数，以当前文档为准                  |

Spot 示例：

```text
GET https://api.gateio.ws/api/v4/spot/trades?currency_pair=BTC_USDT&from=1704067200&to=1704153600&limit=1000
```

Gate 各产品线的参数组合并不完全一致：

- Spot 曾增加 `reverse` 以支持向历史追溯，随后增加 `from`、`to` 时间范围。
- Futures 推荐使用 `from`、`to` 获取历史成交，并支持 `offset`；旧的 `last_id` 用法不应套用到所有合约接口。
- 通用分页通常默认 100、最大 1000，但具体 endpoint 可以覆盖该值，接入时以当前 endpoint 参数表为准。
- 公共接口通常按 IP 限频，文档给出的通用参考值为每 endpoint `200 requests / 10 seconds`。
- 时间参数通常是 Unix 秒，可带小数；不要与 Binance/OKX 常见的毫秒时间戳混用。

## 7. Coinbase

### 7.1 Coinbase Exchange API

这是 Coinbase 中最直接的公共历史逐笔分页接口：

```text
GET https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000
```

- 无需认证。
- `limit` 默认和最大值均为 1000。
- 响应头包含 `CB-BEFORE` 和 `CB-AFTER`。
- `after` 获取更旧的页面，方向与很多 API 的直觉相反。
- 向历史回溯时，将本次响应头的 `CB-AFTER` 传给下一次请求：

```text
GET https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000&after=<CB-AFTER>
```

响应中的 `side` 表示 maker side。若需要主动买卖方向，应转换为 taker side，而不是直接原样使用。

### 7.2 Coinbase Advanced Trade 公共市场接口

```text
GET https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/ticker?limit=1000&start=1704067200&end=1704153600
```

- `limit` 必填。
- `start`、`end` 为可选 Unix timestamp 字符串。
- 返回市场成交、best bid 和 best ask；成交字段包括 `trade_id`、`price`、`size`、`time`、`side` 和 `exchange`。
- 公共 Market Data endpoint 无需认证，但默认可能有 1 秒缓存。实时增量更适合 WebSocket，或者根据官方建议使用 `cache-control: no-cache`。

批量长期回溯时，Coinbase Exchange 的响应游标分页更容易形成稳定 checkpoint；Advanced Trade 的时间区间接口适合补指定时间窗。

## 8. CCXT 统一调用

本项目使用 CCXT `^4.5.68`。公共市场成交统一入口是：

```ts
import ccxt from 'ccxt';

const exchange = new ccxt.binance({
  enableRateLimit: true,
  apiKey: process.env.BINANCE_API_KEY,
});

const since = Date.parse('2024-01-01T00:00:00Z');
const trades = await exchange.fetchTrades('BTC/USDT', since, 1000, {});
```

方法签名：

```ts
fetchTrades(symbol, since?, limit?, params?)
```

注意事项：

- `exchange.has.fetchTrades === true` 只表示存在统一成交接口，不表示支持完整历史。
- `since` 是否有效、映射到哪个原生参数、单次时间范围和返回顺序都因交易所而异。
- Bybit 即使支持 `fetchTrades`，底层仍是 recent trades，不能靠反复修改 `since` 获得任意历史。
- 原生分页能力无法被统一参数完整表达时，通过 `params` 传入 `fromId`、`after`、`type` 等交易所专用参数，或直接调用原生 REST。
- 大规模回补优先使用 Binance/Bybit 官方归档；CCXT 更适合小范围补洞和持续增量。

## 9. 回补与落库建议

1. 先记录每个 `(exchange, market_type, symbol)` 的目标起止时间和原生 checkpoint。
2. 有官方归档时先导入完整日/月文件，再用 REST 或 WebSocket 衔接归档尾部。
3. 每次分页保留一小段重叠区间，防止边界遗漏；落库侧必须幂等去重。
4. 原始字段至少保留 `exchange`、`symbol`、`trade_id`、交易所时间戳、价格、数量、原始 `side` 和原始响应。
5. 优先按 `(exchange, market_type, symbol, trade_id)` 去重。若接口是聚合口径或 ID 不能全局唯一，加入时间戳及交易所序列字段。
6. checkpoint 应保存原生 ID/cursor，不要只保存时间戳。同一毫秒可能有多笔成交，仅按时间续传容易漏数或重复。
7. 导入后按分钟聚合数量和成交额，与交易所 OHLCV/volume 做区间核对，及时发现时间单位、side 和数量单位错误。

## 10. 官方资料

- Binance Spot REST：<https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md>
- Binance 公共归档：<https://github.com/binance/binance-public-data/>
- OKX API V5：<https://www.okx.com/docs-v5/en/>
- OKX API 变更记录：<https://www.okx.com/docs-v5/log_en/>
- Bybit Recent Public Trades：<https://bybit-exchange.github.io/docs/v5/market/recent-trade>
- Bybit 公共成交归档：<https://public.bybit.com/trading/>
- Gate API v4：<https://www.gate.com/docs/developers/apiv4/en/>
- Coinbase Exchange Trades：<https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproducttrades>
- Coinbase Advanced Trade Public Endpoints：<https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api>
