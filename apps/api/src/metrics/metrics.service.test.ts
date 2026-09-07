import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('increments counters and renders Prometheus text format', () => {
    metrics.inc('payments_succeeded_total', { kind: 'payment' });
    metrics.inc('payments_succeeded_total', { kind: 'payment' });
    metrics.inc('payments_failed_total');

    const out = metrics.render();
    expect(out).toContain('# TYPE payments_succeeded_total counter');
    expect(out).toContain('payments_succeeded_total{kind="payment"} 2');
    expect(out).toContain('payments_failed_total 1');
  });

  it('sets gauges', () => {
    metrics.set('indexer_last_poll_seconds', 1_700_000_000);
    const out = metrics.render();
    expect(out).toContain('# TYPE indexer_last_poll_seconds gauge');
    expect(out).toContain('indexer_last_poll_seconds 1700000000');
  });

  it('sorts series deterministically', () => {
    metrics.inc('b_counter');
    metrics.inc('a_counter');
    const out = metrics.render();
    const a = out.indexOf('a_counter 1');
    const b = out.indexOf('b_counter 1');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  it('escapes label values', () => {
    metrics.inc('http_requests_total', { method: 'GET', status: '500' });
    const out = metrics.render();
    expect(out).toContain('http_requests_total{method="GET",status="500"} 1');
  });

  it('resets all values', () => {
    metrics.inc('a');
    metrics.set('g', 1);
    metrics.reset();
    expect(metrics.render()).toBe('\n');
  });
});
