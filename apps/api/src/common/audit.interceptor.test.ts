import { Logger, type ExecutionContext } from '@nestjs/common';
import type { PrismaService } from '@stellar-pay/database';
import { AuditInterceptor } from './audit.interceptor';
import { lastValueFrom, of, throwError } from 'rxjs';

function makeContext(overrides: Record<string, unknown> = {}) {
  const request = {
    method: 'POST',
    route: { path: '/payments' },
    path: '/payments',
    user: { userId: 'user-1', publicKey: 'GPAYER' },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest-test' },
    body: { amount: '10' },
    ...overrides,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('AuditInterceptor', () => {
  let prisma: { auditLog: { create: jest.Mock } };
  let interceptor: AuditInterceptor;
  const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    interceptor = new AuditInterceptor(prisma as unknown as PrismaService);
    loggerSpy.mockClear();
  });

  afterAll(() => {
    loggerSpy.mockRestore();
  });

  it('writes an AuditLog row for mutating requests (POST)', async () => {
    const context = makeContext();
    const next = { handle: () => of({ ok: true }) };

    await lastValueFrom(interceptor.intercept(context, next));

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        actorPublicKey: 'GPAYER',
        action: 'POST /payments',
        resource: 'payments',
        resourceId: undefined,
        ipAddress: '127.0.0.1',
        userAgent: 'jest-test',
        metadata: { body: { amount: '10' } },
      },
    });
  });

  it('covers PUT, PATCH and DELETE', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const context = makeContext({ method });
      await lastValueFrom(interceptor.intercept(context, { handle: () => of({}) }));
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: `${method} /payments` }),
      });
    }
  });

  it('does not journal safe (GET/HEAD/OPTIONS) requests', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const context = makeContext({ method });
      await lastValueFrom(interceptor.intercept(context, { handle: () => of({}) }));
    }
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('propagates the response value to the caller', async () => {
    const context = makeContext();
    const result = await lastValueFrom(
      interceptor.intercept(context, { handle: () => of({ id: 'tx-1' }) }),
    );
    expect(result).toEqual({ id: 'tx-1' });
  });

  it('logs but never throws when the audit write fails', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    const context = makeContext();
    const result = await lastValueFrom(
      interceptor.intercept(context, { handle: () => of({ ok: true }) }),
    );
    // The response is unaffected by the failed audit write.
    expect(result).toEqual({ ok: true });
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write audit log: db down'),
      expect.any(String),
    );
  });

  it('still journals when the downstream handler throws (error tap)', async () => {
    const context = makeContext();
    // A rejected observable flows through tap({ next, error }) — the audit
    // write is attempted, and the error propagates to the caller.
    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('handles requests without a resolved route path', async () => {
    const context = makeContext({ route: undefined, path: undefined });
    await lastValueFrom(interceptor.intercept(context, { handle: () => of({}) }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'POST unknown',
        resource: 'api', // split('/')[1] on 'unknown' is undefined → default
      }),
    });
  });
});
