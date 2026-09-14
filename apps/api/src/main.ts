import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { createLogger } from '@stellar-pay/logger';
import { PrismaService } from '@stellar-pay/database';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = createLogger('api');
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  app.setGlobalPrefix('api');
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  const config = app.get(ConfigService);
  const corsOrigins = config.get<string[]>('CORS_ORIGINS') ?? ['http://localhost:3000'];
  app.enableCors({ origin: corsOrigins, credentials: true });

  // Connect Prisma before serving traffic.
  const prisma = app.get(PrismaService);
  await prisma.connect();

  // Graceful shutdown: disconnect Prisma on SIGTERM/SIGINT.
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    try {
      await prisma.disconnect();
      await app.close();
    } catch (err) {
      logger.error('Error during shutdown', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Soft dependencies (Redis rate-limit state, socket fan-out) reject their
  // pending commands while they are briefly unreachable. Node's default is to
  // turn an unhandled rejection into a fatal exception, which turns a Redis
  // blip into a full API outage — the process exits and every in-flight request
  // dies with it. Log it and keep serving: `/api/health/ready` reports the
  // degraded dependency, so the platform can still act on it.
  //
  // Only rejections are intercepted. A synchronous `uncaughtException` still
  // crashes as it should, so genuine bugs are not masked.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection (process kept alive)', reason);
  });

  const port = config.get<number>('API_PORT') ?? 4000;
  await app.listen(port);
  logger.info(`API listening on :${port} (network=${config.get('STELLAR_NETWORK')})`);
}

void bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
