import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from "@nestjs/common";
import { SupabaseService } from "../../common/supabase/supabase.service";
import { WalletService } from "../wallet/wallet.service";
import { RevenueService } from "../../common/services/revenue.service";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";
import { generateRef } from "../../common/helpers/generators";
import { BuyAirtimeDto, BuyDataDto } from "./bills.dto";
import { VtpassService } from "@modules/payments/gateway/vtPass.gateway";
import { categorizeData } from "@common/helpers/helpers";

@Injectable()
export class BillsService implements OnModuleDestroy {
  private readonly logger = new Logger(BillsService.name);
  private readonly billersCache = new Map<string, any>(); // Cache biller details to avoid repeated DB calls during purchase flow

  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
    private revenue: RevenueService,
    private vtpass: VtpassService,
  ) {}
  onModuleDestroy() {
    this.billersCache.clear();
  }

  // ── Catalog endpoints (public) ────────────────────────────────

  async getCategories() {
    const { data } = await this.supabase.admin
      .from("bill_categories")
      .select("id, code, name, icon")
      .eq("is_active", true)
      .order("display_order");
    return data ?? [];
  }

  async clearBillerCache() {
    this.billersCache.clear();
    this.logger.log("Biller cache cleared manually.");
    return { message: "Cache cleared" };
  }

  async getBillers(categoryCode?: string) {
    // If categoryCode is provided, filter billers by category; otherwise return all billers
    const q = await this.getAndSetBillerCache(); // Preload biller cache on start
    if (categoryCode) return q.filter((b) => b.category_code === categoryCode);
    return q ?? [];
  }

  async getProducts(billerId: string) {
    const biller = await this.getBillerOrThrow(billerId);

    const data = await this.vtpass.getVariations(biller.vtpass_code);
    if (!data)
      throw new NotFoundException({
        code: "PRODUCT_NOT_FOUND",
        message: "Bill product not found",
      });

    // sorting by daily, weekly, monthly etc. variations to get the most expensive one (usually the first one) for accurate billing
    return categorizeData(data);
  }

  // ── Purchase: Airtime ─────────────────────────────────────────

  async buyAirtime(userId: string, dto: BuyAirtimeDto) {
    const biller = await this.getBillerOrThrow(dto.billerId, "AIRTIME");
    const reference = generateRef("AIR");

    // 1. Debit wallet — throws if insufficient balance
    const walletSnapshot = await this.wallet.debitWallet(
      userId,
      dto.amount,
      `${biller.short_name} Airtime → ${dto.phone}`,
    );

    // 2. Create pending records
    const txn = await this.createTransaction(
      userId,
      reference,
      "BILL_AIRTIME",
      dto.amount,
    );
    const billTxn = await this.createBillTransaction({
      userId,
      transactionId: txn.id,
      billerId: dto.billerId,
      categoryCode: "AIRTIME",
      customerPhone: dto.phone,
      amount: dto.amount,
    });

    // 3. Call VTPass — synchronous
    try {
      const result = await this.vtpass.buyAirtime({
        serviceId: biller.vtpass_code,
        phone: dto.phone,
        amountNaira: dto.amount,
      });

      if (result.status === "delivered") {
        await this.handleBillSuccess(
          userId,
          txn.id,
          billTxn.id,
          result,
          dto.amount,
          "AIRTIME",
        );
        await this.wallet.sendNotification(
          userId,
          "✅ Airtime Sent",
          `₦${dto.amount.toLocaleString()} airtime sent to ${dto.phone} via ${biller.short_name}`,
          "SUCCESS",
          "BILL",
        );
        return {
          status: "SUCCESS",
          reference,
          phone: dto.phone,
          amount: dto.amount,
          walletSnapshot,
        };
      }

      // VTPass returned failed
      await this.handleBillFailed(
        userId,
        txn.id,
        billTxn.id,
        dto.amount,
        dto.phone,
      );
      throw new BadRequestException({
        code: "BILL_FAILED",
        message: "Airtime purchase failed. Your wallet has been refunded.",
      });
    } catch (err: any) {
      // Network/timeout error — refund and rethrow
      if (err?.code !== "BILL_FAILED") {
        await this.refundOnError(
          userId,
          txn.id,
          billTxn.id,
          dto.amount,
          `${biller.short_name} Airtime failed`,
        );
        this.logger.error(`Airtime VTPass error: ${err.message}`);
      }
      throw err;
    }
  }

  // ── Purchase: Data Bundle ─────────────────────────────────────

  async buyData(userId: string, dto: BuyDataDto) {
    const biller = await this.getBillerOrThrow(dto.billerId, "DATA");
    const reference = generateRef("DAT");

    const walletSnapshot = await this.wallet.debitWallet(
      userId,
      dto.amount,
      `${biller.name}: ${dto.productId} → ${dto.phone}`,
    );

    const txn = await this.createTransaction(
      userId,
      reference,
      "BILL_DATA",
      dto.amount,
    );
    const billTxn = await this.createBillTransaction({
      userId,
      transactionId: txn.id,
      billerId: dto.billerId,
      categoryCode: "DATA",
      customerPhone: dto.phone,
      amount: dto.amount,
      productCode: dto.productId,
      productName: dto.productName,
    });

    try {
      const result = await this.vtpass.buyData({
        serviceId: biller.vtpass_code,
        phone: dto.phone,
        variationCode: dto.productId,
        amountNaira: dto.amount,
      });

      if (result.status === "delivered") {
        await this.handleBillSuccess(
          userId,
          txn.id,
          billTxn.id,
          result,
          dto.amount,
          "DATA",
        );
        await this.wallet.sendNotification(
          userId,
          "✅ Data Activated",
          `${dto.productName} activated on ${dto.phone} via ${biller.short_name}`,
          "SUCCESS",
          "BILL",
        );
        return {
          status: "SUCCESS",
          reference,
          phone: dto.phone,
          product: dto.productName,
          amount: dto.amount,
          walletSnapshot,
        };
      }

      await this.handleBillFailed(
        userId,
        txn.id,
        billTxn.id,
        dto.amount,
        dto.phone,
      );
      throw new BadRequestException({
        code: "BILL_FAILED",
        message: "Data purchase failed. Your wallet has been refunded.",
      });
    } catch (err: any) {
      if (err?.code !== "BILL_FAILED") {
        await this.refundOnError(
          userId,
          txn.id,
          billTxn.id,
          dto.amount,
          `${biller.short_name} Data failed`,
        );
      }
      throw err;
    }
  }

  // ── Transaction history ───────────────────────────────────────

  async getMyBillHistory(
    userId: string,
    query: PaginationDto & { categoryCode?: string },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    let q = this.supabase.admin
      .from("bill_transactions")
      .select(
        "id, category_code, customer_phone, meter_number, decoder_number, amount, product_name, vtpass_token, vtpass_units, status, created_at, billers(name, short_name, logo_url)",
        { count: "exact" },
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (query.categoryCode) q = q.eq("category_code", query.categoryCode);

    const { data, count } = await q;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  

  // ── Private helpers ───────────────────────────────────────────

  private async getAndSetBillerCache() {
    const cached = this.billersCache.get("all");
    if (cached) return cached;

    const { data, error } = await this.supabase.admin
      .from("billers")
      .select(
        "id, vtpass_code, name, short_name, category_code, logo_url, supports_verify",
      )
      .eq("is_active", true)
      .order("display_order");

    if (error || !data) {
      throw new InternalServerErrorException(
        "Failed to load biller configuration",
      );
    }
    this.billersCache.set("all", data); // Cache all billers for quick access during purchase flow
    return data;
  }

  private async getBillerOrThrow(billerId: string, expectedCategory?: string) {
    const q = await this.getAndSetBillerCache(); // Ensure cache is loaded

    const biller = q.find((b) => b.id === billerId);

    if (!biller)
      throw new NotFoundException({
        code: "BILLER_NOT_FOUND",
        message: "Biller not found or inactive",
      });

    if (expectedCategory && biller.category_code !== expectedCategory) {
      throw new BadRequestException({
        code: "WRONG_CATEGORY",
        message: `Expected ${expectedCategory} biller`,
      });
    }
    return biller;
  }

  private async createTransaction(
    userId: string,
    reference: string,
    type: string,
    amount: number,
  ) {
    const { data, error } = await this.supabase.admin
      .from("transactions")
      .insert({
        user_id: userId,
        reference,
        transaction_type: type,
        amount,
        payment_method: "WALLET",
        status: "PENDING",
      })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data!;
  }

  private async createBillTransaction(params: {
    userId: string;
    transactionId: string;
    billerId: string;
    categoryCode: string;
    amount: number;
    customerPhone?: string;
    productCode?: string;
    productName?: string;
  }) {
    const { data, error } = await this.supabase.admin
      .from("bill_transactions")
      .insert({
        user_id: params.userId,
        transaction_id: params.transactionId,
        biller_id: params.billerId,
        category_code: params.categoryCode,
        customer_phone: params.customerPhone ?? null,
        amount: params.amount,
        product_code: params.productCode ?? null,
        product_name: params.productName ?? null,
        status: "PENDING",
      })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data!;
  }

  private async handleBillSuccess(
    userId: string,
    txnId: string,
    billTxnId: string,
    vtpassResult: any,
    amount: number,
    categoryCode: string,
  ) {
    const marginRate = vtpassResult.commission_rate ?? 0.02; // default 2% margin
    const vendorCost = amount * (1 - marginRate);

    await Promise.all([
      this.supabase.admin
        .from("transactions")
        .update({ status: "COMPLETED", completed_at: new Date().toISOString() })
        .eq("id", txnId),

      this.supabase.admin
        .from("bill_transactions")
        .update({
          status: "SUCCESS",
          vtpass_request_id: vtpassResult.reference,
          vtpass_ref: vtpassResult.reference,
          vtpass_status: vtpassResult.status,
          vtpass_quantity: vtpassResult.quantity,
          // vtpass_response: vtpassResult.raw,
          updated_at: new Date().toISOString(),
        })
        .eq("id", billTxnId),

      this.revenue.record({
        transactionId: txnId,
        userId,
        revenueType: "BILLS_MARGIN",
        grossAmount: amount,
        costAmount: vendorCost,
        notes: `${categoryCode} bill — ${vtpassResult.commission_rate * 100}% margin`,
      }),
    ]);
  }

  private async handleBillFailed(
    userId: string,
    txnId: string,
    billTxnId: string,
    amount: number,
    recipient: string,
  ) {
    await Promise.all([
      // Refund wallet
      this.wallet.creditWallet(
        userId,
        amount,
        `Refund: Bill failed for ${recipient}`,
      ),

      this.supabase.admin
        .from("transactions")
        .update({ status: "FAILED" })
        .eq("id", txnId),

      this.supabase.admin
        .from("bill_transactions")
        .update({
          status: "FAILED",
          failure_reason: "VTPass returned failure",
          updated_at: new Date().toISOString(),
        })
        .eq("id", billTxnId),
    ]);

    await this.wallet.sendNotification(
      userId,
      "❌ Bill Payment Failed",
      `Payment failed for ${recipient}. ₦${amount.toLocaleString()} has been refunded to your wallet.`,
      "ERROR",
      "BILL",
    );
  }

  private async refundOnError(
    userId: string,
    txnId: string,
    billTxnId: string,
    amount: number,
    reason: string,
  ) {
    await this.wallet.creditWallet(userId, amount, `Refund: ${reason}`);
    await this.supabase.admin
      .from("transactions")
      .update({ status: "FAILED" })
      .eq("id", txnId);
    await this.supabase.admin
      .from("bill_transactions")
      .update({
        status: "FAILED",
        failure_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", billTxnId);
    await this.wallet.sendNotification(
      userId,
      "❌ Bill Payment Failed",
      `${reason}. ₦${amount.toLocaleString()} has been refunded to your wallet.`,
      "ERROR",
      "BILL",
    );
  }
}
