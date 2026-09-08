import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@stellar-pay/database';
import { verifyAccessToken, type AuthTokenPayload } from '@stellar-pay/authentication';
import { IS_PUBLIC_KEY } from './decorators';

/**
 * Global authentication guard. Verifies the Bearer JWT and validates that the
 * referenced session is still active (server-side session revocation).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    const authorization = request.headers['authorization'] ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const jwtSecret = this.config.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new UnauthorizedException('Server authentication is not configured');
    }

    let payload: AuthTokenPayload;
    try {
      payload = verifyAccessToken(token, jwtSecret);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.sessionId) {
      const session = await this.prisma.session.findUnique({ where: { id: payload.sessionId } });
      if (!session || session.status !== 'ACTIVE' || session.expiresAt < new Date()) {
        throw new UnauthorizedException('Session is no longer active');
      }
      if (session.userId !== payload.sub) {
        throw new UnauthorizedException('Session does not match token subject');
      }
    }

    // The database is the authority for role and status, never the token: a
    // suspended account is rejected on every request (suspension is not
    // cosmetic), and an admin demotion/role change takes effect immediately
    // instead of when the 7-30 day token naturally expires.
    const dbUser = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, role: true },
    });
    if (!dbUser) {
      throw new UnauthorizedException('Account no longer exists');
    }
    if (dbUser.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is suspended or not yet activated');
    }

    const user = {
      userId: payload.sub,
      publicKey: payload.publicKey,
      role: dbUser.role,
      sessionId: payload.sessionId,
    };
    (request as unknown as { user: typeof user }).user = user;
    return true;
  }
}
