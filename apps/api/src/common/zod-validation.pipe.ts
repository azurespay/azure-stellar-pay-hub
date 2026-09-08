import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

type SchemaMap = { body?: ZodType; query?: ZodType; params?: ZodType };

/**
 * Validate a request body / query / params against Zod schemas from
 * `@stellar-pay/validation`.
 *
 * Usage: `@Body(new ZodValidationPipe({ body: createPaymentSchema })) dto`
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schemas: SchemaMap) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema =
      metadata.type === 'body'
        ? this.schemas.body
        : metadata.type === 'query'
          ? this.schemas.query
          : this.schemas.params;
    if (!schema) {
      return value;
    }
    // For query/param routes the pipe is attached without a property key
    // (e.g. @Query(new ZodValidationPipe({ query }))), so `value` already is
    // the full query/param object and `metadata.data` is undefined — including
    // when the request carries no query string at all ({} / undefined). Use
    // `value` in that case so a parameterless GET is validated against an
    // empty object rather than rejected with "Required".
    const data =
      metadata.type === 'body'
        ? value
        : metadata.data !== undefined
          ? metadata.data
          : (value ?? {});
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: parsed.error.flatten(),
      });
    }
    return parsed.data;
  }
}
