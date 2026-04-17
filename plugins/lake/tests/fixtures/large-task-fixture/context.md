# Context: Large Task Fixture

- **Branch**: feature/statistics-stream-hybrid-window-WP-4200
- **Files**: nestads-statistics-stream/src/main/kotlin/com/nestads/stream/

## Decisions

- Hopping window size: 15 minutes, advance: 5 minutes (3 overlapping windows at any point).
- Session gap: 30 minutes (aligns with ad server timeout for user sessions).
- Dead-letter topic: nestads-statistics-dlq (3 partitions, 7-day retention).
- Backpressure threshold: 80% heap triggers pause on consumer group assignment.
- RocksDB block cache: keep at 512MB shared; increase deferred to infra ticket.
- Shadow mode validation: 48-hour minimum before any production traffic shift.
- Traffic shift increments: 10% → 50% → 100% with 24-hour hold at each step.
- Changelog topic cleanup deferred to post-migration (72h after 100% traffic).

## Architecture Notes

- Input topic: nestads-events-raw (20 partitions, RF=3, ~50K events/sec peak).
- Output topic: nestads-statistics-aggregated (10 partitions, RF=3).
- State store: RocksDB, changelog topics suffixed -changelog.
- Each replica handles ~6-7 partitions (3 replicas, 20 partitions).
- Heap: 4GB per replica, G1GC with MaxGCPauseMillis=200.
- Kafka Streams version: 3.6.1 (pinned, no upgrade in scope).

## Monitoring

- Grafana dashboard: NestAds Statistics Stream (ID: dash-0042).
- Key metrics: consumer-lag (alarm > 10K), end-to-end-latency-p99 (alarm > 5min), dlq-rate (alarm > 0.1%).
- Runbook: https://wiki.nestads.internal/runbooks/statistics-stream.

## Blockers

- Phase 4 50% traffic shift requires SRE team approval — waiting for sign-off from @sre-lead (requested 2026-04-14).
- Downstream consumer nestads-reporting-service has not updated its statistics schema — blocked until WP-4199 is merged.
- Grafana dashboard for new hopping window metrics needs infra team to provision new metric namespaces — ticket INF-0892 raised.
- JVM heap cannot be increased without infra ticket — RocksDB tuning options limited to block cache within current 512MB.
- Integration test environment is flaky: nestads-events-raw topic sometimes has stale offsets from previous test runs causing false failures.
- Kafka broker upgrade from 3.5 to 3.6 in production environment is pending — statistics-stream 3.6 client may behave differently with 3.5 broker (backward compat tested in staging only).
- Dead-letter topic retention policy needs data governance approval — ticket DG-0041 submitted 2026-04-12 (no response yet).
- Automated diff checker script has a bug when comparing session window results across partition boundaries — under investigation.
- SLA documentation update requires legal review for external-facing statistics guarantees — deferred to post-launch.
- RocksDB block cache sharing between state stores is undocumented in Kafka Streams 3.6 — behaviour verified empirically but no official guarantee.
