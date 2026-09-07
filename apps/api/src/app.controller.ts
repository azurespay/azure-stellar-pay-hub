import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@stellar-pay/database';
import { RedisService } from './infra/redis.service';
import { Public } from './common/decorators';

@Controller()
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    let database = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      /* db not reachable */
    }
    return {
      status: 'ok',
      service: 'stellar-pay-api',
      version: '0.1.0',
      network: this.config.get<string>('STELLAR_NETWORK'),
      database,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness probe: the API only reports ready when its local dependencies
   * (Postgres, Redis) are reachable. Returns 503 with per-component status so
   * orchestrators stop routing traffic during an outage. Kept shallow (no
   * outbound Stellar calls) so it never masks an upstream Stellar incident
   * as an API incident.
   */
  @Public()
  @Get('health/ready')
  async ready() {
    let database = 'down';
    let redis = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      /* db not reachable */
    }
    try {
      await this.redis.raw.ping();
      redis = 'up';
    } catch {
      /* redis not reachable */
    }
    const checks = { database, redis };
    if (database !== 'up' || redis !== 'up') {
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }
    return {
      status: 'ok',
      service: 'stellar-pay-api',
      checks,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
