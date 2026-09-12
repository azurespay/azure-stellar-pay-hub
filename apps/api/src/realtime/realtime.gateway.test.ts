import { signAccessToken } from '@stellar-pay/authentication';
import { UserRole } from '@stellar-pay/types';
import { RealtimeGateway } from './realtime.gateway';

const SECRET = 'test-secret-at-least-16-chars';

function makeClient(token?: string) {
  return {
    id: 'socket-1',
    handshake: { auth: token ? { token } : {} },
    join: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
  };
}

describe('RealtimeGateway.handleConnection', () => {
  let gateway: RealtimeGateway;
  let prisma: {
    session: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  const config = { get: jest.fn((key: string) => (key === 'JWT_SECRET' ? SECRET : 'redis://x')) };

  const token = signAccessToken(
    { sub: 'user-1', role: UserRole.USER, sessionId: 'session-1' },
    SECRET,
    '1h',
  );

  const activeSession = {
    id: 'session-1',
    userId: 'user-1',
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 60_000),
  };

  beforeEach(() => {
    prisma = {
      session: { findUnique: jest.fn().mockResolvedValue(activeSession) },
      user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };
    gateway = new RealtimeGateway(config as never, prisma as never);
  });

  it('joins the user room for a fully valid session', async () => {
    const client = makeClient(token);
    await gateway.handleConnection(client as never);

    expect(client.join).toHaveBeenCalledWith('user:user-1');
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects a socket with no token', async () => {
    const client = makeClient();
    await gateway.handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects a revoked session even though the JWT is still valid', async () => {
    prisma.session.findUnique.mockResolvedValue({ ...activeSession, status: 'REVOKED' });
    const client = makeClient(token);
    await gateway.handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects an expired session', async () => {
    prisma.session.findUnique.mockResolvedValue({
      ...activeSession,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const client = makeClient(token);
    await gateway.handleConnection(client as never);

    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects a suspended account', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
    const client = makeClient(token);
    await gateway.handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects a token signed with another secret', async () => {
    const forged = signAccessToken(
      { sub: 'user-1', role: UserRole.ADMIN },
      'attacker-secret-16',
      '1h',
    );
    const client = makeClient(forged);
    await gateway.handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});
