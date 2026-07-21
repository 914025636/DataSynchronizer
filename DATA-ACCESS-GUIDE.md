# DataSynchronizer 数据读取指南（面向工程 AI）

本文是本仓库的数据地图。需要分析、导出或回测行情数据时，优先读取 QuestDB，不要扫描或直接解析 QuestDB 的磁盘文件。

## 1. 快速决策

| 需求 | 数据源 | 读取入口 |
| --- | --- | --- |
| 历史逐笔成交 | QuestDB `trades` | HTTP `localhost:9000` 或 PostgreSQL 协议 `localhost:8812` |
| 历史订单簿变化/重建 | QuestDB `orderbook_delta` | HTTP `localhost:9000` 或 PostgreSQL 协议 `localhost:8812` |
| 旧版逐交易对成交、K 线、订单簿快照 | MySQL | 使用 `.env` 中的 `MYSQL_*` / `MYSQL_*_EXCHANGE` 配置 |
| 当前订单簿短期快照和实时通知 | Redis | 使用 `.env` 中的 `REDIS_*` 配置；它不是长期历史库 |
| 可视化查看 | Grafana | `http://localhost:3000` |
| 手工 SQL | QuestDB Web Console | `http://localhost:9000` |

默认原则：

1. 新的高频历史行情读取任务使用 QuestDB。
2. 通过 SQL、HTTP API 或 PostgreSQL wire protocol 读取，不要直接读取 `db` 目录中的内部文件。
3. 查询必须先限制时间范围、交易所和交易对，尤其是 `orderbook_delta`。
4. 时间范围不明确时，先执行元数据/范围查询，不要直接全表导出。

## 2. QuestDB 连接与物理位置

应用写入配置来自 `.env`：

```env
QUESTDB_HOST=localhost
QUESTDB_PORT=9000
```

端口用途：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| `9000` | HTTP | Web Console、REST 查询、ILP over HTTP 写入 |
| `8812` | PostgreSQL wire | SQL 客户端、Grafana、`psql`、Python/Node PostgreSQL 驱动 |
| `9009` | ILP TCP | InfluxDB Line Protocol 写入，不是首选读取接口 |

Grafana 已配置为通过 PostgreSQL 协议访问 `host.docker.internal:8812`，数据库为 `qdb`，默认本地开发账号见 `grafana/provisioning/datasources/questdb.yml`。

### 当前 Windows 实例

截至 2026-07-19，本机正在运行的 QuestDB 数据根目录为：

```text
D:\Program Files\questdb-9.4.3-rt-windows-x86-64\bin\qdbroot
```

当时总占用约 `5.15 GB`，主要目录为 `orderbook_delta~14`。目录名中的 `~数字` 是 QuestDB 内部表目录版本，不等于 SQL 表名；SQL 中仍使用 `orderbook_delta`。

物理路径取决于启动方式，不能仅凭仓库中的目录判断当前活动实例：

| 启动方式 | 数据位置 |
| --- | --- |
| `start-questdb.bat` / `questdb.exe start` | QuestDB 安装目录下的默认 `qdbroot`（当前活动实例属于此情况） |
| `start-questdb.ps1` | 默认显式指定为 `D:\QuestDBData`，可通过 `-DataDir` 修改 |
| `docker compose up -d questdb` | Docker 命名卷 `questdb_data`，容器内为 `/var/lib/questdb` |
| 仓库根目录 `qdbroot/` | 仅是一份本地目录；当前 Compose 和启动脚本均未把它声明为活动数据目录 |

判断实际数据位置时，应查看当前进程的启动参数或启动脚本。即使知道物理目录，也只通过数据库接口读取。

## 3. QuestDB 表结构

QuestDB 表由 ILP 首次写入时自动创建。以下类型来自当前写入实现 `src/questdb/index.ts`。

### `trades`：逐笔成交

每一行是一笔标准化后的公开市场成交。

| 字段 | QuestDB 类型 | 含义 |
| --- | --- | --- |
| `ts` | `TIMESTAMP` | 交易所成交时间；写入端输入 Unix 毫秒，QuestDB 查询结果按时间戳表示 |
| `exchange` | `SYMBOL` | 小写交易所 ID，如 `binance`、`kucoin` |
| `symbol` | `SYMBOL` | CCXT 统一交易对，如 `BTC/USDT` |
| `side` | `SYMBOL` | `buy` 或 `sell` |
| `price` | `DOUBLE` | 成交价格 |
| `quantity` | `DOUBLE` | 基础资产成交数量 |
| `trade_id` | `STRING` | 交易所成交 ID；不要假定它可转换为数值 |

