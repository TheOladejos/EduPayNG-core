import {
  Injectable, NotFoundException, BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { FundWalletDto, PurchasePointsDto, PaymentMethod } from './wallet.dto';
import { paginate, PaginationDto } from '../../common/dto/pagination.dto';
import { generateRef } from '../../common/helpers/generators';

@Injectable()
export class WalletService {
  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
  ) {}

  async getWallet(userId: string) {
    const { data, error } = await this.supabase.admin
      .from('wallets')
      .select('id, balance, points, total_funded, total_spent, is_active, updated_at')
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });

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
    const reference = generateRef('WF');

    const { data: txn, error } = await this.supabase.admin
      .from('transactions')
      .insert({
        user_id: userId,
        reference,
        transaction_type: 'WALLET_FUNDING',
        amount: dto.amount,
        payment_method: dto.paymentMethod,
        status: 'PENDING',
      })
      .select()
      .single();

    if (error) throw new InternalServerErrorException({ code: 'TXN_FAILED', message: error.message });

    const payment = await this.initializeRemita({
      amount: dto.amount,
      reference,
      userId,
      callbackUrl: dto.callbackUrl ?? `${this.config.get('APP_URL')}/wallet/fund/callback`,
      description: `EduPayNG Wallet Funding - ${reference}`,
    });

    return {
      transactionId: txn.id,
      reference,
      paymentUrl: payment.paymentUrl,
      paymentReference: payment.paymentReference,
      amount: dto.amount,
    };
  }

  async getTransactions(userId: string, query: PaginationDto & { type?: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const { data: wallet } = await this.supabase.admin
      .from('wallets').select('id').eq('user_id', userId).single();
    if (!wallet) throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' });

    let q = this.supabase.admin
      .from('wallet_transactions')
      .select('*', { count: 'exact' })
      .eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (query.type) q = q.eq('type', query.type);

    const { data, error, count } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    const items = (data ?? []).map(t => ({
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
      .from('point_packages')
      .select('id, name, amount, points, bonus_percentage, description')
      .eq('is_active', true)
      .order('display_order');

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []).map(p => ({
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
      .from('point_packages')
      .select('*')
      .eq('id', dto.packageId)
      .eq('is_active', true)
      .single();

    if (!pkg) throw new NotFoundException({ code: 'PACKAGE_NOT_FOUND', message: 'Point package not found' });

    const reference = generateRef('PP');
    const totalPoints = Math.floor(pkg.points * (1 + (pkg.bonus_percentage ?? 0) / 100));

    if (dto.paymentMethod === PaymentMethod.WALLET) {
      await this.debitWallet(userId, pkg.amount, `Points purchase - ${pkg.name}`);

      // Credit points
      const { data: wallet } = await this.supabase.admin
        .from('wallets').select('points').eq('user_id', userId).single();
      await this.supabase.admin
        .from('wallets').update({ points: (wallet?.points ?? 0) + totalPoints }).eq('user_id', userId);

      await this.supabase.admin.from('transactions').insert({
        user_id: userId, reference, transaction_type: 'POINT_PURCHASE',
        amount: pkg.amount, payment_method: 'WALLET', status: 'COMPLETED',
        completed_at: new Date().toISOString(),
        metadata: { packageId: pkg.id, pointsAwarded: totalPoints },
      });

      await this.sendNotification(userId, 'Points Purchased', `${totalPoints.toLocaleString()} points added to your account.`, 'SUCCESS', 'TRANSACTION');

      return { reference, pointsAwarded: totalPoints, status: 'COMPLETED' };
    }

    // External payment
    const { data: txn } = await this.supabase.admin.from('transactions')
      .insert({ user_id: userId, reference, transaction_type: 'POINT_PURCHASE', amount: pkg.amount, payment_method: dto.paymentMethod, status: 'PENDING', metadata: { packageId: pkg.id, pointsAwarded: totalPoints } })
      .select().single();

    const payment = await this.initializeRemita({
      amount: pkg.amount, reference, userId,
      callbackUrl: `${this.config.get('APP_URL')}/wallet/points/callback`,
      description: `EduPayNG Points - ${pkg.name}`,
    });

    return { transactionId: txn?.id, reference, paymentUrl: payment.paymentUrl, amount: pkg.amount, pointsToReceive: totalPoints };
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  async debitWallet(userId: string, amount: number, description: string) {
    const { data: wallet } = await this.supabase.admin
      .from('wallets')
      .select('id, balance, points, total_funded, total_spent')
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (!wallet) throw new NotFoundException('Wallet not found');
    if (wallet.balance < amount) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Insufficient wallet balance',
        currentBalance: wallet.balance,
        required: amount,
        shortfall: amount - wallet.balance,
      });
    }

    const balanceBefore = wallet.balance;
    const balanceAfter  = balanceBefore - amount;
    const newTotalSpent = Number(wallet.total_spent) + amount;

    await this.supabase.admin.from('wallets')
      .update({ balance: balanceAfter, total_spent: newTotalSpent })
      .eq('id', wallet.id);

    await this.supabase.admin.from('wallet_transactions').insert({
      wallet_id:      wallet.id,
      user_id:        userId,
      type:           'DEBIT',
      amount,
      balance_before: balanceBefore,
      balance_after:  balanceAfter,
      description,
    });

    // Return a full wallet snapshot so callers can propagate to the frontend
    return {
      walletId:       wallet.id,
      balanceBefore,
      balanceAfter,
      deducted:       amount,
      points:         wallet.points,
      totalFunded:    wallet.total_funded,
      totalSpent:     newTotalSpent,
    };
  }

  async creditWallet(userId: string, amount: number, description: string) {
    const { data: wallet } = await this.supabase.admin
      .from('wallets').select('id, balance').eq('user_id', userId).single();
    if (!wallet) throw new NotFoundException('Wallet not found');

    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore + amount;

    await this.supabase.admin.from('wallets')
      .update({ balance: balanceAfter, total_funded: this.supabase.admin.rpc('increment', { x: amount }) })
      .eq('id', wallet.id);

    await this.supabase.admin.from('wallet_transactions').insert({
      wallet_id: wallet.id, user_id: userId, type: 'CREDIT',
      amount, balance_before: balanceBefore, balance_after: balanceAfter, description,
    });

    return { balanceBefore, balanceAfter };
  }

  async sendNotification(userId: string, title: string, message: string, type: string, category: string, metadata?: object) {
    await this.supabase.admin.from('notifications').insert({
      user_id: userId, title, message, type, category, metadata: metadata ?? {}, is_read: false,
    });
  }

  private async initializeRemita(params: { amount: number; reference: string; userId: string; callbackUrl: string; description: string; }) {
    try {
      const apiKey = this.config.get('REMITA_API_KEY');
      const merchantId = this.config.get('REMITA_MERCHANT_ID');
      const baseUrl = this.config.get('REMITA_BASE_URL', 'https://api.remita.net');

      const { data } = await axios.post(
        `${baseUrl}/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit`,
        {
          serviceTypeId: this.config.get('REMITA_SERVICE_TYPE_ID'),
          amount: params.amount,
          orderId: params.reference,
          description: params.description,
          responseurl: params.callbackUrl,
        },
        { headers: { Authorization: `remitaConsumerKey=${merchantId},remitaConsumerToken=${apiKey}`, 'Content-Type': 'application/json' } },
      );

      return {
        paymentUrl: `${baseUrl}/remita/ecomm/finalize.reg?merchantId=${merchantId}&hash=${data.RRR}`,
        paymentReference: data.RRR,
      };
    } catch {
      // Graceful fallback in dev
      return { paymentUrl: `https://remita.net/pay/${params.reference}`, paymentReference: params.reference };
    }
  }
}