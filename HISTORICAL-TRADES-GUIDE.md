# 历史逐笔成交数据接口指南

本文汇总 Binance、OKX、Bybit、Gate 和 Coinbase 的公共市场成交数据接口，重点说明能否向历史回溯、分页方式，以及是否有官方批量归档。

核对日期：2026-07-29。交易所会调整接口参数、保留周期和限频，生产接入前应再次检查文末官方文档。

## 1. 结论总览

| 交易所   | REST 历史回溯       | 主要接口                                                 | 回溯键                                                     | 官方批量归档                                | 无归档时最大回溯                                   | 结论                                                               |
| -------- | ------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Binance  | 支持                | `/api/v3/historicalTrades`、`/fapi/v1/historicalTrades`  | `fromId`                                                   | 有                                          | 不适用                                             | 原始逐笔可按成交 ID 回溯；大规模回补优先归档                       |
| OKX      | 支持                | `/api/v5/market/history-trades`                          | `after`、`before`、`type`                                  | 有历史市场数据下载服务                      | 不适用                                             | 可按成交 ID 或时间戳向旧数据分页，但成交存在聚合语义               |
| Bybit    | REST 不支持任意回溯 | `/v5/market/recent-trade`                                | 无历史游标                                                 | 有                                          | 不适用                                             | REST 仅适合最近窗口；完整历史使用按日 CSV 归档                     |
| Gate     | 支持                | `/api/v4/spot/trades`、`/api/v4/futures/{settle}/trades` | `from`、`to`、`last_id`、`reverse` 或 `offset`，依市场而定 | 未发现与 Binance/Bybit 同类的通用公共归档站 | 官方未公布固定上限；可查至服务端仍保留的最早成交   | 按时间或 ID 分页回溯，具体参数随产品线不同                         |
| Coinbase | 支持                | `/products/{product_id}/trades`                          | `after` 响应游标                                           | 未发现通用公共成交归档站                    | 官方未公布固定上限；可分页至服务端仍保留的最早成交 | Exchange API 可连续向旧数据翻页；Advanced Trade 还支持时间区间查询 |

> “支持历史回溯”不等于能够用一次请求下载完整历史。所有 REST 接口都有单页数量、限频、保留范围或稳定性限制。

> 表中的“官方未公布固定上限”表示官方文档没有承诺固定保留天数，不等于永久保存。生产接入时应实际分页探测每个市场的最早记录，并记录探测日期。

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

### 4.1 官方归档获取

OKX 的归档通过官网 **Historical Market Data** 下载器提供，不是像 Binance、Bybit 那样公开一个稳定、可遍历的文件目录。获取步骤如下：

1. 登录 OKX 官网，在页脚或帮助中心搜索 `Historical Market Data`；如果所在地区页面没有该入口，从 [API 文档](https://www.okx.com/docs-v5/en/) 的 Market Data 章节进入当前下载页。
2. 在下载器中选择 `Trade history`，再选择产品类型、交易标的和日期范围。
3. 日文件适合增量回补，月文件适合首次大范围初始化；下载页面实际显示的市场和日期范围才是当前可用范围。
4. 下载后先检查压缩包内的 README、列名和时间单位，再映射到统一成交结构。不同产品线或不同时期的文件结构可能变化。

OKX 下载器生成的文件链接可能带临时参数或随站点版本变化，因此不要把浏览器最终下载 URL 当作长期接口。自动化任务应保存“产品类型、`instId`、日期、文件哈希和导入状态”，下载链接失效时重新从下载器获取。官网没有提供目标归档时，再用 `/api/v5/market/history-trades` 按 `tradeId` 或毫秒时间戳补数。

导入时还要保留归档原始字段。OKX trade history 可能按 taker order 和价格聚合，不能仅凭文件名把它当成 maker fill 级原始逐笔。

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

### 5.1 官方归档获取

Bybit 提供两种官方入口：

- 可视化下载页：<https://www.bybit.com/en/derivative-activity/history-data>，选择产品线、`Trade Data`、交易标的和日期。
- 可遍历公共目录：<https://public.bybit.com/trading/>，适合脚本化下载。

公共目录按“合约代码/每日文件”组织，路径规则为：

```text
https://public.bybit.com/trading/{SYMBOL}/{SYMBOL}{YYYY-MM-DD}.csv.gz
```

例如 BTCUSDT 的目录和单日文件分别是：

```text
https://public.bybit.com/trading/BTCUSDT/
https://public.bybit.com/trading/BTCUSDT/BTCUSDT2024-01-01.csv.gz
```

Windows PowerShell 下载示例：

```powershell
$url = 'https://public.bybit.com/trading/BTCUSDT/BTCUSDT2024-01-01.csv.gz'
Invoke-WebRequest -Uri $url -OutFile 'BTCUSDT2024-01-01.csv.gz'
```

批量下载时按 UTC 日期生成 URL，并先发送 HEAD 请求或捕获 `404`，不要假设每个品种从同一天开始，也不要假设昨天的文件已经发布。目录中同时存在 USDT 永续、反向合约、交割合约等代码；必须使用 Bybit 原生 symbol，不能直接把 CCXT 的 `BTC/USDT:USDT` 填入路径。

`.csv.gz` 解压后是 CSV。列名和数量/方向口径应以文件实际表头为准，并抽样与 V5 recent trades 核对；不要用固定列位置解析。记录下载 URL、文件大小或哈希、归档日期，导入成功后再推进 checkpoint。

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

Gate 官方文档未公布公共成交的统一保留天数或最早日期，因此最大回溯时间不是一个可保证的固定值。对每个 `(market_type, symbol)`，应使用 `from`、`to` 分段向前查询，或按该产品线支持的 ID/分页参数持续回溯，直到返回空页；最后一个非空页中的最早成交时间只能作为“本次实测最早时间”，不能当成 Gate 的长期保留承诺。

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

Coinbase 官方文档同样未公布公共成交的固定保留天数。Exchange API 应从最新页开始，反复把响应头 `CB-AFTER` 作为下一页的 `after`，直到返回空页或不再提供有效游标；最后一页的最早 `time` 是该产品当次可访问的最早成交。Advanced Trade 的 `start`、`end` 只定义查询区间，不代表服务端承诺保留该区间内的全部历史数据。

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

### 9.1 本仓库清洗工具的安全边界

`scripts/reconcile_market_data.py` 当前为 `binance`、`okx`、`bybit`、`gate`、`coinbase` 提供统一的有限时间窗抓取入口，但不会把 `has.fetchTrades` 当成历史完整性证明。

- 返回页明确观察到 `end` 边界或在持续推进游标后得到空页，才可能标记 `source_complete=true`。
- 统一接口返回满页时，同一毫秒可能仍有未返回成交。在原生 ID/cursor 适配器完成真实验证前，工具会以 `native_cursor_required_at_full_page_boundary` 停止并禁止 `--apply`。
- Bybit 公共接口仅表示近期成交；当前适配器不会据此批准任意历史窗口修复。
- 相同 `(exchange, symbol, trade_id)` 的字段发生冲突时只报告，不覆盖原始记录。
- 修复结果进入 QuestDB companion 表，不直接追加到没有唯一约束的原始 `trades`。

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
