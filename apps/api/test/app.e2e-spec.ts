import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * E2E smoke tests. Requires PostgreSQL + Redis (see docker-compose).
 * Run: pnpm --filter @stellar-pay/api test:e2e
 */
describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://postgres:postgres@localhost:5432/stellar_pay?schema=public';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns service status', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('stellar-pay-api');
  });

  it('GET /api/health/ready reports ok when Postgres and Redis respond', async () => {
    const response = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks).toEqual({ database: 'up', redis: 'up' });
  });

  it('GET /api/metrics returns 404 when metrics are disabled', async () => {
    // METRICS_ENABLED is not set in this environment, so the endpoint is off.
    await request(app.getHttpServer()).get('/api/metrics').expect(404);
  });

  it('POST /api/auth/challenge issues a challenge for a valid key', async () => {
    const key = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const response = await request(app.getHttpServer())
      .post('/api/auth/challenge')
      .send({ publicKey: key })
      .expect(201);
    expect(response.body.message).toContain(key);
    expect(response.body.nonce).toHaveLength(64);
  });

  it('rejects an invalid public key for a challenge', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/challenge')
      .send({ publicKey: 'not-a-key' })
      .expect(400);
  });

  it('requires auth on /api/users/me', async () => {
    await request(app.getHttpServer()).get('/api/users/me').expect(401);
  });
});
