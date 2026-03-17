import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export type RevenueType =
  | 'TOKEN_MARGIN'
  | 'BILLS_MARGIN'
  | 'EXAM_FEE'
  | 'AI_QUERY'
  | 'POINT_SALE'
  | 'MATERIAL_SALE'
  | 'SCHOLARSHIP_FEE';

export interface RecordRevenueParams {
  transactionId?: string;
  userId: string;
  revenueType: RevenueType;
  grossAmount: number;   // what user paid (in kobo or naira — be consistent)
  costAmount: number;    // what you owe vendor (0 for own products)
  notes?: string;
}

@Injectable()
export class RevenueService {
  private readonly logger = new Logger(RevenueService.name);

  constructor(private supabase: SupabaseService) {}

  /**
   * Record one revenue event.
   * Call this inside every transaction that earns EduPayNG money.
   * revenue_amount is automatically computed as gross - cost.
   */
  async record(params: RecordRevenueParams): Promise<void> {
    const revenueAmount = params.grossAmount - params.costAmount;

    const { error } = await this.supabase.admin.from('platform_revenue').insert({
      transaction_id:  params.transactionId ?? null,
      user_id:         params.userId,
      revenue_type:    params.revenueType,
      gross_amount:    params.grossAmount,
      cost_amount:     params.costAmount,
      revenue_amount:  revenueAmount,
      notes:           params.notes ?? null,
    });

    if (error) {
      // Never fail the parent transaction because of revenue logging
      this.logger.error(`Revenue record failed: ${error.message}`, { params });
    }
  }

  /**
   * Dashboard summary — total revenue, cost, profit for a date range.
   */
  async getSummary(from?: string, to?: string) {
    let q = this.supabase.admin
      .from('platform_revenue')
      .select('revenue_type, gross_amount, cost_amount, revenue_amount');

    if (from) q = q.gte('created_at', from);
    if (to)   q = q.lte('created_at', to);

    const { data } = await q;
    const rows = data ?? [];

    const totals = rows.reduce(
      (acc, r) => ({
        gross:   acc.gross   + Number(r.gross_amount),
        cost:    acc.cost    + Number(r.cost_amount),
        revenue: acc.revenue + Number(r.revenue_amount),
      }),
      { gross: 0, cost: 0, revenue: 0 },
    );

    const byType = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.revenue_type] = (acc[r.revenue_type] ?? 0) + Number(r.revenue_amount);
      return acc;
    }, {});

    return { ...totals, byType };
  }
}