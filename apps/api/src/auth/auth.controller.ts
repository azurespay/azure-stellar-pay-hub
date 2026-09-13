import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public, CurrentUser, CsrfBypass, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  adminLoginSchema,
  challengeRequestSchema,
  refreshTokenSchema,
  verifyRequestSchema,
  type ChallengeRequest,
  type VerifyRequest,
  type AdminLogin,
  type RefreshToken,
} from '@stellar-pay/validation';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @CsrfBypass()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('challenge')
  challenge(@Body(new ZodValidationPipe({ body: challengeRequestSchema })) body: ChallengeRequest) {
    return this.auth.createChallenge(body.publicKey);
  }

  @Public()
  @CsrfBypass()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify')
  verify(@Body(new ZodValidationPipe({ body: verifyRequestSchema })) body: VerifyRequest) {
    return this.auth.verifyWallet(body);
  }

  @Public()
  @CsrfBypass()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe({ body: refreshTokenSchema })) body: RefreshToken) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @CsrfBypass()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('admin/login')
  adminLogin(@Body(new ZodValidationPipe({ body: adminLoginSchema })) body: AdminLogin) {
    return this.auth.adminLogin(body);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.auth.logout(user.userId, user.sessionId);
  }

  // The SDK types this as `ApiResponse<Session[]>`, so the list is wrapped in a
  // `data` envelope like every other collection endpoint. Returning a bare array
  // here made the settings page crash on `res.data.map`.
  @Get('sessions')
  async listSessions(@CurrentUser() user: AuthenticatedUser) {
    return { data: await this.sessions.listSessions(user.userId) };
  }

  @Delete('sessions/:id')
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @Param('id') sessionId: string) {
    await this.sessions.revokeSession(user.userId, sessionId);
    return { ok: true };
  }

  @Get('devices')
  async devices(@CurrentUser() user: AuthenticatedUser) {
    return { data: await this.sessions.listDevices(user.userId) };
  }

  @Delete('devices/:id')
  async revokeDevice(@CurrentUser() user: AuthenticatedUser, @Param('id') deviceId: string) {
    await this.sessions.revokeDevice(user.userId, deviceId);
    return { ok: true };
  }
}
