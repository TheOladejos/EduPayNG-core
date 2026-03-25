import { SupabaseService } from '@common/supabase/supabase.service';
import { Injectable } from '@nestjs/common';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

@Injectable()
export class AdminDashboardService {
  constructor(private supabase: SupabaseService) {}

  async getKpis() {
    const today      = new Date(new Date().setHours(0,0,0,0)).toISOString();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const lastMonthStart = new Date(new Date().getFullYear(), new Date().getMonth()-1, 1).toISOString();
    const lastMonthEnd   = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString();

    const [
      { count: totalUsers },
      { count: newToday },
      { count: newMonth },
      { data: revMonth },
      { data: revLastMonth },
      { data: revToday },
      { count: totalTokens },
      { count: tokensToday },
      { count: activeSessions },
      { count: openTickets },
      { data: walletFloat },
      { data: pendingSettlements },
    ] = await Promise.all([
      this.supabase.admin.from('profiles').select('*', { count: 'exact', head: true }),
      this.supabase.admin.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', today),
      this.supabase.admin.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', monthStart),
      this.supabase.admin.from('platform_revenue').select('revenue_amount').gte('created_at', monthStart),
      this.supabase.admin.from('platform_revenue').select('revenue_amount').gte('created_at', lastMonthStart).lte('created_at', lastMonthEnd),
      this.supabase.admin.from('platform_revenue').select('revenue_amount').gte('created_at', today),
      this.supabase.admin.from('tokens').select('*', { count: 'exact', head: true }),
      this.supabase.admin.from('tokens').select('*', { count: 'exact', head: true }).gte('purchased_at', today),
      this.supabase.admin.from('student_exams').select('*', { count: 'exact', head: true }).eq('status', 'IN_PROGRESS'),
      this.supabase.admin.from('support_tickets').select('*', { count: 'exact', head: true }).in('status', ['OPEN', 'IN_PROGRESS']),
      this.supabase.admin.from('wallets').select('balance'),
      this.supabase.admin.from('pending_settlements').select('vendor_amount').eq('status', 'PENDING'),
    ]);

    const sum = (rows: any[], key: string) => (rows ?? []).reduce((s, r) => s + Number(r[key]), 0);
    const rm = sum(revMonth ?? [], 'revenue_amount');
    const rlm = sum(revLastMonth ?? [], 'revenue_amount');
    const rt = sum(revToday ?? [], 'revenue_amount');
    const float = sum(walletFloat ?? [], 'balance');
    const payables = sum(pendingSettlements ?? [], 'vendor_amount');

    return {
      users: { total: totalUsers ?? 0, newToday: newToday ?? 0, newThisMonth: newMonth ?? 0 },
      revenue: { today: rt, thisMonth: rm, lastMonth: rlm, monthGrowth: rlm > 0 ? Math.round(((rm-rlm)/rlm)*100) : 0 },
      tokens: { total: totalTokens ?? 0, today: tokensToday ?? 0 },
      exams: { activeSessions: activeSessions ?? 0 },
      support: { openTickets: openTickets ?? 0 },
      wallet: { totalFloat: float, pendingVendorPayables: payables, netFloat: float - payables },
    };
  }

  async getRevenueChart(days = 30) {
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await this.supabase.admin.from('platform_revenue').select('revenue_amount, created_at').gte('created_at', from).order('created_at');
    const byDate: Record<string, number> = {};
    for (const r of data ?? []) {
      const d = r.created_at.substring(0, 10);
      byDate[d] = (byDate[d] ?? 0) + Number(r.revenue_amount);
    }
    return Object.entries(byDate).map(([date, revenue]) => ({ date, revenue })).sort((a,b) => a.date.localeCompare(b.date));
  }

  async getUserGrowthChart(days = 30) {
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const { data } = await this.supabase.admin.from('profiles').select('created_at').gte('created_at', from).order('created_at');
    const byDate: Record<string, number> = {};
    for (const r of data ?? []) {
      const d = r.created_at.substring(0, 10);
      byDate[d] = (byDate[d] ?? 0) + 1;
    }
    return Object.entries(byDate).map(([date, count]) => ({ date, count })).sort((a,b) => a.date.localeCompare(b.date));
  }

  async getRecentTransactions(limit = 10) {
    const { data } = await this.supabase.admin.from('transactions')
      .select('id, reference, transaction_type, amount, payment_method, status, created_at, user_id')
      .order('created_at', { ascending: false }).limit(limit);
    return data ?? [];
  }

  async getRevenueByType() {
    const { data } = await this.supabase.admin.from('platform_revenue').select('revenue_type, revenue_amount');
    const grouped: Record<string, number> = {};
    for (const r of data ?? []) grouped[r.revenue_type] = (grouped[r.revenue_type] ?? 0) + Number(r.revenue_amount);
    return Object.entries(grouped).map(([type, revenue]) => ({ type, revenue })).sort((a,b) => b.revenue - a.revenue);
  }
}

@ApiTags('Admin — Dashboard')
@ApiBearerAuth('JWT')
@Controller({ path: 'admin/dashboard', version: '1' })
export class AdminDashboardController {
  constructor(private svc: AdminDashboardService) {}

  @Get('kpis')
  @ApiOperation({ summary: 'Platform KPIs — users, revenue, tokens, wallet float' })
  kpis() { return this.svc.getKpis(); }

  @Get('charts/revenue')
  @ApiQuery({ name: 'days', required: false })
  @ApiOperation({ summary: 'Daily revenue chart data' })
  revenueChart(@Query('days') days?: number) { return this.svc.getRevenueChart(days ? +days : 30); }

  @Get('charts/users')
  @ApiQuery({ name: 'days', required: false })
  @ApiOperation({ summary: 'Daily user registration chart data' })
  userChart(@Query('days') days?: number) { return this.svc.getUserGrowthChart(days ? +days : 30); }

  @Get('recent-transactions')
  @ApiOperation({ summary: 'Most recent transactions across all users' })
  recentTxns() { return this.svc.getRecentTransactions(); }

  @Get('revenue-by-type')
  @ApiOperation({ summary: 'Total revenue broken down by product type' })
  revByType() { return this.svc.getRevenueByType(); }
}