注意：QuestDB 写入路径没有显式去重。读取方需要去重时，可按业务语义使用 `(exchange, symbol, trade_id)`；不要只按 `ts` 去重，同一毫秒可能有多笔成交。

### `orderbook_delta`：订单簿档位事件

每一行表示某次订单簿消息中的一个价格档位。一次 WebSocket 消息通常产生多行，且这些行可共享同一个 `ts` 和 `sequence`。

| 字段 | QuestDB 类型 | 含义 |
| --- | --- | --- |
| `ts` | `TIMESTAMP` | 消息时间；写入端输入 Unix 毫秒 |
| `exchange` | `SYMBOL` | 小写交易所 ID |
| `symbol` | `SYMBOL` | CCXT 统一交易对，如 `BTC/USDT` |
| `side` | `SYMBOL` | `ask`（卖盘）或 `bid`（买盘） |
| `update_type` | `SYMBOL` | `snapshot` 或 `delta` |
| `price` | `DOUBLE` | 价格档位 |
| `qty` | `DOUBLE` | 该档位更新后的数量；`0` 表示删除该档位 |
| `sequence` | `DOUBLE` | 交易所/CCXT 序列号；不可用时为 `0` |

读取语义：

- `snapshot` 是服务启动或重新订阅后的完整订单簿，每个价格档位一行。
- `delta` 是后续变化，`qty > 0` 表示设置/替换该价格档位数量，`qty = 0` 表示删除。
- `sequence` 被存为 `DOUBLE`，超大整数可能失去精度；值为 `0` 时不能依赖它排序。
- 同一毫秒内可能有多次更新。仅按 `ts` 排序未必能恢复严格事件顺序；有可靠非零序列号时同时按 `sequence` 排序。
- 重建历史订单簿时，从目标时刻之前最近的一组 `snapshot` 开始，按时间和可用序列依次应用 `delta`。不要把所有历史行直接视为当前挂单。

## 4. 最小查询流程

### 4.1 先发现数据

```sql
-- 查看用户表
SELECT * FROM tables();

-- 查看实际字段和类型，自动建表环境中以此结果为准
SELECT * FROM table_columns('trades');
SELECT * FROM table_columns('orderbook_delta');

-- 查看覆盖时间和行数
SELECT min(ts) AS min_ts, max(ts) AS max_ts, count() AS rows FROM trades;
SELECT min(ts) AS min_ts, max(ts) AS max_ts, count() AS rows FROM orderbook_delta;

-- 查看有哪些交易所和交易对
SELECT exchange, symbol, count() AS rows
FROM trades
GROUP BY exchange, symbol
ORDER BY rows DESC;
```

### 4.2 读取逐笔成交

```sql
SELECT ts, exchange, symbol, side, price, quantity, trade_id
FROM trades
WHERE exchange = 'binance'
  AND symbol = 'BTC/USDT'
  AND ts IN '2026-07-19T00:00:00Z;2026-07-19T01:00:00Z'
ORDER BY ts
LIMIT 10000;
```

生成 1 分钟 K 线：

```sql
SELECT
  ts,
  first(price) AS open,
  max(price) AS high,
  min(price) AS low,
  last(price) AS close,
  sum(quantity) AS volume
FROM trades
WHERE exchange = 'binance'
  AND symbol = 'BTC/USDT'
  AND ts IN '2026-07-19T00:00:00Z;2026-07-19T01:00:00Z'
SAMPLE BY 1m ALIGN TO CALENDAR;
```

### 4.3 读取订单簿事件

```sql
SELECT ts, exchange, symbol, side, update_type, price, qty, sequence
FROM orderbook_delta
WHERE exchange = 'binance'
  AND symbol = 'BTC/USDT'
  AND ts IN '2026-07-19T00:00:00Z;2026-07-19T00:05:00Z'
ORDER BY ts, sequence
LIMIT 100000;
```

查看每个档位最后记录（适合检查最新状态，不替代严格的历史重放）：

```sql
SELECT *
FROM (
  SELECT *
  FROM orderbook_delta
  WHERE exchange = 'binance' AND symbol = 'BTC/USDT'
  LATEST ON ts PARTITION BY exchange, symbol, side, price
)
WHERE qty > 0;
```

### 4.4 通过 HTTP 直接读取

PowerShell 中获取 JSON：

```powershell
curl.exe --get --data-urlencode "query=SELECT * FROM trades ORDER BY ts DESC LIMIT 10" http://localhost:9000/exec
```

导出 CSV：

```powershell
curl.exe --get --data-urlencode "query=SELECT * FROM trades WHERE exchange = 'binance' AND symbol = 'BTC/USDT' AND ts IN '2026-07-19T00:00:00Z;2026-07-19T01:00:00Z' ORDER BY ts" http://localhost:9000/exp --output trades.csv
```

