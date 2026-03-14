import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { RevenueService } from '../../common/services/revenue.service';
import { generateTokenCode, generateSerialNumber } from '../../common/helpers/generators';
import * as crypto from 'crypto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
    private revenue: RevenueService,
    private config: ConfigService,
  ) {}

  async verifyTransaction(userId: string, transactionReference: string) {
    const { data, error } = await this.supabase.admin
      .from('transactions')
      .select('id, status, amount, payment_method, transaction_type, completed_at, created_at')
      .eq('reference', transactionReference)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' });

    return {
      reference: transactionReference,
      status: data.status,
      amount: data.amount,
      paymentMethod: data.payment_method,
      transactionType: data.transaction_type,
      paidAt: data.completed_at,
      createdAt: data.created_at,
    };
  }

  async handleWebhook(payload: any, signature: string): Promise<void> {
    // Verify signature
    const secret = this.config.get('REMITA_WEBHOOK_SECRET');
    if (secret) {
      const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(payload)).digest('hex');
      if (expected !== signature) {
        this.logger.warn('Invalid webhook signature');
        throw new Error('Invalid signature');
      }
    }

    const { orderId: reference, status, amount } = payload;
    this.logger.log(`Webhook: ${reference} → ${status}`);

    const { data: txn } = await this.supabase.admin
      .from('transactions').select('*').eq('reference', reference).maybeSingle();

    if (!txn) { this.logger.warn(`Transaction not found: ${reference}`); return; }
    if (txn.status !== 'PENDING') { this.logger.log(`Already processed: ${reference}`); return; } // Idempotent

    const isSuccess = status === 'SUCCESS' || status === '00';
    const isFailed = status === 'FAILED' || status === '01';

    if (isSuccess) {
      await this.supabase.admin.from('transactions')
        .update({ status: 'COMPLETED', completed_at: new Date().toISOString() }).eq('id', txn.id);

      switch (txn.transaction_type) {
        case 'WALLET_FUNDING':
          await this.wallet.creditWallet(txn.user_id, amount, 'Wallet funded via payment gateway');
          // Wallet funding is float — NOT revenue. No platform_revenue entry.
          // Your revenue comes from what users spend their wallet on.
          await this.wallet.sendNotification(txn.user_id, 'Wallet Funded', `₦${amount.toLocaleString()} added to your wallet.`, 'SUCCESS', 'TRANSACTION');
          break;

        case 'TOKEN_PURCHASE': {
          const { institutionId, quantity, deliveryMethod } = txn.metadata ?? {};
          const { data: inst } = await this.supabase.admin.from('institutions').select('code, short_name, vendor_cost').eq('id', institutionId).single();
          if (inst) {
            const tokens = Array.from({ length: quantity ?? 1 }, () => ({
              user_id: txn.user_id, institution_id: institutionId,
              token_code: generateTokenCode(inst.code), serial_number: generateSerialNumber(),
              status: 'ACTIVE', purchased_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            }));
            const { data: created } = await this.supabase.admin.from('tokens').insert(tokens).select('id');
            if (created) {
              await this.supabase.admin.from('token_deliveries').insert(
                created.map(t => ({ token_id: t.id, user_id: txn.user_id, delivery_method: deliveryMethod ?? 'EMAIL', status: 'PENDING' }))
              );
            }
            // Record margin revenue
            const vendorCost = (inst.vendor_cost ?? 0) * (quantity ?? 1);
            await this.revenue.record({
              transactionId: txn.id,
              userId:        txn.user_id,
              revenueType:   'TOKEN_MARGIN',
              grossAmount:   amount,
              costAmount:    vendorCost,
              notes: `Webhook: ${inst.short_name} x${quantity}`,
            });
            await this.wallet.sendNotification(txn.user_id, 'Tokens Ready', `Your ${quantity} ${inst.short_name} token(s) have been sent.`, 'SUCCESS', 'TRANSACTION');
          }
          break;
        }

        case 'POINT_PURCHASE': {
          const { pointsAwarded } = txn.metadata ?? {};
          if (pointsAwarded) {
            const { data: w } = await this.supabase.admin.from('wallets').select('points').eq('user_id', txn.user_id).single();
            if (w) await this.supabase.admin.from('wallets').update({ points: w.points + pointsAwarded }).eq('user_id', txn.user_id);
          }
          await this.wallet.sendNotification(txn.user_id, 'Points Added', `${(txn.metadata?.pointsAwarded ?? 0).toLocaleString()} points added.`, 'SUCCESS', 'TRANSACTION');
          break;
        }
      }
    } else if (isFailed) {
      await this.supabase.admin.from('transactions').update({ status: 'FAILED' }).eq('id', txn.id);
      await this.wallet.sendNotification(txn.user_id, 'Payment Failed', `Payment of ₦${amount.toLocaleString()} failed. Please try again.`, 'ERROR', 'TRANSACTION');
    }
  }
}