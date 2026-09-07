import { Injectable } from '@nestjs/common';

/**
 * Minimal in-memory Prometheus metrics registry (text exposition format).
 *
 * Deliberately dependency-free: the API has no metrics library today, and a
 * handful of counters/gauges is all the shipped Prometheus config scrapes
 * (`infrastructure/monitoring/prometheus.yml`). Values reset on process
 * restart — this is observability for a single-instance deployment, not a
 * durable accounting record.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  /** Increment a counter, e.g. inc('payments_failed_total') or inc('http_requests_total', { method: 'GET', status: '500' }). */
  inc(name: string, labels?: Record<string, string | number>, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** Set a gauge to an absolute value, e.g. indexer_last_run_seconds. */
  set(name: string, value: number, labels?: Record<string, string | number>): void {
    this.gauges.set(this.key(name, labels), value);
  }

  /** Reset all values (used by tests and on-demand clearing). */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }

  /** Render the registry in Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    const series = (map: Map<string, number>, type: string) => {
      const keys = [...map.keys()].sort();
      for (const key of keys) {
        const name = key.split('{')[0];
        lines.push(`# TYPE ${name} ${type}`);
        lines.push(`# HELP ${name} See prometheus.yml scrape config.`);
        lines.push(`${key} ${map.get(key)}`);
      }
    };
    series(this.counters, 'counter');
    series(this.gauges, 'gauge');
    return `${lines.join('\n')}\n`;
  }

  private key(name: string, labels?: Record<string, string | number>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return name;
    }
    const parts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
    return `${name}{${parts.join(',')}}`;
  }
}

function escapeLabel(value: string | number): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
