# Monitoring

Prometheus + Grafana stack for the platform.

- `prometheus.yml` – scrape config (API metrics endpoint, postgres, redis)
- `alerts.yml` – alerting rules (API downtime, elevated 5xx, DB connections)

## What the API exposes

When `METRICS_ENABLED=true`, the API serves a Prometheus text-format endpoint at
`/api/metrics` (no auth — plaintext, so enable only in environments where that
is acceptable). Metrics include `http_requests_total` (by method/status),
`payments_succeeded_total`, `payments_failed_total`, `inbound_payments_credited_total`,
and `indexer_last_poll_seconds` (a gauge for event-processor freshness). Values
are in-memory and reset on restart — for durable accounting use the database.

- `grafana/` – provisioned datasource; add dashboards in the Grafana UI

## Running locally

```bash
docker run -d --name prometheus -p 9090:9090 \
  -v $(pwd)/infrastructure/monitoring:/etc/prometheus prom/prometheus

docker run -d --name grafana -p 3000:3000 \
  -v $(pwd)/infrastructure/monitoring/grafana/provisioning:/etc/grafana/provisioning grafana/grafana
```

On Linux (Docker Desktop's `host.docker.internal` is not provided), add
`--add-host host.docker.internal:host-gateway` and point the scrape target at
`host.docker.internal:4000` so the container can reach the host's API.

## Failure drill (verified 2026-09-09)

An intentional-failure drill was run against the local stack to prove the
alerting pipeline end to end: detection → firing → recovery.

1. Boot the API with `METRICS_ENABLED=true`, run Prometheus pointed at
   `http://host.docker.internal:4000/api/metrics`, and confirm the target is
   **up** and all three shipped rules (`ApiDown`, `HighPaymentFailureRate`,
   `DatabaseConnectionsExhausted`) are loaded.
2. **Inject the failure**: `kill -9 <api-pid>`. The health endpoint returns
   connection-refused and Prometheus marks the target `down`.
3. **Detection**: after the `for` window, `/api/v1/alerts` reports
   `ApiDown state=firing` with annotation "API is unreachable".
4. **Recovery**: restart the API — `/api/v1/alerts` reports no active
   `ApiDown` alert and the target returns to `up` within two evaluation
   intervals.

For a fast local drill shorten the `for:` durations in a copy of `alerts.yml`
(the shipped 2m/10m/5m windows are what production should use). Prometheus
itself was exercised via the Docker image `prom/prometheus:v2.53.0`; the
`postgres`/`redis` scrape jobs in `prometheus.yml` assume sidecar exporters
that are not part of the local docker-compose stack.

## Local run

The API serves `/api/metrics` itself when `METRICS_ENABLED=true`; point the
Prometheus scrape job at `http://api:4000/api/metrics`. The `postgres` and
`redis` scrape jobs assume sidecar exporters (`postgres-exporter`, `redis-exporter`)
that are not part of the local docker-compose stack — add them (or disable those
jobs) when running locally.
