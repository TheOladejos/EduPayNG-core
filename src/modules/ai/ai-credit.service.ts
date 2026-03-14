import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { WalletService } from '../wallet/wallet.service';
import { RevenueService } from '../../common/services/revenue.service';
import { generateRef } from '../../common/helpers/generators';

// Cost per AI query in naira (₦10 per message)
export const AI_QUERY_PRICE_NAIRA = 10;
// Credits per query (always 1 in this model)
export const CREDITS_PER_QUERY = 1;

@Injectable()
export class AiCreditsService {
  private readonly logger = new Logger(AiCreditsService.name);

  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
    private revenue: RevenueService,
  ) {}

  // ── Get or initialise credit row ─────────────────────────────

  async getCredits(userId: string) {
    const { data, error } = await this.supabase.admin
      .from('ai_credits')
      .select('id, balance, total_purchased, total_used')
      .eq('user_id', userId)
      .maybeSingle();

    if (!data) {
      // Auto-create with 0 balance
      const { data: created } = await this.supabase.admin
        .from('ai_credits')
        .insert({ user_id: userId, balance: 0 })
        .select()
        .single();
      return created;
    }

    return data;
  }

  // ── Debit 1 credit before an AI call ────────────────────────
  // Returns the wallet debit amount so it can be recorded

  async chargeOneQuery(userId: string): Promise<{ walletDebitAmount: number }> {
    const credits = await this.getCredits(userId);

    if (!credits || credits.balance < CREDITS_PER_QUERY) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_AI_CREDITS',
        message: `You have no EduBot credits. Purchase a credit pack to continue.`,
        currentBalance: credits?.balance ?? 0,
      });
    }

    const newBalance = credits.balance - CREDITS_PER_QUERY;

    // Deduct credit and increment usage counter
    await this.supabase.admin
      .from('ai_credits')
      .update({
        balance:    newBalance,
        total_used: credits.total_used + CREDITS_PER_QUERY,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    return { walletDebitAmount: AI_QUERY_PRICE_NAIRA };
  }

  // ── Log the actual OpenAI usage after a successful call ──────

  async logUsage(params: {
    userId: string;
    conversationId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
    creditsCharged: number;
  }) {
    // Approximate USD cost for analytics (gpt-4o-mini pricing)
    const usdCost = (params.inputTokens * 0.00000015) + (params.outputTokens * 0.0000006);

    await this.supabase.admin.from('ai_usage_log').insert({
      user_id:         params.userId,
      conversation_id: params.conversationId,
      credits_charged: params.creditsCharged,
      input_tokens:    params.inputTokens,
      output_tokens:   params.outputTokens,
      total_tokens:    params.totalTokens,
      model:           params.model,
      openai_cost_usd: usdCost,
    });
  }

  // ── Purchase a credit package via wallet ─────────────────────

  async purchasePackage(userId: string, packageId: string) {
    const { data: pkg } = await this.supabase.admin
      .from('ai_credit_packages')
      .select('*')
      .eq('id', packageId)
      .eq('is_active', true)
      .single();

    if (!pkg) throw new NotFoundException({ code: 'PACKAGE_NOT_FOUND', message: 'Credit package not found' });

    const totalCredits = pkg.credits + (pkg.bonus_credits ?? 0);
    const reference = generateRef('AIC');

    // Debit wallet (this throws if balance insufficient)
    await this.wallet.debitWallet(
      userId,
      pkg.price,
      `EduBot Credits — ${pkg.name} (${totalCredits} queries)`,
    );

    // Credit AI balance
    const existing = await this.getCredits(userId);
    await this.supabase.admin.from('ai_credits').update({
      balance:         (existing?.balance ?? 0) + totalCredits,
      total_purchased: (existing?.total_purchased ?? 0) + totalCredits,
      updated_at:      new Date().toISOString(),
    }).eq('user_id', userId);

    // Log transaction
    const { data: txn } = await this.supabase.admin.from('transactions').insert({
      user_id:          userId,
      reference,
      transaction_type: 'AI_CREDIT_PURCHASE',
      amount:           pkg.price,
      payment_method:   'WALLET',
      status:           'COMPLETED',
      completed_at:     new Date().toISOString(),
      metadata:         { packageId: pkg.id, creditsAwarded: totalCredits },
    }).select().single();

    // Record revenue (AI credit sales are 100% margin — no vendor cost)
    await this.revenue.record({
      transactionId: txn?.id,
      userId,
      revenueType:   'AI_QUERY',
      grossAmount:   pkg.price,
      costAmount:    0,
      notes:         `AI credit pack: ${pkg.name}`,
    });

    await this.wallet.sendNotification(
      userId,
      'EduBot Credits Added',
      `${totalCredits} EduBot credits added to your account. Start chatting!`,
      'SUCCESS',
      'AI',
    );

    return {
      reference,
      creditsAwarded: totalCredits,
      newBalance: (existing?.balance ?? 0) + totalCredits,
      packageName: pkg.name,
    };
  }

  // ── List available packages ───────────────────────────────────

  async listPackages() {
    const { data } = await this.supabase.admin
      .from('ai_credit_packages')
      .select('id, name, credits, price, bonus_credits, description')
      .eq('is_active', true)
      .order('display_order');

    return (data ?? []).map(p => ({
      id:           p.id,
      name:         p.name,
      credits:      p.credits,
      price:        p.price,
      bonusCredits: p.bonus_credits,
      totalCredits: p.credits + (p.bonus_credits ?? 0),
      description:  p.description,
      pricePerQuery: Math.round((p.price / (p.credits + (p.bonus_credits ?? 0))) * 100) / 100,
    }));
  }
}