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

Every producer message is written and fsynced to .market-outbox before the
producer advances its checkpoint. Redis delivery retries from this directory,
including after process restart. Keep this directory on persistent local storage,
do not delete it while messages are pending, and run only one producer against it.
A disk write failure prevents advancing the affected checkpoint.

Redis stream insertion no longer uses MAXLEN, because trimming may delete
unconsumed messages. Monitor Redis memory, disk and the outbox. Enable Redis
persistence appropriate to the required durability (for example AOF); deleting a
local message after Redis accepts it relies on Redis retaining acknowledged data.
Schedule retention only below the safe acknowledgement boundary of every group.
The existing MAX_LENGTH option still bounds dead-letter streams.

QuestDB flushes every write batch before resolving its tasks. The consumer ACKs
only after the complete batch succeeds. Tables gain a record_key column and WAL
deduplication on (ts, record_key). Replaying a trade or orderbook price level uses
the same key. Historical rows with no record_key are not backfilled or cleaned;
this is not a historical duplicate-removal migration.

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