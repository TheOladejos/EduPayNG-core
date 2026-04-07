import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RemitaService } from '@modules/payments/gateway/remita.gateway';
import { VtpassService } from '@modules/payments/gateway/vtPass.gateway';


export type VendorName = 'REMITA' | 'VTPASS';

export interface TopupDto {
  vendor:          VendorName;
  amount:          number;
  bankReference?:  string;
  transferDate:    string;   // ISO date string  e.g. '2024-03-15'
  notes?:          string;
}

export interface ConfirmTopupDto {
  balanceAfter: number;
  notes?:       string;
}

@Injectable()
export class VendorFundingService {
  private readonly logger = new Logger(VendorFundingService.name);

  constructor(
    private supabase: SupabaseService,
    private remita:   RemitaService,
    private vtpass:   VtpassService,
  ) {}

  // ── Get vendor bank account details ──────────────────────────
  // Shows where to send the bank transfer for each vendor.

  async getVendorBankAccounts() {
    const { data } = await this.supabase.admin
      .from('vendor_bank_accounts')
      .select('vendor, bank_name, account_name, account_number, sort_code, transfer_reference, notes')
      .order('vendor');
    return data ?? [];
  }

  // ── Check live balances from both vendors ─────────────────────
  // Fetches live balance from Remita and VTPass APIs.
  // Also logs to vendor_balance_log for history.

  async checkLiveBalances() {
    const [thresholds, remitaBal, vtpassBal] = await Promise.all([
      this.getThresholds(),
      this.remita.checkPrefundBalance(),
      this.vtpass.checkPrefundBalance(),
    ]);

    const remitaThreshold = thresholds.REMITA ?? { min_balance: 50000, critical_balance: 10000 };
    const vtpassThreshold = thresholds.VTPASS ?? { min_balance: 30000, critical_balance: 5000 };

    const remitaStatus = this.classifyBalance(remitaBal.availableBalance, remitaThreshold);
    const vtpassStatus = this.classifyBalance(vtpassBal.balance, vtpassThreshold);

    // Log both for history
    await this.supabase.admin.from('vendor_balance_log').insert([
      {
        vendor:     'REMITA',
        balance:    remitaBal.availableBalance,
        is_low:     remitaStatus !== 'OK',
        threshold:  remitaThreshold.min_balance,
      },
      {
        vendor:     'VTPASS',
        balance:    vtpassBal.balance,
        is_low:     vtpassStatus !== 'OK',
        threshold:  vtpassThreshold.min_balance,
      },
    ]);

    // Get last known topup for each vendor for context
    const [lastRemitaTopup, lastVtpassTopup] = await Promise.all([
      this.getLastTopup('REMITA'),
      this.getLastTopup('VTPASS'),
    ]);

    // Project runway based on recent spend rate
    const [remitaProjection, vtpassProjection] = await Promise.all([
      this.projectRunway('REMITA', remitaBal.availableBalance),
      this.projectRunway('VTPASS', vtpassBal.balance),
    ]);

    return {
      remita: {
        availableBalance:  remitaBal.availableBalance,
        currency:          'NGN',
        status:            remitaStatus,
        alertLevel:        this.toAlertLevel(remitaStatus),
        thresholds:        remitaThreshold,
        lastTopup:         lastRemitaTopup,
        projectedRunway:   remitaProjection,
        usedFor:           'Token purchases — NECO, NABTEB',
        howToTopUp:        'See GET /admin/vendor-funding/bank-accounts for transfer details',
      },
      vtpass: {
        availableBalance:  vtpassBal.balance,
        currency:          'NGN',
        status:            vtpassStatus,
        alertLevel:        this.toAlertLevel(vtpassStatus),
        thresholds:        vtpassThreshold,
        lastTopup:         lastVtpassTopup,
        projectedRunway:   vtpassProjection,
        usedFor:           'Bills — Airtime, Data, WAEC, JAMB',
        howToTopUp:        'See GET /admin/vendor-funding/bank-accounts for transfer details',
      },
      note: 'These are your PREFUNDED vendor accounts. Top them up by bank transfer. Paystack (wallet funding) settles to your main bank — check dashboard.paystack.com',
      checkedAt: new Date().toISOString(),
    };
  }

  // ── Record a top-up you initiated ────────────────────────────
  // Call this AS SOON as you submit the bank transfer.
  // Status starts as INITIATED → you confirm it later when
  // the vendor balance actually increases.

