import { Injectable } from "@nestjs/common";
import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { AdminRoles } from "../admin.guard";
import { SupabaseService } from "@common/supabase/supabase.service";
import { SettlementService } from "@common/services/settlement.service";
import { paginate, PaginationDto } from "@common/dto/pagination.dto";

@Injectable()
export class AdminSystemService {
  constructor(
    private supabase: SupabaseService,
    private settlement: SettlementService,
  ) {}

  async getAuditLog(
    q: PaginationDto & { action?: string; resourceType?: string },
  ) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const offset = (page - 1) * limit;
    let query = this.supabase.admin
      .from("audit_logs")
      .select(
        "id, action, resource_type, resource_id, ip_address, metadata, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (q.action) query = query.eq("action", q.action);
    if (q.resourceType) query = query.eq("resource_type", q.resourceType);
    const { data, count } = await query;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async getReconciliation() {
    return this.settlement.getReconciliation();
  }

  async getHealth() {
    const [
      reconciliation,
      { count: pendingDeliveries },
      { count: pendingHolds },
    ] = await Promise.all([
      this.settlement.getReconciliation(),
      this.supabase.admin
        .from("token_deliveries")
        .select("*", { count: "exact", head: true })
        .eq("status", "PENDING"),
      this.supabase.admin
        .from("wallet_holds")
        .select("*", { count: "exact", head: true })
        .eq("status", "HOLDING")
        .lt("held_at", new Date(Date.now() - 30 * 60 * 1000).toISOString()),
    ]);

    const alerts: string[] = [];
    if (reconciliation && reconciliation.ledgerDrift !== 0)
      alerts.push(`🚨 Ledger drift: ₦${reconciliation.ledgerDrift}`);
    if ((pendingHolds ?? 0) > 0)
      alerts.push(`⚠️ ${pendingHolds} wallet hold(s) stuck > 30 minutes`);
    if ((pendingDeliveries ?? 0) > 50)
      alerts.push(`⚠️ ${pendingDeliveries} pending token deliveries`);

    return {
      status: alerts.length === 0 ? "HEALTHY" : "NEEDS_ATTENTION",
      alerts,
      ledgerDrift: reconciliation?.ledgerDrift ?? 0,
      pendingDeliveries: pendingDeliveries ?? 0,
      stuckHolds: pendingHolds ?? 0,
      checkedAt: new Date().toISOString(),
    };
  }

  async getWalletHolds(status?: string) {
    let q = this.supabase.admin
      .from("wallet_holds")
      .select(
        "id, user_id, transaction_ref, hold_amount, card_amount, total_amount, status, paystack_ref, held_at, released_at, metadata",
      )
      .order("held_at", { ascending: false })
      .limit(100);
    if (status) q = q.eq("status", status);
    const { data } = await q;
    return data ?? [];
  }
}

@ApiTags("Admin — System")
@ApiBearerAuth("JWT")
@Controller({ path: "admin/system", version: "1" })
export class AdminSystemController {
  constructor(private svc: AdminSystemService) {}

  @Get("health")
  @ApiOperation({
    summary:
      "Platform health check — ledger drift, stuck holds, pending deliveries",
  })
  health() {
    return this.svc.getHealth();
  }

  @Get("reconciliation")
  @ApiOperation({
    summary: "Wallet reconciliation — ledger_drift must always be 0",
  })
  reconciliation() {
    return this.svc.getReconciliation();
  }

  @Get("audit-log")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @ApiOperation({ summary: "Admin audit log" })
  auditLog(
    @Query() q: PaginationDto & { action?: string; resourceType?: string },
  ) {
    return this.svc.getAuditLog(q);
  }

  @Get("wallet-holds")
  @ApiOperation({
    summary:
      "View wallet holds — HOLDING=active, CAPTURED=done, RELEASED=refunded",
  })
  walletHolds(@Query("status") status?: string) {
    return this.svc.getWalletHolds(status);
  }
}
