import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { CurrentAdmin, AdminUser, AdminRoles } from "../admin.guard";
import { SupabaseService } from "@common/supabase/supabase.service";
import { WalletService } from "@modules/wallet/wallet.service";
import { paginate, PaginationDto } from "@common/dto/pagination.dto";

class RefundDto {
  @ApiProperty() @IsString() reason: string;
}

@Injectable()
export class AdminTransactionsService {
  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
  ) {}

  async list(
    q: PaginationDto & {
      type?: string;
      status?: string;
      from?: string;
      to?: string;
      userId?: string;
      method?: string;
    },
  ) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const offset = (page - 1) * limit;
    let query = this.supabase.admin
      .from("transactions")
      .select(
        "id, reference, transaction_type, amount, payment_method, status, metadata, created_at, completed_at, user_id",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (q.type) query = query.eq("transaction_type", q.type);
    if (q.status) query = query.eq("status", q.status);
    if (q.userId) query = query.eq("user_id", q.userId);
    if (q.method) query = query.eq("payment_method", q.method);
    if (q.from) query = query.gte("created_at", q.from);
    if (q.to) query = query.lte("created_at", q.to);
    const { data, count } = await query;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async getOne(id: string) {
    const { data, error } = await this.supabase.admin
      .from("transactions")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) throw new NotFoundException("Transaction not found");
    let holdDetail: any = null;
    if (data.payment_method === "HYBRID") {
      const { data: hold } = await this.supabase.admin
        .from("wallet_holds")
        .select(
          "hold_amount, card_amount, total_amount, status, held_at, released_at, paystack_ref",
        )
        .eq("transaction_ref", data.reference)
        .maybeSingle();
      holdDetail = hold;
    }
    return { ...data, holdDetail };
  }

  async refund(id: string, reason: string, adminEmail: string) {
    const { data: txn } = await this.supabase.admin
      .from("transactions")
      .select("*")
      .eq("id", id)
      .single();
    if (!txn) throw new NotFoundException("Transaction not found");
    if (txn.status !== "COMPLETED")
      throw new BadRequestException({
        code: "NOT_REFUNDABLE",
        message: "Only COMPLETED transactions can be refunded",
      });

    if (txn.payment_method === "WALLET") {
      await this.wallet.creditWallet(
        txn.user_id,
        Number(txn.amount),
        `Admin refund: ${reason} — ${txn.reference}`,
      );
      await this.supabase.admin
        .from("transactions")
        .update({ status: "REFUNDED" })
        .eq("id", id);
      await this.supabase.admin
        .from("audit_logs")
        .insert({
          action: "TRANSACTION_REFUNDED",
          resource_type: "TRANSACTION",
          resource_id: id,
          metadata: {
            reason,
            by: adminEmail,
            amount: txn.amount,
            method: "WALLET",
          },
        });
      return {
        message: "Wallet refund processed",
        amount: txn.amount,
        method: "WALLET",
      };
    }

    if (txn.payment_method === "HYBRID") {
      const { data: hold } = await this.supabase.admin
        .from("wallet_holds")
        .select("*")
        .eq("transaction_ref", txn.reference)
        .maybeSingle();
      const walletPortion = hold ? Number(hold.hold_amount) : 0;
      const cardPortion = hold ? Number(hold.card_amount) : Number(txn.amount);
      if (walletPortion > 0) {
        await this.wallet.creditWallet(
          txn.user_id,
          walletPortion,
          `Admin hybrid refund (wallet portion): ${reason}`,
        );
      }
      await this.supabase.admin
        .from("transactions")
        .update({ status: "REFUNDED" })
        .eq("id", id);
      await this.supabase.admin
        .from("audit_logs")
        .insert({
          action: "TRANSACTION_REFUNDED",
          resource_type: "TRANSACTION",
          resource_id: id,
          metadata: {
            reason,
            by: adminEmail,
            walletRefunded: walletPortion,
            cardPortion,
            method: "HYBRID",
          },
        });
      return {
        message: "Hybrid refund processed",
        walletRefunded: walletPortion,
        cardPortion,
        note:
          cardPortion > 0
            ? `₦${cardPortion.toLocaleString()} card portion must be refunded via Paystack dashboard`
            : undefined,
      };
    }

    throw new BadRequestException({
      code: "CARD_REFUND_MANUAL",
      message: `${txn.payment_method} payment. Refund via Paystack dashboard. Reference: ${txn.reference}`,
    });
  }

  async getStats() {
    const today = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const [{ data: byType }, { data: todayTxns }] = await Promise.all([
      this.supabase.admin
        .from("transactions")
        .select("transaction_type, amount, status"),
      this.supabase.admin
        .from("transactions")
        .select("amount, status")
        .gte("created_at", today),
    ]);
    const completedToday = (todayTxns ?? [])
      .filter((t) => t.status === "COMPLETED")
      .reduce((s, t) => s + Number(t.amount), 0);
    const grouped: Record<string, { count: number; total: number }> = {};
    for (const t of byType ?? []) {
      if (!grouped[t.transaction_type])
        grouped[t.transaction_type] = { count: 0, total: 0 };
      grouped[t.transaction_type].count++;
      if (t.status === "COMPLETED")
        grouped[t.transaction_type].total += Number(t.amount);
    }
    return { completedToday, byType: grouped };
  }
}

@ApiTags("Admin — Transactions")
@ApiBearerAuth("JWT")
@Controller({ path: "admin/transactions", version: "1" })
export class AdminTransactionsController {
  constructor(private svc: AdminTransactionsService) {}

  @Get()
  @ApiOperation({ summary: "List all transactions with filters" })
  list(
    @Query()
    q: PaginationDto & {
      type?: string;
      status?: string;
      from?: string;
      to?: string;
      userId?: string;
      method?: string;
    },
  ) {
    return this.svc.list(q);
  }

  @Get("stats")
  @ApiOperation({ summary: "Transaction stats by type" })
  stats() {
    return this.svc.getStats();
  }

  @Get(":id")
  @ApiOperation({
    summary: "Transaction detail (includes hold info for HYBRID)",
  })
  getOne(@Param("id") id: string) {
    return this.svc.getOne(id);
  }

  @Post(":id/refund")
  @AdminRoles("SUPER_ADMIN", "ADMIN", "FINANCE")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Refund a WALLET or HYBRID transaction" })
  refund(
    @Param("id") id: string,
    @Body() dto: RefundDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.svc.refund(id, dto.reason, admin.email);
  }
}
