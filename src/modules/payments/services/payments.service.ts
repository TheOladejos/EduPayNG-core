import { RevenueService } from '@common/services/revenue.service';
import { SupabaseService } from '@common/supabase/supabase.service';
import { WalletService } from '@modules/wallet/wallet.service';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PaystackService } from '../gateway/paystack.gateway';
import { RemitaService } from '../gateway/remita.gateway';


@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
    private revenue: RevenueService,
    private paystack: PaystackService,
    private remita: RemitaService,
  ) {}

  async verifyTransaction(userId: string, reference: string) {
    const { data, error } = await this.supabase.admin
      .from('transactions')
      .select('id, status, amount, payment_method, transaction_type, completed_at, created_at')
      .eq('reference', reference).eq('user_id', userId).single();
    if (error || !data) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' });
    return {
      reference,
      status:          data.status,
      amount:          data.amount,
      paymentMethod:   data.payment_method,
      transactionType: data.transaction_type,
      paidAt:          data.completed_at,
      createdAt:       data.created_at,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // WEBHOOK 1 — PAYSTACK (wallet funding ONLY)
  // Money flow: User's card → Paystack → settles to YOUR bank → creditWallet()
  // ════════════════════════════════════════════════════════════════
  async handlePaystackWebhook(rawBody: Buffer, signature: string): Promise<void> {
    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Paystack: Invalid signature — rejected'); return;
    }
    const payload = JSON.parse(rawBody.toString());
    if (payload.event !== 'charge.success') return;

    const { reference, amount: amountKobo, status, paid_at } = payload.data;
    if (status !== 'success') return;
    const amountNaira = amountKobo / 100;

    const { data: txn } = await this.supabase.admin
      .from('transactions').select('*').eq('reference', reference).maybeSingle();
    if (!txn) { this.logger.warn(`Paystack: ref not found ${reference}`); return; }
    if (txn.status !== 'PENDING') { this.logger.log(`Paystack: already processed ${reference}`); return; }

    // Double-verify via Paystack API (never trust webhook alone)
    const verified = await this.paystack.verify(reference);
    if (verified.status !== 'success') {
      this.logger.warn(`Paystack verify returned ${verified.status} for ${reference}`); return;
    }

    await this.supabase.admin.from('transactions').update({
      status: 'COMPLETED', completed_at: paid_at ?? new Date().toISOString(),
    }).eq('id', txn.id);

    // Paystack ONLY handles wallet funding
    if (txn.transaction_type === 'WALLET_FUNDING') {
      await this.wallet.creditWallet(txn.user_id, amountNaira, `Wallet funded via Paystack (${reference})`);
      await this.wallet.sendNotification(
        txn.user_id, '💰 Wallet Funded',
        `₦${amountNaira.toLocaleString()} added to your wallet.`, 'SUCCESS', 'TRANSACTION',
      );
      this.logger.log(`Paystack: ₦${amountNaira} credited to ${txn.user_id}`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // WEBHOOK 2 — REMITA (card token purchases ONLY)
  // Money flow: User's card → Remita → settles to YOUR bank account
  // After confirmation: YOUR Remita PREFUND → Institution (WAEC etc.)
  //
  // Important: When user pays by card via Remita, two money movements happen:
  //   1. User card → Remita → YOUR bank (card payment settlement, T+1)
  //   2. YOUR Remita prefund → WAEC/NECO/JAMB/NABTEB (immediate on purchaseToken call)
  //
  // So your Remita prefund must always have enough balance to service
  // card purchases, even before card settlement arrives in your bank.
  // ════════════════════════════════════════════════════════════════
  async handleRemitaWebhook(payload: any, signature: string): Promise<void> {
    if (!this.remita.verifyWebhookSignature(payload, signature)) {
      this.logger.warn('Remita: Invalid signature — rejected'); return;
    }

    const { orderId: reference, status, amount } = payload;
    const parsedStatus = this.remita.parseStatus(status);
    this.logger.log(`Remita webhook: ${reference} → ${parsedStatus}`);

    const { data: txn } = await this.supabase.admin
      .from('transactions').select('*').eq('reference', reference).maybeSingle();
    if (!txn) { this.logger.warn(`Remita: ref not found ${reference}`); return; }
    if (txn.status !== 'PENDING') { this.logger.log(`Remita: already processed ${reference}`); return; }

    if (parsedStatus === 'success') {
      await this.supabase.admin.from('transactions').update({
        status: 'COMPLETED', completed_at: new Date().toISOString(),
      }).eq('id', txn.id);

      if (txn.transaction_type === 'TOKEN_PURCHASE') {
        await this.processCardTokenPurchase(txn, amount ?? txn.amount);
      }
      if (txn.transaction_type === 'POINT_PURCHASE') {
        await this.processPointPurchase(txn);
      }

    } else if (parsedStatus === 'failed') {
      await this.supabase.admin.from('transactions').update({ status: 'FAILED' }).eq('id', txn.id);
      await this.wallet.sendNotification(
        txn.user_id, '❌ Payment Failed',
        `Your card payment of ₦${Number(txn.amount).toLocaleString()} failed. Please try again.`,
        'ERROR', 'TRANSACTION',
      );
    }
  }

  // ════════════════════════════════════════════════════════════════
  // WEBHOOK 3 — VTPASS (async bill status notifications)
  // VTPass does not send webhooks by default.
  // This endpoint handles their optional async notifications.
  // Bills paid from wallet are handled synchronously in bills.service.ts
  // ════════════════════════════════════════════════════════════════
  async handleVtpassWebhook(payload: any): Promise<void> {
    const requestId = payload.requestId;
    if (!requestId) return;
    this.logger.log(`VTPass async notification: ${requestId}`);

    const { data: billTxn } = await this.supabase.admin
      .from('bill_transactions')
      .select('*, transactions(id)')
      .eq('vtpass_request_id', requestId)
      .maybeSingle();

    if (!billTxn || billTxn.status !== 'PENDING') return;

    const isDelivered = payload.code === '000' || payload.status === 'delivered';
    const isFailed    = payload.code === '099' || payload.status === 'failed';

    if (isDelivered) {
      await this.supabase.admin.from('bill_transactions').update({
        status: 'SUCCESS', vtpass_status: 'delivered',
        vtpass_response: payload, updated_at: new Date().toISOString(),
      }).eq('id', billTxn.id);
      await this.supabase.admin.from('transactions').update({
        status: 'COMPLETED', completed_at: new Date().toISOString(),
      }).eq('id', billTxn.transactions?.id);

    } else if (isFailed) {
      // Bill failed asynchronously — refund user's wallet
      await this.wallet.creditWallet(
        billTxn.user_id, billTxn.amount,
        `Refund: ${billTxn.category_code} bill failed (async notification)`,
      );
      await this.supabase.admin.from('bill_transactions').update({
        status: 'FAILED', vtpass_status: 'failed',
        failure_reason: payload.response_description ?? 'Failed',
        updated_at: new Date().toISOString(),
      }).eq('id', billTxn.id);
      await this.supabase.admin.from('transactions').update({ status: 'FAILED' }).eq('id', billTxn.transactions?.id);
      await this.wallet.sendNotification(
        billTxn.user_id, '❌ Bill Payment Failed',
        `Your bill payment failed. ₦${Number(billTxn.amount).toLocaleString()} has been refunded to your wallet.`,
        'ERROR', 'BILL',
      );
    }
  }

  // ── Card token purchase: called after Remita payment confirmed ─
  // User paid by card → Remita settled to your bank → now buy real token
  // from institution using your Remita prefund account

  private async processCardTokenPurchase(txn: any, amount: number) {
    const { institutionId, institutionCode, quantity, deliveryMethod } = txn.metadata ?? {};

    const { data: inst } = await this.supabase.admin
      .from('institutions')
      .select('code, short_name, vendor_cost')
      .eq('id', institutionId)
      .single();

    if (!inst) {
      this.logger.error(`Institution not found: ${institutionId}`);
      return;
    }

    // Call Remita to purchase real tokens from the institution
    // Your Remita prefund account is debited here
    let remitaTokens: Awaited<ReturnType<typeof this.remita.purchaseToken>>;
    try {
      remitaTokens = await this.remita.purchaseToken({
        institutionCode: inst.code ?? institutionCode,
        quantity:        quantity ?? 1,
        reference:       txn.reference,
      });
    } catch (err: any) {
      // Remita failed to get tokens even though card payment succeeded.
      // This is a manual resolution scenario — log it for admin to handle.
      // Do NOT refund automatically since Remita already received the card payment.
      this.logger.error(
        `CRITICAL: Card payment confirmed (${txn.reference}) but Remita purchaseToken failed. ` +
        `Manual intervention required. User: ${txn.user_id}`,
        err,
      );
      await this.wallet.sendNotification(
        txn.user_id, '⚠️ Token Delivery Delayed',
        `Your payment was received. We are processing your ${inst.short_name} token. You will receive it within 30 minutes. Reference: ${txn.reference}`,
        'INFO', 'TRANSACTION',
      );
      return;
    }

    // Save real tokens from Remita into DB
    const tokenInserts = remitaTokens.map(rt => ({
      user_id:        txn.user_id,
      institution_id: institutionId,
      token_code:     rt.tokenCode,
      serial_number:  rt.serialNumber,
      remita_ref:     txn.reference,
      status:         'ACTIVE',
      purchased_at:   new Date().toISOString(),
      expires_at:     rt.expiresAt,
      raw_response:   rt.rawResponse,
    }));

    const { data: tokens } = await this.supabase.admin
      .from('tokens').insert(tokenInserts).select('id');

    if (tokens?.length) {
      await this.supabase.admin.from('token_deliveries').insert(
        tokens.map(t => ({
          token_id:        t.id,
          user_id:         txn.user_id,
          delivery_method: deliveryMethod ?? 'EMAIL',
          status:          'PENDING',
        })),
      );
    }

    // Record revenue margin
    const vendorCost = (inst.vendor_cost ?? 0) * (quantity ?? 1);
    await this.revenue.record({
      transactionId: txn.id,
      userId:        txn.user_id,
      revenueType:   'TOKEN_MARGIN',
      grossAmount:   amount,
      costAmount:    vendorCost,
      notes:         `Remita card: ${inst.short_name} x${quantity}`,
    });

    await this.wallet.sendNotification(
      txn.user_id, '🎫 Tokens Ready',
      `Your ${quantity} ${inst.short_name} token(s) have been sent to your email/SMS.`,
      'SUCCESS', 'TRANSACTION',
    );

    this.logger.log(`Card token purchase complete: ${txn.reference} — ${quantity}x ${inst.short_name}`);
  }

  private async processPointPurchase(txn: any) {
    const { pointsAwarded } = txn.metadata ?? {};
    if (!pointsAwarded) return;
    const { data: w } = await this.supabase.admin.from('wallets').select('points').eq('user_id', txn.user_id).single();
    if (w) await this.supabase.admin.from('wallets').update({ points: w.points + pointsAwarded }).eq('user_id', txn.user_id);
    await this.wallet.sendNotification(txn.user_id, '⭐ Points Added', `${pointsAwarded.toLocaleString()} points added.`, 'SUCCESS', 'TRANSACTION');
  }
}