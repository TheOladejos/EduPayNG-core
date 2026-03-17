import {
  Injectable, NotFoundException, BadRequestException,
  InternalServerErrorException, Logger, ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { RevenueService } from '../../common/services/revenue.service';
import { PurchaseTokensDto, ValidateTokenDto, TokenPaymentMethod } from './tokens.dto';
import { paginate, PaginationDto } from '../../common/dto/pagination.dto';
import { generateRef } from '../../common/helpers/generators';
import { RemitaService } from '@modules/payments/gateway/remita.gateway';
import { VtpassService } from '@modules/payments/gateway/vtPass.gateway';

// Gateway routing per institution:
//   VTPASS  → WAEC, JAMB    (VTPass supports these natively)
//   REMITA  → NECO, NABTEB  (Remita eBillsPay aggregates these)
const VTPASS_GATEWAY  = 'VTPASS';
const REMITA_GATEWAY  = 'REMITA';

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private supabase: SupabaseService,
    private wallet:   WalletService,
    private revenue:  RevenueService,
    private remita:   RemitaService,
    private vtpass:   VtpassService,
    private config:   ConfigService,
  ) {}

  async getInstitutions() {
    const { data, error } = await this.supabase.admin
      .from('institutions')
      .select('id, code, name, short_name, token_price, logo_url, description, gateway')
      .eq('is_active', true)
      .order('display_order');

    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []).map(i => ({
      id: i.id, code: i.code, name: i.name, shortName: i.short_name,
      tokenPrice: i.token_price, logoUrl: i.logo_url, description: i.description,
      gateway: i.gateway,
    }));
  }

  async purchase(userId: string, dto: PurchaseTokensDto) {
    const { data: institution } = await this.supabase.admin
      .from('institutions')
      .select('*')
      .eq('id', dto.institutionId)
      .eq('is_active', true)
      .single();

    if (!institution) throw new NotFoundException({ code: 'INSTITUTION_NOT_FOUND', message: 'Institution not found' });

    const gateway     = institution.gateway ?? REMITA_GATEWAY;
    const totalAmount = institution.token_price * dto.quantity;
    const reference   = generateRef('TP');
    const vendorCost  = (institution.vendor_cost ?? 0) * dto.quantity;

    this.logger.log(`Token purchase: ${institution.code} via ${gateway} — ₦${totalAmount}`);

    // ═══════════════════════════════════════════════════
    // WALLET PAYMENT — debit first, then call gateway
    // ═══════════════════════════════════════════════════
    if (dto.paymentMethod === TokenPaymentMethod.WALLET) {

      // Pre-check vendor balance before debiting user
      await this.checkVendorBalance(gateway, vendorCost, institution.short_name);

      // Debit wallet — throws if insufficient balance
      const walletSnapshot = await this.wallet.debitWallet(
        userId, totalAmount, `${institution.short_name} Token x${dto.quantity}`,
      );

      // Create PENDING transaction
      const { data: txn } = await this.supabase.admin.from('transactions').insert({
        user_id: userId, reference, transaction_type: 'TOKEN_PURCHASE',
        amount: totalAmount, payment_method: 'WALLET', status: 'PENDING',
        metadata: { institutionId: dto.institutionId, institutionCode: institution.code, gateway, quantity: dto.quantity, deliveryMethod: dto.deliveryMethod },
      }).select().single();

      // Call the correct gateway to get real tokens
      let purchasedTokens: Array<{ tokenCode: string; serialNumber: string; expiresAt: string; rawResponse: any }>;

      try {
        if (institution.code === 'WAEC' || institution.code === 'JAMB') {
          // WAEC or JAMB — use VTPass
          const userPhone = await this.getUserPhone(userId);
          purchasedTokens = await this.vtpass.purchaseToken({
            serviceId: institution.vtpass_service_id ?? institution.code.toLowerCase(),
            quantity:  dto.quantity,
            reference,
            phone: userPhone,
            institutionName: institution.short_name,
          });
        } else {
          // NECO or NABTEB — use Remita
          purchasedTokens = await this.remita.purchaseToken({
            institutionCode: institution.code,
            quantity:        dto.quantity,
            reference,
          });
        }
      } catch (err: any) {
        // Gateway failed — refund wallet immediately
        this.logger.error(`${gateway} purchaseToken failed for ${reference}: ${err.message}`);
        await this.wallet.creditWallet(userId, totalAmount, `Refund: ${institution.short_name} token purchase failed`);
        await this.supabase.admin.from('transactions').update({ status: 'FAILED' }).eq('id', txn?.id);
        await this.wallet.sendNotification(userId, '❌ Token Purchase Failed',
          `${institution.short_name} token purchase failed. ₦${totalAmount.toLocaleString()} has been refunded.`,
          'ERROR', 'TRANSACTION');
        throw new ServiceUnavailableException({
          code: 'TOKEN_PURCHASE_FAILED',
          message: `Failed to purchase ${institution.short_name} token. Your wallet has been refunded.`,
        });
      }

      // Save real tokens from gateway into DB
      const tokenInserts = purchasedTokens.map(t => ({
        user_id:        userId,
        institution_id: dto.institutionId,
        token_code:     t.tokenCode,
        serial_number:  t.serialNumber,
        remita_ref:     gateway === REMITA_GATEWAY ? reference : null,
        status:         'ACTIVE',
        purchased_at:   new Date().toISOString(),
        expires_at:     t.expiresAt,
        raw_response:   t.rawResponse,
      }));

      const { data: tokens, error: tokenErr } = await this.supabase.admin
        .from('tokens').insert(tokenInserts).select('id, token_code, serial_number, expires_at');

      if (tokenErr) {
        // Critical: tokens purchased but DB save failed — do NOT refund
        this.logger.error(`CRITICAL: Tokens purchased via ${gateway} but DB save failed. Ref: ${reference}`);
        throw new InternalServerErrorException({
          code: 'TOKEN_SAVE_FAILED',
          message: `Tokens purchased but failed to save. Contact support with reference: ${reference}`,
        });
      }

      // Complete transaction and record revenue
      await Promise.all([
        this.supabase.admin.from('transactions').update({ status: 'COMPLETED', completed_at: new Date().toISOString() }).eq('id', txn?.id),
        this.revenue.record({ transactionId: txn?.id, userId, revenueType: 'TOKEN_MARGIN', grossAmount: totalAmount, costAmount: vendorCost, notes: `${institution.short_name} x${dto.quantity} via ${gateway}` }),
        tokens?.length ? this.supabase.admin.from('token_deliveries').insert(
          tokens.map(t => ({ token_id: t.id, user_id: userId, delivery_method: dto.deliveryMethod, status: 'PENDING' }))
        ) : Promise.resolve(),
      ]);

      await this.wallet.sendNotification(userId, '🎫 Token Purchase Successful',
        `Your ${dto.quantity} ${institution.short_name} token(s) are ready. Check your email/SMS.`,
        'SUCCESS', 'TRANSACTION');

      return {
        transactionId: txn?.id, reference, status: 'COMPLETED', amount: totalAmount,
        gateway,
        tokens: (tokens ?? []).map(t => ({
          id: t.id, tokenCode: t.token_code, serialNumber: t.serial_number,
          institution: institution.short_name, expiresAt: t.expires_at,
        })),
        walletSnapshot: {
          balanceBefore: walletSnapshot.balanceBefore,
          balanceAfter:  walletSnapshot.balanceAfter,
          deducted:      totalAmount,
          newBalance:    walletSnapshot.balanceAfter,
          points:        walletSnapshot.points,
          totalSpent:    walletSnapshot.totalSpent,
        },
      };
    }

    // ═══════════════════════════════════════════════════
    // CARD PAYMENT — always via Remita payment page
    // (Remita is the card payment processor for token orders)
    // After card confirmed: webhook calls processCardTokenPurchase
    // which routes to correct gateway (VTPass or Remita) for real tokens
    // ═══════════════════════════════════════════════════
    const { data: txn } = await this.supabase.admin.from('transactions').insert({
      user_id: userId, reference, transaction_type: 'TOKEN_PURCHASE',
      amount: totalAmount, payment_method: dto.paymentMethod, status: 'PENDING',
      metadata: { institutionId: dto.institutionId, institutionCode: institution.code, gateway, quantity: dto.quantity, deliveryMethod: dto.deliveryMethod },
    }).select().single();

    const payment = await this.remita.initialize({
      amountNaira: totalAmount, reference,
      description: `EduPayNG - ${institution.name} Token x${dto.quantity}`,
      callbackUrl: `${this.config.get('APP_URL')}/tokens/callback`,
    });

    return { transactionId: txn?.id, reference, authorizationUrl: payment.paymentUrl, rrr: payment.rrr, amount: totalAmount, quantity: dto.quantity, gateway: 'REMITA_PAYMENT_PAGE' };
  }

  async getMyTokens(userId: string, query: PaginationDto & { status?: string; institutionId?: string }) {
    const page = query.page ?? 1; const limit = query.limit ?? 20; const offset = (page - 1) * limit;
    let q = this.supabase.admin.from('tokens')
      .select('*, institutions(id, code, short_name, name, logo_url, gateway)', { count: 'exact' })
      .eq('user_id', userId).order('purchased_at', { ascending: false }).range(offset, offset + limit - 1);
    if (query.status)        q = q.eq('status', query.status);
    if (query.institutionId) q = q.eq('institution_id', query.institutionId);
    const { data, error, count } = await q;
    if (error) throw new InternalServerErrorException(error.message);
    return paginate((data ?? []).map(t => ({
      id: t.id, tokenCode: t.token_code, serialNumber: t.serial_number, status: t.status,
      institution: { id: t.institutions.id, code: t.institutions.code, name: t.institutions.name, shortName: t.institutions.short_name, logoUrl: t.institutions.logo_url },
      purchasedAt: t.purchased_at, expiresAt: t.expires_at, usedAt: t.used_at ?? null,
    })), count ?? 0, page, limit);
  }

  async validate(userId: string, dto: ValidateTokenDto) {
    const { data: token, error } = await this.supabase.admin.from('tokens')
      .select('*, institutions(code, name, short_name)').eq('token_code', dto.tokenCode).eq('serial_number', dto.serialNumber).eq('user_id', userId).maybeSingle();
    if (error || !token) throw new NotFoundException({ code: 'TOKEN_NOT_FOUND', message: 'Token not found or does not belong to you' });
    if (token.status === 'USED') throw new BadRequestException({ code: 'TOKEN_USED', message: 'This token has already been used' });
    if (token.status === 'EXPIRED' || new Date(token.expires_at) < new Date()) {
      await this.supabase.admin.from('tokens').update({ status: 'EXPIRED' }).eq('id', token.id);
      throw new BadRequestException({ code: 'TOKEN_EXPIRED', message: 'This token has expired' });
    }
    await this.supabase.admin.from('tokens').update({ status: 'USED', used_at: new Date().toISOString() }).eq('id', token.id);
    await this.supabase.admin.from('token_validations').insert({ token_id: token.id, user_id: userId, validated_at: new Date().toISOString(), exam_number: dto.examNumber ?? null });
    return { valid: true, tokenId: token.id, institution: token.institutions.short_name, message: 'Token validated successfully.' };
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async checkVendorBalance(gateway: string, required: number, institutionName: string) {
    try {
      let available: number;
      if (gateway === VTPASS_GATEWAY) {
        const b = await this.vtpass.checkPrefundBalance();
        available = b.balance;
      } else {
        const b = await this.remita.checkPrefundBalance();
        available = b.availableBalance;
      }
      if (available !== -1 && available < required) {
        this.logger.warn(`${gateway} balance ₦${available} < required ₦${required}`);
        throw new ServiceUnavailableException({
          code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
          message: `${institutionName} token purchase is temporarily unavailable. Please try again later.`,
        });
      }
    } catch (err: any) {
      if (err?.status === 503) throw err; // rethrow our own error
      // Gateway balance check failed — proceed cautiously, don't block user
      this.logger.warn(`${gateway} balance check failed — proceeding: ${err.message}`);
    }
  }

  private async getUserPhone(userId: string): Promise<string> {
    const { data } = await this.supabase.admin.from('profiles').select('phone').eq('id', userId).single();
    return data?.phone ?? '08000000000';
  }
}