  async recordTopup(dto: TopupDto, adminEmail: string) {
    // Capture current vendor balance for before-snapshot
    let balanceBefore: number | null = null;
    try {
      if (dto.vendor === 'REMITA') {
        const b = await this.remita.checkPrefundBalance();
        balanceBefore = b.availableBalance;
      } else {
        const b = await this.vtpass.checkPrefundBalance();
        balanceBefore = b.balance;
      }
    } catch { /* non-fatal — proceed without snapshot */ }

    const { data, error } = await this.supabase.admin
      .from('prefund_topups')
      .insert({
        vendor:          dto.vendor,
        amount:          dto.amount,
        bank_reference:  dto.bankReference ?? null,
        transfer_date:   dto.transferDate,
        status:          'INITIATED',
        balance_before:  balanceBefore,
        recorded_by:     adminEmail,
        notes:           dto.notes ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    this.logger.log(`Top-up recorded: ${dto.vendor} ₦${dto.amount.toLocaleString()} by ${adminEmail}`);

    return {
      id:            data.id,
      vendor:        data.vendor,
      amount:        data.amount,
      status:        data.status,
      transferDate:  data.transfer_date,
      balanceBefore,
      message:       `Top-up of ₦${dto.amount.toLocaleString()} recorded for ${dto.vendor}. ` +
                     `After the transfer clears (usually same day for NIP), ` +
                     `use POST /admin/vendor-funding/topups/${data.id}/confirm to verify the balance increased.`,
    };
  }

  // ── Confirm a top-up after balance increases ─────────────────
  // After you transfer the money, wait for vendor balance to increase,
  // then call this to mark it CONFIRMED with the new balance.

  async confirmTopup(topupId: string, dto: ConfirmTopupDto, adminEmail: string) {
    const { data: topup } = await this.supabase.admin
      .from('prefund_topups')
      .select('*')
      .eq('id', topupId)
      .single();

    if (!topup) throw new NotFoundException('Top-up record not found');

    // Verify live balance matches expected
    let liveBalance: number;
    try {
      if (topup.vendor === 'REMITA') {
        const b = await this.remita.checkPrefundBalance();
        liveBalance = b.availableBalance;
      } else {
        const b = await this.vtpass.checkPrefundBalance();
        liveBalance = b.balance;
      }
    } catch {
      liveBalance = dto.balanceAfter; // fall back to manually provided value
    }

    await this.supabase.admin.from('prefund_topups').update({
      status:        'CONFIRMED',
      confirmed_at:  new Date().toISOString(),
      balance_after: dto.balanceAfter,
      notes:         dto.notes
        ? `${topup.notes ?? ''} | Confirmed by ${adminEmail}: ${dto.notes}`
        : topup.notes,
    }).eq('id', topupId);

    return {
      id:            topupId,
      vendor:        topup.vendor,
      amount:        topup.amount,
      status:        'CONFIRMED',
      balanceBefore: topup.balance_before,
      balanceAfter:  dto.balanceAfter,
      liveBalance,
      matchesExpected: Math.abs(liveBalance - dto.balanceAfter) < 100, // within ₦100
    };
  }

  // ── List all top-up history ───────────────────────────────────

  async listTopups(vendor?: VendorName, limit = 50) {
    let q = this.supabase.admin
      .from('prefund_topups')
      .select('id, vendor, amount, bank_reference, transfer_date, status, confirmed_at, balance_before, balance_after, recorded_by, notes, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (vendor) q = q.eq('vendor', vendor);
    const { data } = await q;
    return data ?? [];
  }

  // ── Update thresholds ─────────────────────────────────────────

  async updateThreshold(vendor: VendorName, minBalance: number, criticalBalance: number) {
    const { data } = await this.supabase.admin
      .from('vendor_balance_thresholds')
      .upsert({ vendor, min_balance: minBalance, critical_balance: criticalBalance, updated_at: new Date().toISOString() })
      .select()
      .single();
    return data;
  }

  // ── Balance history chart data ────────────────────────────────

  async getBalanceHistory(vendor: VendorName, days = 30) {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await this.supabase.admin
      .from('vendor_balance_log')
      .select('balance, is_low, checked_at')
      .eq('vendor', vendor)
      .gte('checked_at', from)
      .order('checked_at', { ascending: true });

    return (data ?? []).map(row => ({
      balance:   Number(row.balance),
      isLow:     row.is_low,
      checkedAt: row.checked_at,
    }));
  }

  // ── Scheduled balance check (called by cron) ─────────────────
  // Call this every 30 minutes from a cron job or Supabase Edge Function.
  // Returns alert objects if either balance is critical.

  async scheduledCheck(): Promise<{ alerts: string[]; remitaBalance: number; vtpassBalance: number }> {
    const data = await this.checkLiveBalances();
    const alerts: string[] = [];

    if (data.remita.alertLevel === 'CRITICAL') {
      alerts.push(`🚨 CRITICAL: Remita prefund at ₦${data.remita.availableBalance.toLocaleString()}. Token purchases will fail. Top up immediately.`);
    } else if (data.remita.alertLevel === 'LOW') {
      alerts.push(`⚠️ LOW: Remita prefund at ₦${data.remita.availableBalance.toLocaleString()}. Top up soon.`);
    }

    if (data.vtpass.alertLevel === 'CRITICAL') {
      alerts.push(`🚨 CRITICAL: VTPass prefund at ₦${data.vtpass.availableBalance.toLocaleString()}. Bill payments will fail. Top up immediately.`);
    } else if (data.vtpass.alertLevel === 'LOW') {
      alerts.push(`⚠️ LOW: VTPass prefund at ₦${data.vtpass.availableBalance.toLocaleString()}. Top up soon.`);
    }

    if (alerts.length > 0) {
      this.logger.warn(`Prefund alerts:\n${alerts.join('\n')}`);
      // In production: send email/SMS to ops team here
      // e.g. this.emailService.sendAlert(alerts)
    }

    return {
      alerts,
      remitaBalance: data.remita.availableBalance,
      vtpassBalance: data.vtpass.availableBalance,
    };
  }

  // ── Private helpers ───────────────────────────────────────────

  private async getThresholds() {
    const { data } = await this.supabase.admin
      .from('vendor_balance_thresholds')
      .select('vendor, min_balance, critical_balance');

    return Object.fromEntries(
      (data ?? []).map(t => [t.vendor, { min_balance: Number(t.min_balance), critical_balance: Number(t.critical_balance) }]),
    ) as Record<string, { min_balance: number; critical_balance: number }>;
  }

  private async getLastTopup(vendor: VendorName) {
    const { data } = await this.supabase.admin
      .from('prefund_topups')
      .select('amount, transfer_date, status, confirmed_at')
      .eq('vendor', vendor)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ?? null;
  }

  // Project how many days the current balance will last
  // based on average spend over the last 7 days.
  private async projectRunway(vendor: VendorName, currentBalance: number): Promise<{
    avgDailySpend:    number;
    estimatedDaysLeft: number | null;
    warning:          string | null;
  }> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Sum what was spent from this vendor's prefund in last 7 days
      const { data: logs } = await this.supabase.admin
        .from('vendor_balance_log')
        .select('balance, checked_at')
        .eq('vendor', vendor)
        .gte('checked_at', sevenDaysAgo)
        .order('checked_at', { ascending: true });

      if (!logs || logs.length < 2) {
        return { avgDailySpend: 0, estimatedDaysLeft: null, warning: null };
      }

      // Calculate total drop over the 7 days
      const firstBalance = Number(logs[0].balance);
      const lastBalance  = Number(logs[logs.length - 1].balance);
      const totalDrop    = Math.max(0, firstBalance - lastBalance);
      const avgDailySpend = totalDrop / 7;

      if (avgDailySpend <= 0) {
        return { avgDailySpend: 0, estimatedDaysLeft: null, warning: null };
      }

      const estimatedDaysLeft = Math.floor(currentBalance / avgDailySpend);
      const warning = estimatedDaysLeft < 3
        ? `Balance may run out in ~${estimatedDaysLeft} day(s) based on recent spend`
        : null;

      return { avgDailySpend: Math.round(avgDailySpend), estimatedDaysLeft, warning };

    } catch {
      return { avgDailySpend: 0, estimatedDaysLeft: null, warning: null };
    }
  }

  private classifyBalance(
    balance: number,
    threshold: { min_balance: number; critical_balance: number },
  ): 'OK' | 'LOW' | 'CRITICAL' | 'CHECK_FAILED' {
    if (balance === -1)                        return 'CHECK_FAILED';
    if (balance <= threshold.critical_balance) return 'CRITICAL';
    if (balance <= threshold.min_balance)      return 'LOW';
    return 'OK';
  }

  private toAlertLevel(status: 'OK' | 'LOW' | 'CRITICAL' | 'CHECK_FAILED'): string {
    const map = { OK: '✅ OK', LOW: '⚠️ LOW — Top up soon', CRITICAL: '🚨 CRITICAL — Top up immediately', CHECK_FAILED: '❓ CHECK FAILED' };
    return map[status];
  }
}