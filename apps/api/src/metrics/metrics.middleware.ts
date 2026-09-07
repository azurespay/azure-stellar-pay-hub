import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/** Count every HTTP request (method + status class) for the /metrics endpoint. */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    res.on('finish', () => {
      this.metrics.inc('http_requests_total', {
        method: req.method,
        status: String(res.statusCode),
      });
    });
    next();
  }
}
