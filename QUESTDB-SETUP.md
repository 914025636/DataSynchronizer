# QuestDB 集成指南

## 概述

此项目已集成 **QuestDB** 时序数据库，用于存储：
- **逐笔成交数据**（每个交易所-交易对一张 `*_trades` 表）
- **订单簿增量数据**（每个交易所-交易对一张 `*_orderbook_delta` 表）
- **市场表路由**（统一的 `market_data_catalog` 表）

## 快速开始（5 分钟）

### 1️⃣ 启动 QuestDB

**选项 A：Docker（当前项目推荐）**

```powershell
powershell -ExecutionPolicy Bypass -File .\start-questdb-docker.ps1
```

该脚本会自动启动 Docker Desktop 和 Compose `questdb` 服务，并验证容器挂载、ILP `9009`、宿主机 SQL `18812` 和 Web Console `9000`。容器内 PostgreSQL wire 仍使用标准端口 `8812`。Docker 实际数据位于 `D:\DockerData`；`C:\Users\Bin\AppData\Local\Docker` 只是指向该目录的 junction。

启动完整服务：

```powershell
docker compose up -d
```

Windows ZIP/Scoop 独立实例只作为备选方案。不要同时启动独立 QuestDB 和 Docker QuestDB，否则会争用 `9000`、`9009` 端口并产生两套数据。Docker SQL 对外端口使用 `18812`，以避开本机 Windows 保留的 `8812` 端口范围。

### 2️⃣ 配置环境变量

复制 `.env.example` 为 `.env`：
```bash
cp .env.example .env
```

编辑 `.env` 中的 QuestDB 地址（如果不是本地）：
```env
QUESTDB_HOST=localhost
QUESTDB_PROTOCOL=tcp
QUESTDB_PORT=9009
```

如果交易所网络需要本地代理，可配置 CCXT 的 HTTP/WSS 代理：

```env
CCXT_HTTPS_PROXY=http://127.0.0.1:10808
CCXT_WSS_PROXY=http://127.0.0.1:10808
```

Windows 本地安装可使用项目脚本启动 QuestDB，无需安装 Windows 服务：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-questdb.ps1
```

### 3️⃣ 编译并运行

```bash
npm run build
npm start
```

### 4️⃣ 验证数据

打开浏览器访问 QuestDB Web 控制台：
```
http://localhost:9000
```

在 Console 中运行以下 SQL 查看实时数据：

**查看最新成交**
```sql
SELECT * FROM "binance_btc_usdt_spot_trades"
ORDER BY timestamp DESC
LIMIT 100;
```

**查看最新订单簿（每个价格档位最后状态）**
```sql
SELECT *
FROM (
    SELECT * FROM "binance_btc_usdt_spot_orderbook_delta"
    LATEST ON timestamp PARTITION BY exchange, symbol, side, price
)
WHERE qty > 0
LIMIT 20;
```

**查看原始订单簿增量记录**
```sql
SELECT * FROM "binance_btc_usdt_spot_orderbook_delta"
WHERE update_type = 'delta'
ORDER BY timestamp DESC
LIMIT 100;
```

**成交聚合成 K 线（1 分钟）**
```sql
SELECT timestamp, first(price) open, max(price) high,
       min(price) low, last(price) close, sum(quantity) volume
FROM "binance_btc_usdt_spot_trades"
SAMPLE BY 1m;
```

**发现市场对应表**
```sql
SELECT exchange, symbol, trades_table, orderbook_delta_table
FROM market_data_catalog
LATEST ON timestamp PARTITION BY exchange, symbol;
```

## 数据表结构

### `{market}_trades` 表
```sql
CREATE TABLE binance_btc_usdt_spot_trades (
    timestamp TIMESTAMP,       -- 成交时间戳
    exchange SYMBOL,           -- 交易所 (e.g. 'binance')
    symbol SYMBOL,            -- 交易对 (e.g. 'BTC/USDT')
    side SYMBOL,              -- 买卖方向 ('buy' | 'sell')
    price DOUBLE,             -- 成交价格
    quantity DOUBLE,          -- 成交数量
    trade_id STRING           -- 交易ID
) TIMESTAMP(timestamp) PARTITION BY DAY;
```

### `{market}_orderbook_delta` 表
```sql
CREATE TABLE binance_btc_usdt_spot_orderbook_delta (
    timestamp TIMESTAMP,      -- 时间戳
    exchange SYMBOL,          -- 交易所
    symbol SYMBOL,            -- 交易对
    side SYMBOL,              -- 买卖方向 ('ask' | 'bid')
    update_type SYMBOL,       -- 首帧 'snapshot'，后续为 'delta'
    price DOUBLE,             -- 价格档位
    qty DOUBLE,               -- 数量（0 表示删除该档位）
    sequence DOUBLE           -- 交易所/CCXT 订单簿序列号（无则为 0）
) TIMESTAMP(timestamp) PARTITION BY DAY;
```

每次 WebSocket 更新中，每个变化的价格档位写入一行。数量变化和新增档位写入最新数量，删除档位写入 `qty = 0`。服务启动或重新订阅后的首帧完整订单簿使用 `update_type = 'snapshot'`，后续变化使用 `update_type = 'delta'`。

表名显式包含市场类型：现货使用 `_spot`，CCXT `BASE/QUOTE:SETTLE` 格式的永续/掉期使用 `_swap`。例如 `binance_btc_usdt_spot_trades` 和 `gate_btc_usdt_swap_orderbook_delta`。表名不使用哈希，只包含小写字母、数字和下划线，最长 127 字符。

`market_data_catalog` 保存 `exchange`、`symbol`、`trades_table` 和 `orderbook_delta_table`。查询工具应先读取 catalog，再使用其中经过校验的表名。Grafana 一次选择一个市场，不执行跨动态表的隐式聚合。

旧的统一 `trades` 和 `orderbook_delta` 表不迁移、不回填、不双写，并保留只读。新版本启动后只向市场分表写入，不应删除旧表。

## 码源代码位置

- **QuestDB 写入模块**: [src/questdb/index.ts](src/questdb/index.ts)
- **成交数据集成**: [src/emitter/events/trades_emitter.ts](src/emitter/events/trades_emitter.ts)
- **订单簿数据集成**: [src/emitter/events/orderbook_emitter.ts](src/emitter/events/orderbook_emitter.ts)

## 常见问题

### Q: 如何使用远程 QuestDB？
A: 编辑 `.env` 中的 `QUESTDB_HOST` 和 `QUESTDB_PORT`

### Q: 如何导出数据用于回测？
A: 在 QuestDB Console 中运行 SQL，导出为 CSV 或使用 HTTP API

### Q: 数据延迟有多长？
A: 使用 ILP over TCP，写入缓冲周期为 500ms，几乎实时

### Q: 能否同时保存到 MySQL？
A: 可以，现有代码同时支持 MySQL 和 QuestDB 写入

## 参考资源

- QuestDB 官网: https://questdb.io
- QuestDB SQL 文档: https://questdb.io/docs/reference/sql/
- ILP 协议: https://questdb.io/docs/reference/api/ilp/
- 时序查询示例: https://questdb.io/docs/concept/designated-timestamp/
