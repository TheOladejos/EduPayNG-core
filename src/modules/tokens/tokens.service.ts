import {
  Injectable, NotFoundException, BadRequestException, InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { RevenueService } from '../../common/services/revenue.service';
import { PurchaseTokensDto, ValidateTokenDto, TokenPaymentMethod } from './tokens.dto';
import { paginate, PaginationDto } from '../../common/dto/pagination.dto';
import { generateRef, generateTokenCode, generateSerialNumber } from '../../common/helpers/generators';

@Injectable()
export class TokensService {
  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
    private revenue: RevenueService,
    private config: ConfigService,
  ) {}

  async getInstitutions() {
    const { data, error } = await this.supabase.admin
      .from('institutions')
      .select('id, code, name, short_name, token_price, logo_url, description')
      .eq('is_active', true)
      .order('display_order');

    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []).map(i => ({
      id: i.id, code: i.code, name: i.name, shortName: i.short_name,
      tokenPrice: i.token_price, logoUrl: i.logo_url, description: i.description,
    }));
  }

  async purchase(userId: string, dto: PurchaseTokensDto) {
    const { data: institution } = await this.supabase.admin
      .from('institutions').select('*').eq('id', dto.institutionId).eq('is_active', true).single();

    if (!institution) throw new NotFoundException({ code: 'INSTITUTION_NOT_FOUND', message: 'Institution not found' });

    const totalAmount = institution.token_price * dto.quantity;
    const reference = generateRef('TP');

    if (dto.paymentMethod === TokenPaymentMethod.WALLET) {
      await this.wallet.debitWallet(userId, totalAmount, `${institution.short_name} Token x${dto.quantity}`);

      const tokenInserts = Array.from({ length: dto.quantity }, () => ({
        user_id: userId,
        institution_id: dto.institutionId,
        token_code: generateTokenCode(institution.code),
        serial_number: generateSerialNumber(),
        status: 'ACTIVE',
        purchased_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }));

      const { data: tokens, error } = await this.supabase.admin
        .from('tokens').insert(tokenInserts).select('id, token_code, serial_number, expires_at');

      if (error) throw new InternalServerErrorException({ code: 'TOKEN_GENERATION_FAILED', message: 'Failed to generate tokens' });

      const { data: txn } = await this.supabase.admin.from('transactions').insert({
        user_id: userId, reference, transaction_type: 'TOKEN_PURCHASE',
        amount: totalAmount, payment_method: 'WALLET', status: 'COMPLETED',
        completed_at: new Date().toISOString(),
        metadata: { institutionId: dto.institutionId, quantity: dto.quantity, deliveryMethod: dto.deliveryMethod },
      }).select().single();

      // ── Record revenue: margin = selling price - vendor cost ──
      // institution.vendor_cost is set per institution in the DB
      const vendorCost = (institution.vendor_cost ?? 0) * dto.quantity;
      await this.revenue.record({
        transactionId: txn?.id,
        userId,
        revenueType:  'TOKEN_MARGIN',
        grossAmount:  totalAmount,
        costAmount:   vendorCost,
        notes: `${institution.short_name} x${dto.quantity}`,
      });

      // Queue deliveries
      if (tokens) {
        await this.supabase.admin.from('token_deliveries').insert(
          tokens.map(t => ({ token_id: t.id, user_id: userId, delivery_method: dto.deliveryMethod, status: 'PENDING' }))
        );
      }

      await this.wallet.sendNotification(userId, 'Token Purchase Successful',
        `Your ${dto.quantity} ${institution.short_name} token(s) are ready. Check your email/SMS.`, 'SUCCESS', 'TRANSACTION');

      return {
        transactionId: txn?.id, reference, status: 'COMPLETED', amount: totalAmount,
        tokens: (tokens ?? []).map(t => ({
          id: t.id, tokenCode: t.token_code, serialNumber: t.serial_number,
          institution: institution.short_name, expiresAt: t.expires_at,
        })),
      };
    }

    // External payment
    const { data: txn } = await this.supabase.admin.from('transactions').insert({
      user_id: userId, reference, transaction_type: 'TOKEN_PURCHASE',
      amount: totalAmount, payment_method: dto.paymentMethod, status: 'PENDING',
      metadata: { institutionId: dto.institutionId, quantity: dto.quantity, deliveryMethod: dto.deliveryMethod },
    }).select().single();

    const payment = await this.initializeRemita({ amount: totalAmount, reference, userId,
      callbackUrl: `${this.config.get('APP_URL')}/tokens/callback`,
      description: `EduPayNG - ${institution.name} Token x${dto.quantity}` });

    return { transactionId: txn?.id, reference, paymentUrl: payment.paymentUrl, amount: totalAmount, quantity: dto.quantity };
  }

  async getMyTokens(userId: string, query: PaginationDto & { status?: string; institutionId?: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    let q = this.supabase.admin
      .from('tokens')
      .select('*, institutions(id, code, short_name, name, logo_url)', { count: 'exact' })
      .eq('user_id', userId)
      .order('purchased_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (query.status) q = q.eq('status', query.status);
    if (query.institutionId) q = q.eq('institution_id', query.institutionId);

    const { data, error, count } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    const items = (data ?? []).map(t => ({
      id: t.id, tokenCode: t.token_code, serialNumber: t.serial_number, status: t.status,
      institution: { id: t.institutions.id, code: t.institutions.code, name: t.institutions.name, shortName: t.institutions.short_name, logoUrl: t.institutions.logo_url },
      purchasedAt: t.purchased_at, expiresAt: t.expires_at, usedAt: t.used_at ?? null,
    }));

    return paginate(items, count ?? 0, page, limit);
  }

  async validate(userId: string, dto: ValidateTokenDto) {
    const { data: token, error } = await this.supabase.admin
      .from('tokens')
      .select('*, institutions(code, name, short_name)')
      .eq('token_code', dto.tokenCode)
      .eq('serial_number', dto.serialNumber)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !token) throw new NotFoundException({ code: 'TOKEN_NOT_FOUND', message: 'Token not found or does not belong to you' });
    if (token.status === 'USED') throw new BadRequestException({ code: 'TOKEN_USED', message: 'This token has already been used' });
    if (token.status === 'EXPIRED' || new Date(token.expires_at) < new Date()) {
      await this.supabase.admin.from('tokens').update({ status: 'EXPIRED' }).eq('id', token.id);
      throw new BadRequestException({ code: 'TOKEN_EXPIRED', message: 'This token has expired' });
    }

    await this.supabase.admin.from('tokens')
      .update({ status: 'USED', used_at: new Date().toISOString() }).eq('id', token.id);

    await this.supabase.admin.from('token_validations').insert({
      token_id: token.id, user_id: userId, validated_at: new Date().toISOString(), exam_number: dto.examNumber ?? null,
    });

    return { valid: true, tokenId: token.id, institution: token.institutions.short_name, message: 'Token validated successfully.' };
  }

  private async initializeRemita(params: any) {
    try {
      const apiKey = this.config.get('REMITA_API_KEY');
      const merchantId = this.config.get('REMITA_MERCHANT_ID');
      const baseUrl = this.config.get('REMITA_BASE_URL', 'https://api.remita.net');
      const { data } = await axios.post(`${baseUrl}/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit`,
        { serviceTypeId: this.config.get('REMITA_SERVICE_TYPE_ID'), amount: params.amount, orderId: params.reference, description: params.description, responseurl: params.callbackUrl },
        { headers: { Authorization: `remitaConsumerKey=${merchantId},remitaConsumerToken=${apiKey}` } });
      return { paymentUrl: `${baseUrl}/remita/ecomm/finalize.reg?merchantId=${merchantId}&hash=${data.RRR}`, paymentReference: data.RRR };
    } catch {
      return { paymentUrl: `https://remita.net/pay/${params.reference}`, paymentReference: params.reference };
    }
  }
}