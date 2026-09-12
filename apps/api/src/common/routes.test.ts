import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service';

jest.setTimeout(30_000);

// Booting AppModule validates the environment against `@stellar-pay/config`'s
// schema, and CI's tier-1 step intentionally runs without secrets. Supply
// throwaway values (only when unset) so this suite stays hermetic — nothing
// here talks to Postgres, Redis or Stellar.
process.env.JWT_SECRET ??= 'test-secret-at-least-16-chars';
process.env.WEBHOOK_SIGNING_SECRET ??= 'test-webhook-secret-16-chars';
process.env.ADMIN_PASSWORD ??= 'CiTestPass123!';

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: RouterLayer[] };
}

/** Flatten the Express router into `METHOD /path` strings. */
function routeTable(app: INestApplication): string[] {
  const server = app.getHttpAdapter().getInstance() as {
    router?: { stack: RouterLayer[] };
    _router?: { stack: RouterLayer[] };
  };
  const root = server.router ?? server._router;
  const routes: string[] = [];
  const walk = (stack: RouterLayer[] = []): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods ?? {})) {
          routes.push(`${method.toUpperCase()} ${layer.route.path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(root?.stack);
  return routes;
}

/**
 * Guards against shadowed handlers. Nest registers routes in module order and
 * Express dispatches to the first match, so two controllers declaring the same
 * method+path quietly turn one implementation into dead code — the surviving
 * handler is decided by `AppModule`'s import order, not by intent.
 */
describe('route table', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Imported lazily, after the env defaults above: `AppModule` validates the
    // environment as a side effect of being loaded, and a hoisted import would
    // run before this file's setup.
    const { AppModule } = await import('../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Keep the scheduler's background polls (and their Redis/Stellar traffic)
      // out of this suite — only the routing table is under test.
      .overrideProvider(SchedulerService)
      .useValue({
        onModuleInit: () => undefined,
        onModuleDestroy: () => undefined,
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers every route exactly once', () => {
    const routes = routeTable(app);
    expect(routes.length).toBeGreaterThan(50);

    const counts = new Map<string, number>();
    for (const route of routes) {
      counts.set(route, (counts.get(route) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([route, count]) => `${route} (x${count})`);
    expect(duplicates).toEqual([]);
  });

  it('keeps the money paths registered', () => {
    const routes = routeTable(app);
    for (const expected of [
      'POST /payments',
      'POST /payments/:id/submit',
      'POST /checkout/transactions/:id/submit',
      'POST /merchants/me/invoices',
      'POST /merchants/me/payment-links',
    ]) {
      expect(routes).toContain(expected);
    }
  });
});
