import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@stellar-pay/database';
import { RedisService } from '../infra/redis.service';
import {
  buildChallenge,
  parseChallengeMessage,
  signAccessToken,
  signRefreshToken,
  verifyFreighterMessageSignature,
  verifyRefreshToken,
  type TokenPair,
} from '@stellar-pay/authentication';
import { hashSecret } from '@stellar-pay/shared';
import type { VerifyRequest, AdminLogin } from '@stellar-pay/validation';
import { verifyPassword } from '@stellar-pay/authentication';
import type { User, UserRole } from '@stellar-pay/types';

const CHALLENGE_TTL = 300;

export interface AuthResult extends TokenPair {
  user: User;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    return this.config.get<string>('JWT_SECRET')!;
  }

  async createChallenge(publicKey: string) {
    const challenge = buildChallenge(publicKey);
    await this.redis.setJson(`challenge:${publicKey}`, { nonce: challenge.nonce }, CHALLENGE_TTL);
    return challenge;
  }

  async verifyWallet(payload: VerifyRequest): Promise<AuthResult> {
    // 1. Nonce must have been issued and match the signed message.
    const stored = await this.redis.getJson<{ nonce: string }>(`challenge:${payload.publicKey}`);
    if (!stored || stored.nonce !== payload.nonce) {
      throw new UnauthorizedException('Challenge is invalid or expired');
    }
    const parsed = parseChallengeMessage(payload.message, payload.publicKey);
    if (!parsed || parsed.nonce !== payload.nonce) {
      throw new UnauthorizedException('Challenge message mismatch');
    }

    // 2. The signature must be valid Ed25519 over the message bytes.
    const valid = verifyFreighterMessageSignature({
      publicKey: payload.publicKey,
      message: payload.message,
      signature: payload.signature,
    });
    if (!valid) {
      throw new UnauthorizedException('Signature verification failed');
    }
    await this.redis.del(`challenge:${payload.publicKey}`);

    // 3. Find or create the user + linked wallet.
    const existing = await this.prisma.user.findFirst({
      where: { wallets: { some: { publicKey: payload.publicKey } } },
      include: { wallets: true },
    });
    const provider = payload.provider ?? 'FREIGHTER';
    const network = 'testnet';

    let user = existing;
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          status: 'ACTIVE',
          role: 'USER',
          displayName: `Wallet ${payload.publicKey.slice(0, 6)}…${payload.publicKey.slice(-4)}`,
          wallets: {
            create: { publicKey: payload.publicKey, provider, network, isPrimary: true },
          },
          preferences: { create: { currency: 'USD' } },
        },
        include: { wallets: true },
      });
    } else {
      const linked = user.wallets.some((w) => w.publicKey === payload.publicKey);
      if (!linked) {
        await this.prisma.wallet.create({
          data: {
            userId: user.id,
            publicKey: payload.publicKey,
            provider,
            network,
            isPrimary: false,
          },
        });
      }
      await this.prisma.wallet.updateMany({
        where: { publicKey: payload.publicKey },
        data: { lastUsedAt: new Date() },
      });
    }

    // 4. Create a revocable session + device record.
    const expiresAt = new Date(
      Date.now() + (this.config.get<number>('SESSION_TTL_SECONDS') ?? 604800) * 1000,
    );
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: await hashSecret(`${payload.nonce}:${payload.publicKey}`),
        deviceId: undefined,
        ipAddress: undefined,
        userAgent: undefined,
        expiresAt,
      },
    });

    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '7d';
    const accessToken = signAccessToken(
      {
        sub: user.id,
        publicKey: payload.publicKey,
        role: user.role as UserRole,
        sessionId: session.id,
      },
      this.secret(),
      expiresIn,
    );
    const refreshToken = signRefreshToken(
      {
        sub: user.id,
        publicKey: payload.publicKey,
        role: user.role as UserRole,
        sessionId: session.id,
      },
      this.secret(),
    );

    return { accessToken, refreshToken, expiresInSeconds: 7 * 24 * 3600, user: toUserDto(user) };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const payload = verifyRefreshToken(refreshToken, this.secret());
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sessionId ?? '' },
    });
    if (!session || session.status !== 'ACTIVE' || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session revoked or expired');
    }
    const accessToken = signAccessToken(
      {
        sub: payload.sub,
        publicKey: payload.publicKey,
        role: payload.role,
        sessionId: payload.sessionId,
      },
      this.secret(),
      this.config.get<string>('JWT_EXPIRES_IN') ?? '7d',
    );
    return { accessToken, refreshToken, expiresInSeconds: 7 * 24 * 3600 };
  }

  async logout(userId: string, sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.prisma.session.updateMany({
        where: { id: sessionId, userId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
    } else {
      await this.prisma.session.updateMany({
        where: { userId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
    }
  }

  async adminLogin(input: AdminLogin): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user?.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if ((user.role as string) !== 'ADMIN' && (user.role as string) !== 'SUPPORT') {
      throw new UnauthorizedException('Not an admin account');
    }
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const session = await this.prisma.session.create({
      data: { userId: user.id, tokenHash: await hashSecret(`${user.id}:${Date.now()}`), expiresAt },
    });
    const accessToken = signAccessToken(
      { sub: user.id, role: user.role as UserRole, sessionId: session.id },
      this.secret(),
      this.config.get<string>('JWT_EXPIRES_IN') ?? '7d',
    );
    const refreshToken = signRefreshToken(
      { sub: user.id, role: user.role as UserRole, sessionId: session.id },
      this.secret(),
    );
    return { accessToken, refreshToken, expiresInSeconds: 7 * 24 * 3600, user: toUserDto(user) };
  }
}

export function toUserDto(user: {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  role: string;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status as User['status'],
    role: user.role as User['role'],
    locale: user.locale,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
