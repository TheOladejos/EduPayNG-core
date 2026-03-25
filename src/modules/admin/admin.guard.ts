import {
  SetMetadata,
  createParamDecorator,
  ExecutionContext,
} from "@nestjs/common";
import { Injectable, CanActivate } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

export const ADMIN_ROLES_KEY = "admin_roles";

// Decorator — mark route with required admin roles
export const AdminRoles = (...roles: string[]) =>
  SetMetadata(ADMIN_ROLES_KEY, roles);

// Guard — checks JWT payload.role against allowed roles
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      ADMIN_ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required?.length) return true; // no role restriction

    const { user } = ctx.switchToHttp().getRequest();
    return required.includes(user?.role);
  }
}

// Decorator — inject current admin from JWT
export const CurrentAdmin = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user,
);

export interface AdminUser {
  id: string;
  email: string;
  role: string;
}
