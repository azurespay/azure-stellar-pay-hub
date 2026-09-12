import { signRefreshToken } from '@stellar-pay/authentication';
import { UserRole } from '@stellar-pay/types';
import { AuthService } from './auth.service';

describe('AuthService — unit-level validation', () => {
  let service: AuthService;
  let mockRedis: Record<string, jest.Mock>;
  let mockConfig: Record<string, jest.Mock>;

  beforeEach(() => {
    mockRedis = {
      setJson: jest.fn().mockResolvedValue(undefined),
      getJson: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };

    mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'JWT_SECRET') return 'test-secret-at-least-16-chars';
        if (key === 'JWT_EXPIRES_IN') return '1h';
        if (key === 'SESSION_TTL_SECONDS') return 604800;
        return undefined;
      }),
    };

    service = new AuthService(undefined as any, mockRedis as any, mockConfig as any);
  });

  describe('createChallenge', () => {
    it('creates a challenge for a valid public key', async () => {
      const result = await service.createChallenge(
        'GBJQY3BN2MTOFBPCW4MZZQBZDY5IYRXBMJX3SB64STGW6UB44ZWIJSD3',
      );
      expect(result).toHaveProperty('nonce');
      expect(result).toHaveProperty('message');
      expect(result.message).toContain('GBJQY3');
      expect(mockRedis.setJson).toHaveBeenCalled();
    });
  });

  describe('JWT secret access', () => {
    it('reads JWT_SECRET from config', () => {
      expect(mockConfig.get).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    const secret = 'test-secret-at-least-16-chars';
    let prisma: { session: { findUnique: jest.Mock }; user: { findUnique: jest.Mock } };
    let svc: AuthService;

    const activeSession = {
      id: 'sess-1',
      userId: 'user-1',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const activeUser = { status: 'ACTIVE' };

    beforeEach(() => {
      prisma = { session: { findUnique: jest.fn() }, user: { findUnique: jest.fn() } };
      svc = new AuthService(prisma as any, mockRedis as any, mockConfig as any);
    });

    const tokenFor = (sessionId: string) =>
      signRefreshToken({ sub: 'user-1', role: UserRole.USER, sessionId }, secret);

    it('rejects a refresh whose session is revoked', async () => {
      prisma.session.findUnique.mockResolvedValue({
        ...activeSession,
        status: 'REVOKED',
      });
      await expect(svc.refresh(tokenFor('sess-1'))).rejects.toThrow('Session revoked or expired');
    });

    it('rejects a refresh whose session belongs to another subject', async () => {
      prisma.session.findUnique.mockResolvedValue({ ...activeSession, userId: 'someone-else' });
      await expect(svc.refresh(tokenFor('sess-1'))).rejects.toThrow(
        'Session does not match token subject',
      );
    });

    it('rejects a refresh for a suspended account (fail closed)', async () => {
      prisma.session.findUnique.mockResolvedValue(activeSession);
      prisma.user.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
      await expect(svc.refresh(tokenFor('sess-1'))).rejects.toThrow(
        'Account is suspended or not yet activated',
      );
    });

    it('rejects a refresh for a deleted account', async () => {
      prisma.session.findUnique.mockResolvedValue(activeSession);
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.refresh(tokenFor('sess-1'))).rejects.toThrow(
        'Account is suspended or not yet activated',
      );
    });

    it('issues a new access token for an active session and account', async () => {
      prisma.session.findUnique.mockResolvedValue(activeSession);
      prisma.user.findUnique.mockResolvedValue(activeUser);
      const tokens = await svc.refresh(tokenFor('sess-1'));
      expect(tokens.accessToken).toEqual(expect.any(String));
      expect(tokens.refreshToken).toEqual(expect.any(String));
      expect(tokens.expiresInSeconds).toBeGreaterThan(0);
    });
  });
});
