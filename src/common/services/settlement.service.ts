import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export type VendorType = 'WAEC' | 'NECO' | 'JAMB' | 'NABTEB' | 'INTERNAL';

export interface RecordSettlementParams {
  transactionId: string;
  userId: string;
  vendorType: VendorType;
  grossAmount: number;    // what user paid
  vendorAmount: number;   // what we owe vendor
  paymentMethod?: string;
  notes?: string;
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(private supabase: SupabaseService) {}

  // ── Record a pending vendor payable ──────────────────────────
  // Call this every time a wallet-paid transaction owes a vendor.
  // INTERNAL vendor means EduPayNG owns the product (exams, AI) — no real payout needed.

  async record(params: RecordSettlementParams): Promise<void> {
    const platformAmount = params.grossAmount - params.vendorAmount;

    const { error } = await this.supabase.admin.from('pending_settlements').insert({
      transaction_id:  params.transactionId,
      user_id:         params.userId,
      vendor_type:     params.vendorType,
      gross_amount:    params.grossAmount,
      vendor_amount:   params.vendorAmount,
      platform_amount: platformAmount,
      payment_method:  params.paymentMethod ?? 'WALLET',
      status:          'PENDING',
      notes:           params.notes ?? null,
    });

    if (error) {
      // Never crash the parent transaction — just log
      this.logger.error(`Settlement record failed: ${error.message}`, { params });
    }
  }

  // ── Mark a settlement as paid to vendor ──────────────────────
  // Call this manually or from an admin endpoint when you've
  // actually transferred the money to WAEC/NECO/JAMB/NABTEB.

  async markSettled(settlementId: string, settledBy: string): Promise<void> {
    await this.supabase.admin.from('pending_settlements').update({
      status:     'SETTLED',
      settled_at: new Date().toISOString(),
      settled_by: settledBy,
    }).eq('id', settlementId).eq('status', 'PENDING');
  }

  // ── Reconciliation: compares wallet balances vs ledger ───────
  // Returns the wallet_reconciliation view.
  // ledger_drift should always be 0. Alert if not.

  async getReconciliation() {
    const { data, error } = await this.supabase.admin
      .from('wallet_reconciliation')
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Reconciliation query failed: ${error.message}`);
      return null;
    }

    const drift = Number(data.ledger_drift ?? 0);
    if (drift !== 0) {
      this.logger.warn(`⚠️ Ledger drift detected: ₦${drift}. Investigate immediately.`);
    }

    return {
      totalWalletBalances:     Number(data.total_wallet_balances),
      ledgerNetBalance:        Number(data.ledger_net_balance),
      totalFundedEver:         Number(data.total_funded_ever),
      totalWalletSpent:        Number(data.total_wallet_spent),
      pendingVendorPayables:   Number(data.total_pending_vendor_payables),
      totalPlatformRevenue:    Number(data.total_platform_revenue),
      ledgerDrift:             drift,
      isHealthy:               drift === 0,
      checkedAt:               data.checked_at,
    };
  }

  // ── Pending settlements list (for admin payout dashboard) ────

  async getPendingSettlements(vendorType?: VendorType) {
    let q = this.supabase.admin
      .from('pending_settlements')
      .select('id, vendor_type, vendor_ref, gross_amount, vendor_amount, platform_amount, created_at, notes, transaction_id')
      .eq('status', 'PENDING')
      .order('created_at', { ascending: false });

    if (vendorType) q = q.eq('vendor_type', vendorType);

    const { data } = await q;
    return data ?? [];
  }

  // ── Vendor summary (for admin dashboard) ─────────────────────

  async getVendorSummary() {
    const { data } = await this.supabase.admin
      .from('vendor_settlement_summary')
      .select('*');
    return data ?? [];
  }
}