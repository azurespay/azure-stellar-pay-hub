import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Roles } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  assetCreateSchema,
  merchantStatusSchema,
  roleAssignmentSchema,
  settingsSchema,
  transactionQuerySchema,
  userStatusSchema,
  type CreateAsset,
  type MerchantStatusUpdate,
  type RoleAssignment,
  type TransactionQuery,
  type UpsertSetting,
  type UserStatusUpdate,
} from '@stellar-pay/validation';
import { UserRole } from '@stellar-pay/types';
import { AdminService } from './admin.service';

@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('users')
  users(@Query() query: { page?: string; pageSize?: string; search?: string }) {
    return this.admin.users({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      search: query.search,
    });
  }

  @Patch('users/:id/status')
  updateUserStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: userStatusSchema })) body: UserStatusUpdate,
  ) {
    return this.admin.updateUserStatus(id, body.status, body.reason);
  }

  @Post('roles')
  assignRole(@Body(new ZodValidationPipe({ body: roleAssignmentSchema })) body: RoleAssignment) {
    return this.admin.assignRole(body.userId, body.role);
  }

  @Get('merchants')
  merchants(@Query() query: { page?: string; pageSize?: string }) {
    return this.admin.merchants({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
    });
  }

  @Patch('merchants/:id/status')
  updateMerchantStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: merchantStatusSchema })) body: MerchantStatusUpdate,
  ) {
    return this.admin.updateMerchantStatus(id, body.status, body.reason);
  }

  @Get('transactions')
  transactions(
    @Query(new ZodValidationPipe({ query: transactionQuerySchema })) query: TransactionQuery,
  ) {
    return this.admin.transactions(query);
  }

  @Get('audit-logs')
  auditLogs(@Query() query: { page?: string; pageSize?: string }) {
    return this.admin.auditLogs({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
    });
  }

  @Get('assets')
  assets() {
    return this.admin.assets();
  }

  @Post('assets')
  createAsset(@Body(new ZodValidationPipe({ body: assetCreateSchema })) body: CreateAsset) {
    return this.admin.createAsset(body);
  }

  @Get('notifications')
  notifications(@Query() query: { page?: string; pageSize?: string }) {
    return this.admin.notifications({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
    });
  }

  @Get('settings')
  settings() {
    return this.admin.settings();
  }

  @Put('settings')
  updateSetting(@Body(new ZodValidationPipe({ body: settingsSchema })) body: UpsertSetting) {
    return this.admin.upsertSetting(body.key, body.value);
  }
}
