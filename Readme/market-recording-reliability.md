# Market recording reliability

## Native deployment only

Do not install Docker on this machine. The supervisor and QuestDB preparation
task use start-questdb.ps1 and an existing native QuestDB installation. The script
accepts InstallDir and DataDir; its default data directory is the workspace
qdbroot. MySQL and Redis (5.0+ for streams, 6.2+ for trimming) must already be
available separately. No service is installed automatically. Legacy
Docker-specific utility scripts are not needed.

start-questdb.ps1 runs QuestDB in console mode in a minimized window, so it needs
neither a Windows service nor Administrator rights. It does nothing when the HTTP
endpoint already answers, and -Restart stops the console instance for the data
directory first. Pass -QuestDBInstallDir and -QuestDBDataDir to start-all.ps1 to
override the native executable and data paths.

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
raw trade lookup, then paginated historical raw trade lookup if required.
Aggregate trades are never substituted. Recovered trades are persisted page by
page and the checkpoint advances after each accepted page, so long gaps neither
hold all trades in memory nor restart from scratch after a failure. Last
persisted IDs are stored in the outbox checkpoints directory and survive
restarts. Initial startup without a checkpoint starts live, not at the beginning
of exchange history.

Spot IDs must be contiguous before recovery is accepted. USD-M futures streams
also publish non-market fills ("X": "NA", zero price and quantity) that REST never
returns: they advance the ID sequence but are not stored, and recovery accepts
IDs missing inside a page that covers them. Binance trade counts in klines match
this filtering.

Spot historical trades are requested unsigned when BINANCE_API_KEY is absent,
because Binance serves them without a key. Futures historical trades require
BINANCE_API_KEY; configure it locally with minimum read-only permissions and never
commit it. Transient errors (network, rate limits, REST lagging the stream) are
retried. Errors retrying cannot fix (missing credentials, unsupported endpoints,
rejected parameters) keep the trades the recent window still covers, append the
missing ID range to .market-outbox/gaps/trade_gaps.jsonl, log an error and resume
live collection, so a gap is recorded rather than silently skipped or blocking
all later data. Full coverage still depends on exchange history retention. This
recovery implementation is Binance-specific; other exchanges retain their
existing live-only behavior.

Checkpoint and outbox renames retry briefly on EPERM, EACCES and EBUSY, which
Windows raises while antivirus or indexing services hold a fresh file.

## Orderbook semantics

Orderbooks remain sampled net changes (one second by default) plus full snapshots
every minute, not raw exchange messages. Baselines advance only after the local
outbox accepts the event. Replay must replace state on snapshot and delete levels
whose quantity is zero. Exchange downtime cannot be reconstructed from live depth
alone. HTTP/database integration must be verified with the native services before
claiming production completeness.