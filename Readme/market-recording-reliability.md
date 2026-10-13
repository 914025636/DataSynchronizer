# Market recording reliability

## Native deployment only

Do not install Docker on this machine. The supervisor and QuestDB preparation
task use start-questdb.ps1 and an existing native QuestDB installation. The script
accepts InstallDir and DataDir; its default data directory is the workspace
qdbroot. MySQL and Redis must already be available separately. No service is
installed automatically. Legacy Docker-specific utility scripts are not needed.

Pass -QuestDBInstallDir and -QuestDBDataDir to start-all.ps1 to override the
native executable and data paths. The default installation path was not present
on the machine during implementation; no database installation was performed.

Use QuestDB with WAL and deduplication support (the native script targets 9.4.3).
Set QUESTDB_PROTOCOL=http and QUESTDB_PORT=9000. The writer requires HTTP write
acknowledgement and access to /exec for schema preparation. TCP ingestion is
rejected. Existing non-WAL tables require an operator-managed migration before
ingestion; schema errors leave Redis messages pending. This implementation
expects the local HTTP endpoint without authentication.

## Delivery and replay

Producer messages are group-committed to .market-outbox: messages arriving within
MARKET_OUTBOX_BATCH_MS (default 20) or up to MARKET_OUTBOX_BATCH_SIZE (default
1000) share one fsynced batch file, and a message is acknowledged only after its
batch is durable. Binance checkpoints advance once per accepted trade batch.
Redis delivery pipelines each batch file and retries from this directory,
including after process restart. Incomplete .tmp files are renamed to .corrupt. Keep this directory on persistent local storage,
do not delete it while messages are pending, and run only one producer against it.
A disk write failure prevents advancing the affected checkpoint.

Redis stream insertion no longer uses MAXLEN, because trimming may delete
unconsumed messages. Instead, each stream worker periodically runs
XTRIM MINID ~ below the oldest unacknowledged entry of every consumer group
(requires Redis 6.2+; older servers log a warning and are not trimmed). Monitor
Redis memory, disk and the outbox. Enable Redis persistence appropriate to the
required durability (for example AOF). The existing MAX_LENGTH option still
bounds dead-letter streams.

QuestDB flushes every write batch before resolving its tasks. The consumer ACKs
only after the complete batch succeeds. WAL deduplication uses existing columns:
trades on (ts, exchange, symbol, trade_id) and orderbook rows on
(ts, exchange, symbol, update_type, side, price). Startup replaces the legacy
(ts, record_key) keys on existing tables; the record_key column is no longer
written and may be dropped manually. Existing duplicates are not cleaned.

## Binance raw trade recovery

The three configured Binance markets retain raw trade IDs. A gap triggers recent
raw trade lookup, then paginated historical raw trade lookup if required. Every
returned ID must be contiguous before recovery is accepted. Aggregate trades are
never substituted. Last persisted IDs are stored in the outbox checkpoints
directory and survive restarts. Initial startup without a checkpoint starts live,
not at the beginning of exchange history.

Historical raw-trade endpoints require BINANCE_API_KEY. Configure it locally with
minimum read-only permissions; never commit it. Missing credentials, unavailable
history or invalid IDs leave recovery blocked and logged, rather than silently
skipping a gap. Full coverage still depends on exchange history retention. This
recovery implementation is Binance-specific; other exchanges retain their
existing live-only behavior.

## Orderbook semantics

Orderbooks remain sampled net changes (one second by default) plus full snapshots
every minute, not raw exchange messages. Baselines advance only after the local
outbox accepts the event. Replay must replace state on snapshot and delete levels
whose quantity is zero. Exchange downtime cannot be reconstructed from live depth
alone. HTTP/database integration must be verified with the native services before
claiming production completeness.