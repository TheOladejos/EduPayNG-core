import { Module } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@Injectable()
export class ReferralsService {
  constructor(private supabase: SupabaseService, private config: ConfigService) {}

  async getReferrals(userId: string) {
    let { data: refInfo } = await this.supabase.admin.from('referral_codes').select('code').eq('user_id', userId).maybeSingle();
    if (!refInfo) {
      const code = `REF-${userId.substring(0, 6).toUpperCase()}${Date.now().toString(36).toUpperCase().slice(-4)}`;
      const { data } = await this.supabase.admin.from('referral_codes').insert({ user_id: userId, code }).select().single();
      refInfo = data;
    }
    const { data: referrals } = await this.supabase.admin.from('referrals')
      .select('id, status, reward_amount, reward_credited, created_at, completed_at')
      .eq('referrer_id', userId).order('created_at', { ascending: false });
    const totalEarned = (referrals ?? []).filter(r => r.reward_credited).reduce((s, r) => s + (r.reward_amount ?? 0), 0);
    return {
      referralCode: refInfo?.code,
      referralUrl: `${this.config.get('APP_URL')}/register?ref=${refInfo?.code}`,
      totalReferrals: (referrals ?? []).length,
      completedReferrals: (referrals ?? []).filter(r => r.status === 'COMPLETED').length,
      totalEarned,
      referrals: referrals ?? [],
    };
  }
}

@ApiTags('Referrals')
@ApiBearerAuth('JWT')
@Controller({ path: 'referrals', version: '1' })
export class ReferralsController {
  constructor(private svc: ReferralsService) {}
  @Get() @ApiOperation({ summary: 'Get referral program details and history' })
  get(@CurrentUser() u: AuthUser) { return this.svc.getReferrals(u.id); }
}

@Module({ controllers: [ReferralsController], providers: [ReferralsService] })
export class ReferralsModule {}
