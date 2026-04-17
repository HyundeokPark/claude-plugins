# Large Task Fixture

- **Project**: nestads-statistics-stream
- **Created**: 2026-04-10
- **Updated**: 2026-04-14

## Goal

Migrate the Kafka Streams statistics aggregation pipeline to use a hybrid windowing strategy.
Replace the current tumbling 1-hour window with a combination of 15-minute hopping windows and session windows.
Ensure zero data loss during the migration window.
Add backpressure handling to prevent consumer lag from growing unbounded.
Implement dead-letter topic routing for malformed records.

## Background

The current 1-hour tumbling window produces statistics with up to 59 minutes of latency.
Advertisers need near-real-time impression and click counts for pacing decisions.
Session windows will group user interaction bursts more accurately for attribution.
Hopping windows allow overlapping aggregations at 5-minute granularity.

## Architecture

The pipeline consumes from `nestads-events-raw` topic (20 partitions, RF=3).
Aggregated output goes to `nestads-statistics-aggregated` (10 partitions).
State stores use RocksDB with changelog topics for fault tolerance.
Deployment is on Kubernetes with 3 replicas, each handling ~6-7 partitions.

## Migration Strategy

Phase 1: Deploy new topology alongside existing one, both consuming same input topic.
Phase 2: Route 10% of traffic to new topology, compare output statistics.
Phase 3: Shadow mode validation for 48 hours with automated diff checks.
Phase 4: Gradual traffic shift 10%→50%→100% with 24h hold at each step.
Phase 5: Decommission old topology after 72h at 100% traffic.

## Acceptance Criteria

- End-to-end latency P99 under 5 minutes for 15-min window statistics.
- Zero gap in statistics during migration (no missed windows).
- Consumer lag stays under 10,000 messages per partition.
- Dead-letter routing captures 100% of schema validation failures.
- Stateful failover completes within 30 seconds of pod restart.
- Backpressure mechanism triggers at 80% heap utilization.
- All existing Kafka Streams unit tests pass without modification.
- Integration tests cover windowing edge cases (late arrivals, rebalances).

## Technical Constraints

Kafka Streams version 3.6.x (no upgrade in scope).
JVM heap is set to 4GB per replica (cannot increase without infra ticket).
RocksDB block cache shared across state stores (current: 512MB).
No schema evolution — Avro schemas are frozen for this migration.
Throughput SLA: 50,000 events/second aggregate across all partitions.
