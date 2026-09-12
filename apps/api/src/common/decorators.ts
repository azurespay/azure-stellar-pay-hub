import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@stellar-pay/types';

export const IS_PUBLIC_KEY = 'isPublic';
/** Mark a route as accessible without authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restrict a route to the given roles (hierarchy-aware). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const IS_CSRF_BYPASS_KEY = 'csrfBypass';
/** Mark a route as exempt from CSRF protection (e.g. webhooks, public callbacks). */
export const CsrfBypass = () => SetMetadata(IS_CSRF_BYPASS_KEY, true);

export interface AuthenticatedUser {
  userId: string;
  publicKey?: string;
  role: UserRole;
  sessionId?: string;
}

/** Extract the authenticated user attached by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedUser;
  },
);
