import { SupabaseService } from '@common/supabase/supabase.service';
import { WalletService } from '@modules/wallet/wallet.service';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PaystackService } from '../gateway/paystack.gateway';
import { TokensService } from '@modules/tokens/tokens.service';


@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private supabase:  SupabaseService,
    private wallet:    WalletService,
    private paystack:  PaystackService,
    private tokens:    TokensService,
  ) {}

  async verifyTransaction(userId: string, reference: string) {
    const { data, error } = await this.supabase.admin
      .from('transactions')
      .select('id, status, amount, payment_method, transaction_type, completed_at, created_at, metadata')
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
  // PAYSTACK WEBHOOK — handles ALL payment types:
  //   1. WALLET_FUNDING         → credit wallet
  //   2. TOKEN_PURCHASE         → call token gateway (VTPass/Remita)
  //   3. HYBRID_TOKEN_PURCHASE  → release wallet hold + call token gateway
  //   4. POINT_PURCHASE         → credit points
  // ════════════════════════════════════════════════════════════════
  async handlePaystackWebhook(rawBody: Buffer, signature: string): Promise<void> {
    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Paystack: Invalid signature — rejected'); return;
    }

    const payload = JSON.parse(rawBody.toString());
    console.log(payload);
    
    if (payload.event !== 'charge.success') return;

    const { reference, amount: amountKobo, status, paid_at, metadata: paystackMeta } = payload.data;
    if (status !== 'success') return;
    const amountNaira = amountKobo / 100;
    const type        = paystackMeta?.type ?? '';

    this.logger.log(`Paystack webhook: ${reference} — type: ${type}`);

    // ── CASE 1: Wallet funding ─────────────────────────────────
    if (type === 'WALLET_FUNDING' || !type) {
      const { data: txn } = await this.supabase.admin
        .from('transactions').select('*').eq('reference', reference).maybeSingle();
      if (!txn) { this.logger.warn(`Paystack: ref not found ${reference}`); return; }
      if (txn.status !== 'PENDING') { this.logger.log(`Paystack: already processed ${reference}`); return; }

      const verified = await this.paystack.verify(reference);
      if (verified.status !== 'success') return;

      await this.supabase.admin.from('transactions').update({ status: 'COMPLETED', completed_at: paid_at ?? new Date().toISOString() }).eq('id', txn.id);
      await this.wallet.creditWallet(txn.user_id, amountNaira, `Wallet funded via Paystack (${reference})`);
      await this.wallet.sendNotification(txn.user_id, '💰 Wallet Funded', `₦${amountNaira.toLocaleString()} added to your wallet.`, 'SUCCESS', 'TRANSACTION');
      return;
    }

    // ── CASE 2: Full Paystack token purchase ───────────────────
    if (type === 'TOKEN_PURCHASE') {
      const { data: txn } = await this.supabase.admin
        .from('transactions').select('*').eq('reference', reference).maybeSingle();
      if (!txn) { this.logger.warn(`Token ref not found: ${reference}`); return; }
      if (txn.status !== 'PENDING') { this.logger.log(`Already processed: ${reference}`); return; }

      const verified = await this.paystack.verify(reference);
      if (verified.status !== 'success') return;

      const { institutionId, gateway, quantity, deliveryMethod } = paystackMeta ?? {};

      const { data: institution } = await this.supabase.admin
        .from('institutions').select('*').eq('id', institutionId).single();
      if (!institution) { this.logger.error(`Institution not found: ${institutionId}`); return; }

      await this.tokens.fulfillTokens({
        userId:         txn.user_id,
        txnId:          txn.id,
        reference,
        gateway:        gateway ?? institution.gateway,
        institution,
        quantity:       quantity ?? 1,
        deliveryMethod: deliveryMethod ?? 'EMAIL',
        totalAmount:    amountNaira,
        paymentSource:  'PAYSTACK',
      });
      return;
    }

    // ── CASE 3: Hybrid token purchase (card portion confirmed) ──
    if (type === 'HYBRID_TOKEN_PURCHASE') {
      const { mainRef, walletAmount, cardAmount, institutionId, gateway, quantity, deliveryMethod, vendorCost } = paystackMeta ?? {};

      this.logger.log(`Hybrid payment confirmed: ${reference} (card ₦${amountNaira}) for mainRef ${mainRef}`);

      // Verify amount matches expected
      const verified = await this.paystack.verify(reference);
      if (verified.status !== 'success') {
        await this.releaseHold(mainRef, 'RELEASED');
        return;
      }

      // Find the wallet hold
      const { data: hold } = await this.supabase.admin
        .from('wallet_holds').select('*').eq('transaction_ref', mainRef).eq('status', 'HOLDING').single();
      if (!hold) { this.logger.warn(`Hold not found for mainRef: ${mainRef}`); return; }

      // Find the main transaction
      const { data: txn } = await this.supabase.admin
        .from('transactions').select('*').eq('reference', mainRef).single();
      if (!txn || txn.status !== 'PENDING') return;

      // The wallet was already reduced when hold was placed.
      // Now we log the actual debit wallet_transaction for the held amount.
      const { data: walletRow } = await this.supabase.admin
        .from('wallets').select('id, balance').eq('user_id', hold.user_id).single();
      if (walletRow) {
        await this.supabase.admin.from('wallet_transactions').insert({
          wallet_id:      walletRow.id,
          user_id:        hold.user_id,
          type:           'DEBIT',
          amount:         hold.hold_amount,
          balance_before: walletRow.balance + hold.hold_amount, // before hold was placed
          balance_after:  walletRow.balance,
          description:    `Hybrid payment: ₦${hold.hold_amount} wallet + ₦${hold.card_amount} card — ${mainRef}`,
        });
      }

      // Mark hold as captured
      await this.supabase.admin.from('wallet_holds')
        .update({ status: 'CAPTURED', released_at: new Date().toISOString(), paystack_ref: reference })
        .eq('id', hold.id);

      const { data: institution } = await this.supabase.admin
        .from('institutions').select('*').eq('id', institutionId).single();
      if (!institution) return;

      const totalAmount = Number(hold.hold_amount) + Number(hold.card_amount);

      // Fulfill the tokens
      await this.tokens.fulfillTokens({
        userId:         hold.user_id,
        txnId:          txn.id,
        reference:      mainRef,
        gateway:        gateway ?? institution.gateway,
        institution,
        quantity:       quantity ?? 1,
        deliveryMethod: deliveryMethod ?? 'EMAIL',
        totalAmount,
        paymentSource:  'HYBRID',
      });
      return;
    }

    // ── CASE 4: Point purchase ─────────────────────────────────
    if (type === 'POINT_PURCHASE') {
      const { data: txn } = await this.supabase.admin
        .from('transactions').select('*').eq('reference', reference).maybeSingle();
      if (!txn || txn.status !== 'PENDING') return;
      await this.supabase.admin.from('transactions').update({ status: 'COMPLETED', completed_at: new Date().toISOString() }).eq('id', txn.id);
      const { pointsAwarded } = txn.metadata ?? {};
      if (pointsAwarded) {
        const { data: w } = await this.supabase.admin.from('wallets').select('points').eq('user_id', txn.user_id).single();
        if (w) await this.supabase.admin.from('wallets').update({ points: w.points + pointsAwarded }).eq('user_id', txn.user_id);
      }
      await this.wallet.sendNotification(txn.user_id, '⭐ Points Added', `${(paystackMeta?.pointsAwarded ?? 0).toLocaleString()} points added.`, 'SUCCESS', 'TRANSACTION');
    }
  }

  // ── Paystack card failed event ─────────────────────────────────
  // Handle charge.failed to release hybrid holds if Paystack sends it
  async handlePaystackChargeFailure(rawBody: Buffer, signature: string): Promise<void> {
    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) return;
    const payload = JSON.parse(rawBody.toString());
    if (payload.event !== 'charge.failed') return;

    const { reference, metadata: meta } = payload.data;
    if (meta?.type === 'HYBRID_TOKEN_PURCHASE' && meta?.mainRef) {
      await this.releaseHold(meta.mainRef, 'RELEASED');
      this.logger.log(`Hybrid hold released (card failed): ${meta.mainRef}`);
    }
  }

  // ── VTPass webhook (async bill notifications only) ─────────────
  async handleVtpassWebhook(payload: any): Promise<void> {
    const requestId = payload.requestId;
    if (!requestId) return;
    const { data: billTxn } = await this.supabase.admin
      .from('bill_transactions').select('*, transactions(id)').eq('vtpass_request_id', requestId).maybeSingle();
    if (!billTxn || billTxn.status !== 'PENDING') return;

    const isDelivered = payload.code === '000' || payload.status === 'delivered';
    const isFailed    = payload.code === '099' || payload.status === 'failed';

    if (isDelivered) {
      await this.supabase.admin.from('bill_transactions').update({ status: 'SUCCESS', vtpass_status: 'delivered', vtpass_response: payload, updated_at: new Date().toISOString() }).eq('id', billTxn.id);
      await this.supabase.admin.from('transactions').update({ status: 'COMPLETED', completed_at: new Date().toISOString() }).eq('id', billTxn.transactions?.id);
    } else if (isFailed) {
      await this.wallet.creditWallet(billTxn.user_id, billTxn.amount, `Refund: ${billTxn.category_code} failed`);
      await this.supabase.admin.from('bill_transactions').update({ status: 'FAILED', vtpass_status: 'failed', failure_reason: payload.response_description, updated_at: new Date().toISOString() }).eq('id', billTxn.id);
      await this.supabase.admin.from('transactions').update({ status: 'FAILED' }).eq('id', billTxn.transactions?.id);
      await this.wallet.sendNotification(billTxn.user_id, '❌ Bill Failed', `Your bill failed. ₦${Number(billTxn.amount).toLocaleString()} has been refunded.`, 'ERROR', 'BILL');
    }
  }

  // ── Release a wallet hold (on card failure or timeout) ──────────
  private async releaseHold(transactionRef: string, status: 'RELEASED'): Promise<void> {
    const { data: hold } = await this.supabase.admin
      .from('wallet_holds').select('*').eq('transaction_ref', transactionRef).eq('status', 'HOLDING').single();
    if (!hold) return;

    // Return held amount to wallet balance
    const { data: walletRow } = await this.supabase.admin
      .from('wallets').select('id, balance').eq('user_id', hold.user_id).single();
    if (walletRow) {
      const newBalance = walletRow.balance + hold.hold_amount;
      await this.supabase.admin.from('wallets').update({ balance: newBalance }).eq('id', walletRow.id);
      await this.supabase.admin.from('wallet_transactions').insert({
        wallet_id: walletRow.id, user_id: hold.user_id, type: 'CREDIT',
        amount: hold.hold_amount, balance_before: walletRow.balance, balance_after: newBalance,
        description: `Hold released: card payment failed — ${transactionRef}`,
      });
    }

    await this.supabase.admin.from('wallet_holds')
      .update({ status, released_at: new Date().toISOString() }).eq('id', hold.id);

    await this.supabase.admin.from('transactions').update({ status: 'FAILED' }).eq('reference', transactionRef);
    await this.wallet.sendNotification(hold.user_id, '❌ Payment Failed',
      `Your card payment failed. ₦${Number(hold.hold_amount).toLocaleString()} has been returned to your wallet.`,
      'ERROR', 'TRANSACTION');
  }
}
