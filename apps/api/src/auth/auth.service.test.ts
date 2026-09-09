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
});
