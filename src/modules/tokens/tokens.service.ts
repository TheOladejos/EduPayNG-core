import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SupabaseService } from "../../common/supabase/supabase.service";
import { WalletService } from "../wallet/wallet.service";
import { RevenueService } from "../../common/services/revenue.service";
import {
  PurchaseTokensDto,
  ValidateTokenDto,
  TokenPaymentMethod,
} from "./tokens.dto";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";
import { generateRef } from "../../common/helpers/generators";
import { RemitaService } from "@modules/payments/gateway/remita.gateway";
import { VtpassService } from "@modules/payments/gateway/vtPass.gateway";
import { PaystackService } from "@modules/payments/gateway/paystack.gateway";

const VTPASS_GATEWAY = "VTPASS";
const REMITA_GATEWAY = "REMITA";

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
    private revenue: RevenueService,
    private remita: RemitaService,
    private vtpass: VtpassService,
    private paystack: PaystackService,
    private config: ConfigService,
  ) {}

  async getInstitutions() {
    const { data, error } = await this.supabase.admin
      .from("institutions")
      .select(
        "id,code, name, token_price, logo_url, description"
        // "id, code, name, short_name, token_price, logo_url, description, gateway",
      )
      .eq("is_active", true)
      .order("display_order");

    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []).map((i) => ({
      id: i.id,
      // code: i.code,
      name: i.name,
      shortName: i.code,
      tokenPrice: i.token_price,
      logoUrl: i.logo_url,
      description: i.description,
      // gateway: i.gateway,
    }));
  }

  async purchase(userId: string, dto: PurchaseTokensDto) {
    
    const { data: institution } = await this.supabase.admin
      .from("institutions")
      .select("*")
      .eq("id", dto.institutionId)
      .eq("is_active", true)
      .single();

    if (!institution)
      throw new NotFoundException({
        code: "INSTITUTION_NOT_FOUND",
        message: "Institution not found",
      });
    const gateway =
      institution.code === "WAEC" || institution.code === "JAMB"
        ? VTPASS_GATEWAY
        : REMITA_GATEWAY;
    const vendorCost  = (institution.vendor_cost ?? 0) * dto.quantity;
    const totalAmount = institution.token_price * dto.quantity;
    const reference = generateRef("TP");

    // ═══════════════════════════════════════════════════════════
    // PATH 1: FULL WALLET PAYMENT
    // User has enough balance — instant, no gateway redirect
    // ═══════════════════════════════════════════════════════════
    if (dto.paymentMethod === TokenPaymentMethod.WALLET) {
      await this.checkVendorBalance(
        gateway,
        vendorCost,
        institution.code,
      );

      const walletSnapshot = await this.wallet.debitWallet(
        userId,
        totalAmount,
        `${institution.code} Token x${dto.quantity}`,
      );

      const { data: txn } = await this.supabase.admin
        .from("transactions")
        .insert({
          user_id: userId,
          reference,
          transaction_type: "TOKEN_PURCHASE",
          amount: totalAmount,
          payment_method: "WALLET",
          status: "PENDING",
          metadata: {
            institutionId: dto.institutionId,
            institutionCode: institution.code,
            gateway,
            quantity: dto.quantity,
            deliveryMethod: dto.deliveryMethod,
          },
        })
        .select()
        .single();

      return this.fulfillTokens({
        userId,
        txnId: txn!.id,
        reference,
        gateway,
        vendorCost,
        institution,
        quantity: dto.quantity,
        deliveryMethod: dto.deliveryMethod,
        totalAmount,
        walletSnapshot,
        paymentSource: "WALLET",
      });
    }

    // ═══════════════════════════════════════════════════════════
    // PATH 2: HYBRID PAYMENT (partial wallet + partial Paystack)
    // User has some balance but not enough — top up the difference
    // ═══════════════════════════════════════════════════════════
    if (dto.paymentMethod === TokenPaymentMethod.HYBRID) {
      const walletAmount = dto.walletAmount!; 
      const cardAmount = dto.cardAmount!;

      // Validate amounts add up
      if (Math.abs(walletAmount + cardAmount - totalAmount) > 1) {
        throw new BadRequestException({
          code: "INVALID_HYBRID_AMOUNTS",
          message: `walletAmount (₦${walletAmount}) + cardAmount (₦${cardAmount}) must equal total (₦${totalAmount})`,
        });
      }

      // Validate wallet has the wallet portion
      const { data: walletRow } = await this.supabase.admin
        .from("wallets")
        .select("id, balance")
        .eq("user_id", userId)
        .eq("is_active", true)
        .single();
      if (!walletRow || walletRow.balance < walletAmount) {
        throw new BadRequestException({
          code: "INSUFFICIENT_BALANCE",
          message: `Wallet balance ₦${walletRow?.balance ?? 0} is less than the wallet portion ₦${walletAmount}`,
          currentBalance: walletRow?.balance ?? 0,
          required: walletAmount,
        });
      }

      await this.checkVendorBalance(
        gateway,
        totalAmount,
        institution.code,
      );

      // Fetch user email for Paystack
      const { data: authUser } =
        await this.supabase.admin.auth.admin.getUserById(userId);
      const email = authUser?.user?.email;
      if (!email)
        throw new BadRequestException({
          code: "USER_NOT_FOUND",
          message: "User not found",
        });

      // Create main transaction record (full amount)
      const { data: txn } = await this.supabase.admin
        .from("transactions")
        .insert({
          user_id: userId,
          reference,
          transaction_type: "TOKEN_PURCHASE",
          amount: totalAmount,
          payment_method: "HYBRID",
          status: "PENDING",
          metadata: {
            institutionId: dto.institutionId,
            institutionCode: institution.code,
            gateway,
            quantity: dto.quantity,
            deliveryMethod: dto.deliveryMethod,
            walletAmount,
            cardAmount,
            paymentMethod: "HYBRID",
          },
        })
        .select()
        .single();

      // Place a HOLD on the wallet portion (reserve it, don't deduct yet)
      // Deduction happens only after Paystack confirms the card portion
      const holdBalance = walletRow.balance - walletAmount; // what user can still spend
      await this.supabase.admin
        .from("wallets")
        .update({ balance: holdBalance })
        .eq("id", walletRow.id);
      await this.supabase.admin.from("wallet_holds").insert({
        user_id: userId,
        wallet_id: walletRow.id,
        transaction_ref: reference,
        hold_amount: walletAmount,
        card_amount: cardAmount,
        total_amount: totalAmount,
        status: "HOLDING",
        metadata: {
          institutionId: dto.institutionId,
          institutionCode: institution.code,
          gateway,
          quantity: dto.quantity,
          deliveryMethod: dto.deliveryMethod,
          txnId: txn!.id,
        },
      });

      // Log the wallet reservation as a "hold" wallet transaction for transparency
      await this.supabase.admin.from("wallet_transactions").insert({
        wallet_id: walletRow.id,
        user_id: userId,
        type: "HOLD",
        amount: walletAmount,
        balance_before: walletRow.balance,
        balance_after: holdBalance,
        description: `Hold for ${institution.short_name} token — awaiting card payment of ₦${cardAmount}`,
      });

      // Initialize Paystack for the card portion ONLY
      const paystackRef = generateRef("HC"); // HC = Hybrid Card
      const payment = await this.paystack.initialize({
        email,
        amountNaira: cardAmount,
        reference: paystackRef,
        callbackUrl: `${this.config.get("APP_URL")}/tokens/callback`,
        metadata: {
          userId,
          type: "HYBRID_TOKEN_PURCHASE",
          mainRef: reference, // links back to the main token transaction
          walletAmount,
          cardAmount,
          institutionId: dto.institutionId,
          institutionCode: institution.code,
          gateway,
          quantity: dto.quantity,
          deliveryMethod: dto.deliveryMethod,
        },
      });

      // Store Paystack reference in the hold record
      await this.supabase.admin
        .from("wallet_holds")
        .update({ paystack_ref: paystackRef })
        .eq("transaction_ref", reference);

      this.logger.log(
        `Hybrid payment initiated: ₦${walletAmount} held + ₦${cardAmount} via Paystack (${paystackRef})`,
      );

      return {
        transactionId: txn!.id,
        reference,
        paystackReference: paystackRef,
        authorizationUrl: payment.authorizationUrl,
        accessCode: payment.accessCode,
        paymentType: "HYBRID",
        walletAmount,
        cardAmount,
        totalAmount,
        institution: institution.code,
        message: `₦${walletAmount.toLocaleString()} reserved from wallet. Please complete ₦${cardAmount.toLocaleString()} via Paystack.`,
      };
    }

    // ═══════════════════════════════════════════════════════════
    // PATH 3: FULL PAYSTACK PAYMENT (CARD / BANK_TRANSFER / USSD)
    // All external payments go through Paystack.
    // After Paystack confirms, webhook calls purchaseToken via correct gateway.
    // ═══════════════════════════════════════════════════════════
    const { data: authUser } =
      await this.supabase.admin.auth.admin.getUserById(userId);
    const email = authUser?.user?.email;
    if (!email)
      throw new BadRequestException({
        code: "USER_NOT_FOUND",
        message: "User not found",
      });

    const { data: txn } = await this.supabase.admin
      .from("transactions")
      .insert({
        user_id: userId,
        reference,
        transaction_type: "TOKEN_PURCHASE",
        amount: totalAmount,
        payment_method: dto.paymentMethod,
        status: "PENDING",
        metadata: {
          institutionId: dto.institutionId,
          institutionCode: institution.code,
          gateway,
          quantity: dto.quantity,
          deliveryMethod: dto.deliveryMethod,
          paymentMethod: "PAYSTACK",
        },
      })
      .select()
      .single();

    const payment = await this.paystack.initialize({
      email,
      amountNaira: totalAmount,
      reference,
      callbackUrl: `${this.config.get("APP_URL")}/tokens/callback`,
      metadata: {
        userId,
        type: "TOKEN_PURCHASE",
        institutionId: dto.institutionId,
        institutionCode: institution.code,
        gateway,
        vendorCost,
        quantity: dto.quantity,
        deliveryMethod: dto.deliveryMethod,
      },
    });

    return {
      transactionId: txn!.id,
      reference,
      authorizationUrl: payment.authorizationUrl,
      accessCode: payment.accessCode,
      amount: totalAmount,
      quantity: dto.quantity,
      gateway: "PAYSTACK",
      institution: institution.code,
    };
  }

  // ── Called after payment confirmed — purchases real tokens ──────

  async fulfillTokens(params: {
    userId: string;
    txnId: string;
    reference: string;
    gateway: string;
    institution: any;
    quantity: number;
    deliveryMethod: string;
    totalAmount: number;
    vendorCost: number;
    walletSnapshot?: any;
    paymentSource: "WALLET" | "PAYSTACK" | "HYBRID";
  }) {
    const {
      userId,
      txnId,
      reference,
      gateway,
      institution,
      quantity,
      deliveryMethod,
      totalAmount,
      vendorCost,
      walletSnapshot,
      paymentSource,
    } = params;

    let purchasedTokens: any;

    try {
      if (gateway === VTPASS_GATEWAY) {
        const userPhone = await this.getUserPhone(userId);
        purchasedTokens = await this.vtpass.purchaseToken({
          serviceId: institution.code.toLowerCase(),
          quantity,
          reference,
          phone: userPhone, 
          amountName: institution.vendor_cost,
          variationCode: institution.vtpass_code,
          institutionName: institution.name
        });
      } else {
        purchasedTokens = await this.remita.purchaseToken({
          institutionCode: institution.code,
          quantity,
          reference,
        });
      }
    } catch (err: any) {
      this.logger.error(
        `${gateway} purchaseToken failed for ${reference}: ${err.message}`,
      );

      // Refund based on payment source
      if (paymentSource === "WALLET") {
        await this.wallet.creditWallet(
          userId,
          totalAmount,
          `Refund: ${institution.code} token purchase failed`,
        );
      }
      // For PAYSTACK and HYBRID: the Paystack amount is non-refundable automatically.
      // Admin must manually refund via Paystack dashboard. Wallet hold was already released.

      await this.supabase.admin
        .from("transactions")
        .update({ status: "FAILED" })
        .eq("id", txnId);
      await this.wallet.sendNotification(
        userId,
        "❌ Token Purchase Failed",
        `${institution.code} token purchase failed. ${paymentSource === "WALLET" ? `₦${totalAmount.toLocaleString()} has been refunded to your wallet.` : "Please contact support with reference: " + reference}`,
        "ERROR",
        "TRANSACTION",
      );

      if (paymentSource === "WALLET") {
        throw new ServiceUnavailableException({
          code: "TOKEN_PURCHASE_FAILED",
          message: `Failed to purchase ${institution.code} token. Wallet has been refunded.`,
        });
      }
      return; // For card payments, don't throw — just log and notify
    }

    const tokenDetails = {
      user_id: userId,
      institution_id: institution.id,
      ref: reference,
      purchased_at: new Date().toISOString(),
    };

    let tokenInserts: any;
    const { cards, token, Pin } = purchasedTokens;
    if (institution.code === "WAEC") {
      token
        ? (tokenInserts = (token ?? [])?.map((card: any) => ({
            ...tokenDetails,
            token_code: card.token,
            serial_number: card.transactionId,
          })))
        : (tokenInserts = cards?.map((card: any) => ({
            ...tokenDetails,
            token_code: card.Pin,
            serial_number: card.serial,
          })));
    }
    if (institution.code === "JAMB") {
      tokenInserts = {
        ...tokenDetails,
        token_code: Pin,
      };
    }

    const { data: tokens, error: tokenErr } = await this.supabase.admin
      .from("tokens")
      .insert(tokenInserts)
      .select("id, token_code, serial_number, expires_at");

    if (tokenErr) {
      this.logger.error(
        `CRITICAL: Tokens purchased via ${gateway} but DB save failed. Ref: ${reference}`,
      );
      // Don't throw for card payments — tokens will be recovered manually
      if (paymentSource === "WALLET") {
        throw new InternalServerErrorException({
          code: "TOKEN_SAVE_FAILED",
          message: `Tokens purchased but failed to save. Contact support with reference: ${reference}`,
        });
      }
      return;
    }

    await Promise.all([
      this.supabase.admin
        .from("transactions")
        .update({ status: "COMPLETED", completed_at: new Date().toISOString() })
        .eq("id", txnId),
      this.revenue.record({
        transactionId: txnId,
        userId,
        revenueType: "TOKEN_MARGIN",
        grossAmount: totalAmount,
        costAmount: vendorCost,
        notes: `${institution.short_name} x${quantity} via ${gateway} (${paymentSource})`,
      }),
      tokens?.length
        ? this.supabase.admin
            .from("token_deliveries")
            .insert(
              tokens.map((t) => ({
                token_id: t.id,
                user_id: userId,
                delivery_method: deliveryMethod,
                status: "PENDING",
              })),
            )
        : Promise.resolve(),
    ]);

    await this.wallet.sendNotification(
      userId,
      "🎫 Token Purchase Successful",
      `Your ${quantity} ${institution.code} - ${institution.short_name} token(s) are ready. Check your email/SMS.`,
      "SUCCESS",
      "TRANSACTION",
    );

    return {
      transactionId: txnId,
      reference,
      status: "COMPLETED",
      amount: totalAmount,
      gateway,
      paymentSource,
      tokens: (tokens ?? []).map((t) => ({
        id: t.id,
        tokenCode: t.token_code,
        institution: institution.code,
        ...(t.serial_number ? {serialNumber: t.serial_number}:{})
      })),
      ...(walletSnapshot
        ? {
            walletSnapshot: {
              balanceBefore: walletSnapshot.balanceBefore,
              balanceAfter: walletSnapshot.balanceAfter,
              deducted: totalAmount,
              newBalance: walletSnapshot.balanceAfter,
              points: walletSnapshot.points,
              totalSpent: walletSnapshot.totalSpent,
            },
          }
        : {}),
    };
  }

  async getMyTokens(
    userId: string,
    query: PaginationDto & { status?: string; institutionId?: string },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    let q = this.supabase.admin
      .from("tokens")
      .select(
        "*, institutions(id, code, short_name, name, logo_url, gateway)",
        { count: "exact" },
      )
      .eq("user_id", userId)
      .order("purchased_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (query.status) q = q.eq("status", query.status);
    if (query.institutionId) q = q.eq("institution_id", query.institutionId);
    const { data, error, count } = await q;
    if (error) throw new InternalServerErrorException(error.message);
    return paginate(
      (data ?? []).map((t) => ({
        id: t.id,
        tokenCode: t.token_code,
        serialNumber: t.serial_number,
        status: t.status,
        institution: {
          id: t.institutions.id,
          code: t.institutions.code,
          name: t.institutions.name,
          shortName: t.institutions.short_name,
          logoUrl: t.institutions.logo_url,
        },
        purchasedAt: t.purchased_at,
        expiresAt: t.expires_at,
        usedAt: t.used_at ?? null,
      })),
      count ?? 0,
      page,
      limit,
    );
  }

  async validate(userId: string, dto: ValidateTokenDto) {
    const { data: token, error } = await this.supabase.admin
      .from("tokens")
      .select("*, institutions(code, name, short_name)")
      .eq("token_code", dto.tokenCode)
      .eq("serial_number", dto.serialNumber)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !token)
      throw new NotFoundException({
        code: "TOKEN_NOT_FOUND",
        message: "Token not found or does not belong to you",
      });
    if (token.status === "USED")
      throw new BadRequestException({
        code: "TOKEN_USED",
        message: "This token has already been used",
      });
    if (token.status === "EXPIRED" || new Date(token.expires_at) < new Date()) {
      await this.supabase.admin
        .from("tokens")
        .update({ status: "EXPIRED" })
        .eq("id", token.id);
      throw new BadRequestException({
        code: "TOKEN_EXPIRED",
        message: "This token has expired",
      });
    }
    await this.supabase.admin
      .from("tokens")
      .update({ status: "USED", used_at: new Date().toISOString() })
      .eq("id", token.id);
    await this.supabase.admin
      .from("token_validations")
      .insert({
        token_id: token.id,
        user_id: userId,
        validated_at: new Date().toISOString(),
        exam_number: dto.examNumber ?? null,
      });
    return {
      valid: true,
      tokenId: token.id,
      institution: token.institutions.short_name,
      message: "Token validated successfully.",
    };
  }

  private async checkVendorBalance(
    gateway: string,
    required: number,
    institutionName: string,
  ) {
    try {
      const available =
        gateway === VTPASS_GATEWAY
          ? (await this.vtpass.checkPrefundBalance()).balance
          : (await this.remita.checkPrefundBalance()).availableBalance;

          console.log(available);
          
      if (available !== -1 && available < required) {
        throw new ServiceUnavailableException({
          code: "SERVICE_TEMPORARILY_UNAVAILABLE",
          message: `${institutionName} token purchase is temporarily unavailable. Please try again later.`,
        });
      }
    } catch (err: any) {
      if (err?.status === 503) throw err;
      this.logger.warn(
        `${gateway} balance check failed — proceeding: ${err.message}`,
      );
    }
  }

  private async getUserPhone(userId: string): Promise<string> {
    const { data } = await this.supabase.admin
      .from("profiles")
      .select("phone")
      .eq("id", userId)
      .single();
    return data?.phone ?? "08000000000";
  }
}
