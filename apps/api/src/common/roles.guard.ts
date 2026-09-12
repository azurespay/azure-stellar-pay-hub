import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasRole } from '@stellar-pay/authentication';
import type { UserRole } from '@stellar-pay/types';
import { ROLES_KEY, type AuthenticatedUser } from './decorators';

/**
 * Role guard: enforces @Roles(...) decorators using the role hierarchy
 * (USER < MERCHANT < SUPPORT < ADMIN).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }
    const allowed = required.some((role) => hasRole(user.role, role));
    if (!allowed) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }
    return true;
  }
}
