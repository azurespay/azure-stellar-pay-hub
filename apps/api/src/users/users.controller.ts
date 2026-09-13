import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createBeneficiarySchema,
  createContactSchema,
  preferencesSchema,
  updateProfileSchema,
  type CreateBeneficiary,
  type CreateContact,
  type UpdatePreferences,
  type UpdateProfile,
} from '@stellar-pay/validation';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.me(user.userId);
  }

  @Patch('me')
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: updateProfileSchema })) body: UpdateProfile,
  ) {
    return this.users.updateProfile(user.userId, body);
  }

  @Get('me/preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.users.preferences(user.userId);
  }

  @Put('me/preferences')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: preferencesSchema })) body: UpdatePreferences,
  ) {
    return this.users.updatePreferences(user.userId, body);
  }

  @Get('me/contacts')
  contacts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.users.contacts(user.userId, Number(page), Number(pageSize));
  }

  @Post('me/contacts')
  createContact(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createContactSchema })) body: CreateContact,
  ) {
    return this.users.createContact(user.userId, body);
  }

  @Delete('me/contacts/:id')
  deleteContact(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.users.deleteContact(user.userId, id);
  }

  // Wrapped in a `data` envelope to match the SDK's `ApiResponse<Beneficiary[]>`
  // type, consistent with the other collection endpoints.
  @Get('me/beneficiaries')
  async beneficiaries(@CurrentUser() user: AuthenticatedUser) {
    return { data: await this.users.beneficiaries(user.userId) };
  }

  @Post('me/beneficiaries')
  createBeneficiary(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createBeneficiarySchema })) body: CreateBeneficiary,
  ) {
    return this.users.createBeneficiary(user.userId, body);
  }
}
