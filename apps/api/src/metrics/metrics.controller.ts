import { Controller, Get, NotFoundException, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint. Disabled unless METRICS_ENABLED=true so the
 * plaintext metrics are not exposed by default; when enabled it is public
 * (no JWT) because Prometheus cannot authenticate with a user token.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get()
  scrape(@Res() res: Response): void {
    if (this.config.get<string>('METRICS_ENABLED') !== 'true') {
      throw new NotFoundException('Metrics are disabled');
    }
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(this.metrics.render());
  }
}
