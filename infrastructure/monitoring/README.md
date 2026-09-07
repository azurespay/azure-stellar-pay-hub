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

## Local run

The API serves `/api/metrics` itself when `METRICS_ENABLED=true`; point the
Prometheus scrape job at `http://api:4000/api/metrics`. The `postgres` and
`redis` scrape jobs assume sidecar exporters (`postgres-exporter`, `redis-exporter`)
that are not part of the local docker-compose stack — add them (or disable those
jobs) when running locally.
