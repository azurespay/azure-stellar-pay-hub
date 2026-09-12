import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { transactionQuerySchema, type TransactionQuery } from '@stellar-pay/validation';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Public()
  @Get()
  list(@Query(new ZodValidationPipe({ query: transactionQuerySchema })) query: TransactionQuery) {
    return this.transactions.list(query);
  }

  @Public()
  @Get('stats')
  stats() {
    return this.transactions.stats();
  }

  @Public()
  @Get('hash/:hash')
  byHash(@Param('hash') hash: string) {
    return this.transactions.getByHash(hash);
  }

  @Public()
  @Get(':id')
  byId(@Param('id') id: string) {
    return this.transactions.getById(id);
  }
}
