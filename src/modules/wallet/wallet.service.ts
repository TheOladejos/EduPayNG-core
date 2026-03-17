import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SupabaseService } from "../../common/supabase/supabase.service";
import { PaystackService } from "../payments/gateway/paystack.gateway";
import { FundWalletDto, PurchasePointsDto, PaymentMethod } from "./wallet.dto";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";
import { generateRef } from "../../common/helpers/generators";

@Injectable()
export class WalletService {
  private email: string | undefined
  
  constructor(
    private supabase: SupabaseService,
    private paystack: PaystackService,
    private config: ConfigService,
    
  ) {}

  async getWallet(userId: string) {
    const { data, error } = await this.supabase.admin
      .from("wallets")
      .select(
        "id, balance, points, total_funded, total_spent, is_active, updated_at",
      )
      .eq("user_id", userId)
      .single();

    if (error || !data)
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Wallet not found",
      });

    return {
      id: data.id,
      balance: data.balance,
      points: data.points,
      totalFunded: data.total_funded,
      totalSpent: data.total_spent,
      isActive: data.is_active,
      lastUpdated: data.updated_at,
    };
  }

  async fundWallet(userId: string, dto: FundWalletDto) {
    const reference = generateRef("WF");

    // Fetch user email for Paystack (required)
    const { data: authUser } =
      await this.supabase.admin.auth.admin.getUserById(userId);
    this.email = authUser?.user?.email;
    if (!this.email)
      throw new BadRequestException({
        code: "USER_NOT_FOUND",
        message: "User not found",
      });

    const { data: txn, error } = await this.supabase.admin
      .from("transactions")
      .insert({
        user_id: userId,
        reference,
        transaction_type: "WALLET_FUNDING",
        amount: dto.amount,
        payment_method: dto.paymentMethod,
        status: "PENDING",
      })
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException({
        code: "TXN_FAILED",
        message: error.message,
      });

    // ── Paystack handles all wallet funding ──
    const payment = await this.paystack.initialize({
      email: this.email,
      amountNaira: dto.amount,
      reference,
      callbackUrl:
        dto.callbackUrl ?? `${this.config.get("APP_URL")}/wallet/fund/callback`,
      metadata: { userId, transactionId: txn.id, type: "WALLET_FUNDING" },
    });

    return {
      transactionId: txn.id,
      reference,
      authorizationUrl: payment.authorizationUrl,
      accessCode: payment.accessCode,
      amount: dto.amount,
      gateway: "PAYSTACK",
    };
  }

  async getTransactions(
    userId: string,
    query: PaginationDto & { type?: string },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const { data: wallet } = await this.supabase.admin
      .from("wallets")
      .select("id")
      .eq("user_id", userId)
      .single();
    if (!wallet)
      throw new NotFoundException({
        code: "WALLET_NOT_FOUND",
        message: "Wallet not found",
      });

    let q = this.supabase.admin
      .from("wallet_transactions")
      .select("*", { count: "exact" })
      .eq("wallet_id", wallet.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (query.type) q = q.eq("type", query.type);

    const { data, error, count } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    const items = (data ?? []).map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      balanceBefore: t.balance_before,
      balanceAfter: t.balance_after,
      description: t.description,
      createdAt: t.created_at,
    }));

    return paginate(items, count ?? 0, page, limit);
  }

  async getPointPackages() {
    const { data, error } = await this.supabase.admin
      .from("point_packages")
      .select("id, name, amount, points, bonus_percentage, description")
      .eq("is_active", true)
      .order("display_order");

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      amount: p.amount,
      points: p.points,
      bonusPercentage: p.bonus_percentage ?? 0,
      totalPoints: Math.floor(p.points * (1 + (p.bonus_percentage ?? 0) / 100)),
      description: p.description,
    }));
  }

  async purchasePoints(userId: string, dto: PurchasePointsDto) {
    const { data: pkg } = await this.supabase.admin
      .from("point_packages")
      .select("*")
      .eq("id", dto.packageId)
      .eq("is_active", true)
      .single();

    if (!pkg)
      throw new NotFoundException({
        code: "PACKAGE_NOT_FOUND",
        message: "Point package not found",
      });

    const reference = generateRef("PP");
    const totalPoints = Math.floor(
      pkg.points * (1 + (pkg.bonus_percentage ?? 0) / 100),
    );

    if (dto.paymentMethod === PaymentMethod.WALLET) {
      await this.debitWallet(
        userId,
        pkg.amount,
        `Points purchase - ${pkg.name}`,
      );

      // Credit points
      const { data: wallet } = await this.supabase.admin
        .from("wallets")
        .select("points")
        .eq("user_id", userId)
        .single();
      await this.supabase.admin
        .from("wallets")
        .update({ points: (wallet?.points ?? 0) + totalPoints })
        .eq("user_id", userId);

      await this.supabase.admin.from("transactions").insert({
        user_id: userId,
        reference,
        transaction_type: "POINT_PURCHASE",
        amount: pkg.amount,
        payment_method: "WALLET",
        status: "COMPLETED",
        completed_at: new Date().toISOString(),
        metadata: { packageId: pkg.id, pointsAwarded: totalPoints },
      });

      await this.sendNotification(
        userId,
        "Points Purchased",
        `${totalPoints.toLocaleString()} points added to your account.`,
        "SUCCESS",
        "TRANSACTION",
      );

      return { reference, pointsAwarded: totalPoints, status: "COMPLETED" };
    }

    // External payment
    const { data: txn } = await this.supabase.admin
      .from("transactions")
      .insert({
        user_id: userId,
        reference,
        transaction_type: "POINT_PURCHASE",
        amount: pkg.amount,
        payment_method: dto.paymentMethod,
        status: "PENDING",
        metadata: { packageId: pkg.id, pointsAwarded: totalPoints },
      })
      .select()
      .single();

    const payment = await this.paystack.initialize({
      amountNaira: pkg.amount,
      reference,
      email: this.email as string,
      callbackUrl: `${this.config.get("APP_URL")}/wallet/points/callback`,
      metadata: {
        userId,
        transactionId: txn.id,
        type: "POINT_PURCHASE",
        description: `EduPayNG Points - ${pkg.name}`,
      },
    });

    return {
      transactionId: txn?.id,
      reference: payment.reference,
      paymentUrl: payment.authorizationUrl,
      amount: pkg.amount,
      pointsToReceive: totalPoints,
      accessCode: payment.accessCode,
    };
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  async debitWallet(userId: string, amount: number, description: string) {
    const { data: wallet } = await this.supabase.admin
      .from("wallets")
      .select("id, balance, points, total_funded, total_spent")
      .eq("user_id", userId)
      .eq("is_active", true)
      .single();

    if (!wallet) throw new NotFoundException("Wallet not found");
    if (wallet.balance < amount) {
      throw new BadRequestException({
        code: "INSUFFICIENT_BALANCE",
        message: "Insufficient wallet balance",
        currentBalance: wallet.balance,
        required: amount,
        shortfall: amount - wallet.balance,
      });
    }

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore - amount;
    const newTotalSpent = Number(wallet.total_spent) + amount;

    await this.supabase.admin
      .from("wallets")
      .update({ balance: balanceAfter, total_spent: newTotalSpent })
      .eq("id", wallet.id);

    await this.supabase.admin.from("wallet_transactions").insert({
      wallet_id: wallet.id,
      user_id: userId,
      type: "DEBIT",
      amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      description,
    });

    // Return a full wallet snapshot so callers can propagate to the frontend
    return {
      walletId: wallet.id,
      balanceBefore,
      balanceAfter,
      deducted: amount,
      points: wallet.points,
      totalFunded: wallet.total_funded,
      totalSpent: newTotalSpent,
    };
  }

  async creditWallet(userId: string, amount: number, description: string) {
    const { data: wallet } = await this.supabase.admin
      .from("wallets")
      .select("id, balance, total_funded")
      .eq("user_id", userId)
      .single();
    if (!wallet) throw new NotFoundException("Wallet not found");

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore + amount;
    const newTotalFunded = Number(wallet.total_funded) + amount;

    await this.supabase.admin
      .from("wallets")
      .update({ balance: balanceAfter, total_funded: newTotalFunded })
      .eq("id", wallet.id);

    await this.supabase.admin.from("wallet_transactions").insert({
      wallet_id: wallet.id,
      user_id: userId,
      type: "CREDIT",
      amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      description,
    });

    return { balanceBefore, balanceAfter };
  }

  async sendNotification(
    userId: string,
    title: string,
    message: string,
    type: string,
    category: string,
    metadata?: object,
  ) {
    await this.supabase.admin.from("notifications").insert({
      user_id: userId,
      title,
      message,
      type,
      category,
      metadata: metadata ?? {},
      is_read: false,
    });
  }
}
