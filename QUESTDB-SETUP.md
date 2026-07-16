# QuestDB 集成指南

## 概述

此项目已集成 **QuestDB** 时序数据库，用于存储：
- **逐笔成交数据** (`trades` 表)
- **订单簿增量数据** (`orderbook_delta` 表)

## 快速开始（5 分钟）

### 1️⃣ 启动 QuestDB

**选项 A：最简单（推荐）**

访问 [questdb.io/download](https://questdb.io/download/) 下载 Windows ZIP，解压后在 `bin` 文件夹中运行：
```bash
questdb.exe start
```

**选项 B：使用 Scoop**
```powershell
scoop install questdb
questdb start
```

**选项 C：使用 Docker**
```bash
docker compose up -d
```

### 2️⃣ 配置环境变量

复制 `.env.example` 为 `.env`：
```bash
cp .env.example .env
```

编辑 `.env` 中的 QuestDB 地址（如果不是本地）：
```env
QUESTDB_HOST=localhost
QUESTDB_PORT=9000
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
SELECT * FROM trades 
ORDER BY ts DESC 
LIMIT 100;
```

**查看最新订单簿（每个价格档位最后状态）**
```sql
SELECT *
FROM (
    SELECT * FROM orderbook_delta
    LATEST ON ts PARTITION BY (exchange, symbol, side, price)
)
WHERE qty > 0
LIMIT 20;
```

**查看原始订单簿增量记录**
```sql
SELECT * FROM orderbook_delta
WHERE update_type = 'delta'
ORDER BY ts DESC
LIMIT 100;
```

**成交聚合成 K 线（1 分钟）**
```sql
SELECT timestamp, first(price) open, max(price) high,
       min(price) low, last(price) close, sum(quantity) volume
FROM trades
WHERE exchange = 'binance' AND symbol = 'BTC/USDT'
SAMPLE BY 1m;
```

**订单簿价差分析**
```sql
SELECT 
    ts, 
    exchange, 
    symbol,
    (SELECT price FROM orderbook_delta WHERE side='ask' AND ts=orderbook_delta.ts LATEST ON ts) - 
    (SELECT price FROM orderbook_delta WHERE side='bid' AND ts=orderbook_delta.ts LATEST ON ts) AS spread
FROM orderbook_delta
WHERE exchange = 'binance'
LIMIT 10;
```

## 数据表结构

### `trades` 表
```sql
CREATE TABLE trades (
    ts TIMESTAMP,              -- 成交时间戳
    exchange SYMBOL,           -- 交易所 (e.g. 'binance')
    symbol SYMBOL,            -- 交易对 (e.g. 'BTC/USDT')
    side SYMBOL,              -- 买卖方向 ('buy' | 'sell')
    price DOUBLE,             -- 成交价格
    quantity DOUBLE,          -- 成交数量
    trade_id STRING           -- 交易ID
) TIMESTAMP(ts) PARTITION BY DAY;
```

### `orderbook_delta` 表
```sql
CREATE TABLE orderbook_delta (
    ts TIMESTAMP,             -- 时间戳
    exchange SYMBOL,          -- 交易所
    symbol SYMBOL,            -- 交易对
    side SYMBOL,              -- 买卖方向 ('ask' | 'bid')
    update_type SYMBOL,       -- 首帧 'snapshot'，后续为 'delta'
    price DOUBLE,             -- 价格档位
    qty DOUBLE,               -- 数量（0 表示删除该档位）
    sequence DOUBLE           -- 交易所/CCXT 订单簿序列号（无则为 0）
) TIMESTAMP(ts) PARTITION BY DAY;
```

每次 WebSocket 更新中，每个变化的价格档位写入一行。数量变化和新增档位写入最新数量，删除档位写入 `qty = 0`。服务启动或重新订阅后的首帧完整订单簿使用 `update_type = 'snapshot'`，后续变化使用 `update_type = 'delta'`。

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
A: 使用 ILP over HTTP，写入缓冲周期为 500ms，几乎实时

### Q: 能否同时保存到 MySQL？
A: 可以，现有代码同时支持 MySQL 和 QuestDB 写入

## 参考资源

- QuestDB 官网: https://questdb.io
- QuestDB SQL 文档: https://questdb.io/docs/reference/sql/
- ILP 协议: https://questdb.io/docs/reference/api/ilp/
- 时序查询示例: https://questdb.io/docs/concept/designated-timestamp/