程序化读取大量数据时优先使用 PostgreSQL 协议并采用流式/分批读取；HTTP `/exec` 更适合元数据和小结果集，`/exp` 适合受限范围的 CSV 导出。

## 5. MySQL 兼容数据

本项目仍会把部分数据同步写入 MySQL。连接信息以 `.env` 为准：

- `MYSQL_*`：基础数据库，保存市场、交易对、ticker、策略等通用数据。
- `MYSQL_*_EXCHANGE`：交易所历史数据库，保存按交易所和交易对拆分的动态表。

不要把 `.env` 中的密码写入报告、脚本或提示词。`SQL/install.sql` 中的历史默认库名与 `.env.example` 可能不同，运行时以 `.env` 为准。

动态表命名会移除交易对中的 `/`、`-`、`_` 并转为小写：

```text
{exchange}_{cleanSymbol}_trades
{exchange}_{cleanSymbol}_orderbook
{exchange}_{cleanSymbol}_{interval}
```

例如 `binance` + `BTC/USDT`：

```text
binance_btcusdt_trades
binance_btcusdt_orderbook
binance_btcusdt_1m
```

MySQL 动态表格式：

| 表类别 | 主要字段 | 时间格式 |
| --- | --- | --- |
| `*_trades` | `time`, `side`, `quantity`, `price`, `tradeId` | `time` 为 Unix 毫秒 `BIGINT` |
| `*_orderbook` | `time`, `orderbook` | `time` 为 Unix 毫秒；`orderbook` 是 JSON 文本，包含 `asks`/`bids` 二维数组 |
| `*_{interval}` | `time`, `open`, `high`, `low`, `close`, `volume` | `time` 为 Unix 毫秒 |

基础库主要静态表及定义见 `SQL/install.sql`，包括 `market_datas`、`price_tickers`、`tradepairs`、策略和情绪数据。读取前使用 `SHOW TABLES` 与 `DESCRIBE table_name` 核对实际部署结构。

## 6. Redis 数据

Redis 用于运行时状态和发布订阅，不适合历史分析：

- 订单簿快照 key 使用与 MySQL 相同的 `{exchange}_{cleanSymbol}_orderbook` 命名。
- 快照值是 JSON，主体包含 `asks` 和 `bids`，每个档位通常为 `[price, quantity]`。
- 快照 TTL 为 `600` 秒。
- `OrderBookUpdate` Pub/Sub 消息格式为：

```json
{
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "ask": 118000.1,
  "bid": 118000.0
}
```

这里的 Pub/Sub `symbol` 来自交易所原始标识，可能是 `BTCUSDT`；QuestDB 中的 `symbol` 已转换为 CCXT 统一格式 `BTC/USDT`。跨源关联时必须先标准化交易对。

## 7. 给工程 AI 的执行检查表

1. 检查 `localhost:9000` 是否可用，并用 `tables()` 发现实际表。
2. 用 `table_columns()` 验证字段，不假定自动创建的表与文档永远完全一致。
3. 用 `min(ts)`、`max(ts)`、`count()` 和 `GROUP BY exchange, symbol` 确认数据范围。
4. 明确使用 UTC 时间，并在 SQL 中提供开始和结束时间。
5. 对 `orderbook_delta` 同时限制交易所、交易对和较短时间窗口。
6. 订单簿分析明确区分“最后档位状态”和“从快照开始严格重放”。
7. 导出前先执行同条件的 `count()`，避免意外读取数十亿行。
8. 不直接读取、复制、重命名或修改 QuestDB 活动 `qdbroot/db` 内的文件。

## 8. 数据链路与代码依据

```mermaid
flowchart LR
  A[交易所 WebSocket] --> B[Emitter]
  B --> C[QuestDB trades / orderbook_delta]
  B --> D[MySQL 动态历史表]
  B --> E[Redis 订单簿快照 / PubSub]
  C --> F[HTTP 9000]
  C --> G[PostgreSQL 8812]
  G --> H[Grafana]
```

关键实现位置：

- QuestDB 字段与写入：`src/questdb/index.ts`
- 成交双写逻辑：`src/emitter/events/trades_emitter.ts`
- 订单簿增量、快照与 Redis：`src/emitter/events/orderbook_emitter.ts`
- MySQL 动态表结构：`src/database/queries/enums.ts`
- MySQL 动态表命名：`src/utils/index.ts`
- 基础 MySQL 表定义：`SQL/install.sql`
- QuestDB/Grafana 容器配置：`docker-compose.yml`
- Grafana QuestDB 数据源：`grafana/provisioning/datasources/questdb.yml`
