import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Prisma, PrismaService } from '@stellar-pay/database';

const REDACTED = '[REDACTED]';

/**
 * Request-body keys whose values must never reach the audit table. Anything
 * matching is replaced before the row is written — the audit trail is a
 * permanent, admin-readable record and must not become a credential store.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'refreshtoken',
  'accesstoken',
  'token',
  'secret',
  'webhooksecret',
  'signingsecret',
  'apikey',
  'privatekey',
  'secretkey',
  'seed',
  'mnemonic',
  'signature',
  'authorization',
]);

const MAX_REDACT_DEPTH = 6;

/**
 * Deep-copy a request body with sensitive values replaced by `[REDACTED]`.
 *
 * Without this, `POST /auth/admin/login` persisted the plaintext admin
 * password and `POST /auth/refresh` persisted a live refresh token (a bearer
 * credential) into `AuditLog.metadata`, which the admin dashboard displays.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactSensitive(entry, depth + 1);
  }
  return out;
}

/**
 * Writes an AuditLog row for every mutating request (POST/PUT/PATCH/DELETE).
 * Failures are logged but do not block the response.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditInterceptor');

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method: string;
      route?: { path?: string };
      path?: string;
      user?: { userId?: string; publicKey?: string };
      ip?: string;
      headers?: Record<string, string | undefined>;
      body?: Record<string, unknown>;
    }>();
    const method = request.method ?? 'GET';
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (!isMutation) {
      return next.handle();
    }

    // Journal both completions and failures: a mutation that threw (e.g. a
    // rejected payment) is exactly what an audit trail should capture. The
    // write is fire-and-forget — it never blocks or alters the response.
    return next.handle().pipe(
      tap({
        next: () => this.writeAudit(request, method),
        error: () => this.writeAudit(request, method),
      }),
    );
  }

  private writeAudit(
    request: {
      route?: { path?: string };
      path?: string;
      user?: { userId?: string; publicKey?: string };
      ip?: string;
      headers?: Record<string, string | undefined>;
      body?: Record<string, unknown>;
    },
    method: string,
  ): void {
    const path = request.route?.path ?? request.path ?? 'unknown';
    this.prisma.auditLog
      .create({
        data: {
          userId: request.user?.userId,
          actorPublicKey: request.user?.publicKey,
          action: `${method} ${path}`,
          resource: path.split('/')[1] ?? 'api',
          resourceId: undefined,
          ipAddress: request.ip,
          userAgent: request.headers?.['user-agent'],
          metadata: { body: redactSensitive(request.body) } as Prisma.InputJsonValue,
        },
      })
      .catch((err: Error) => {
        this.logger.error(`Failed to write audit log: ${err.message}`, err.stack);
      });
  }
}
