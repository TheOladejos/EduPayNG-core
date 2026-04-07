import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Controller, Get, Post, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsString, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CurrentAdmin, AdminUser, AdminRoles } from '../admin.guard';
import { SupabaseService } from '@common/supabase/supabase.service';
import { paginate, PaginationDto } from '@common/dto/pagination.dto';

class WalletAdjustDto {
  @ApiProperty({ enum: ['CREDIT','DEBIT'] }) @IsEnum(['CREDIT','DEBIT']) type: 'CREDIT'|'DEBIT';
  @ApiProperty() @IsNumber() @Min(1) amount: number;
  @ApiProperty() @IsString() reason: string;
}
class AiCreditDto {
  @ApiProperty({ description: 'Positive to add, negative to remove' }) @IsNumber() amount: number;
  @ApiProperty() @IsString() reason: string;
}
class SuspendDto { @ApiProperty() @IsString() reason: string; }

@Injectable()
export class AdminUsersService {
  constructor(private supabase: SupabaseService) {}

  async listUsers(query: PaginationDto & { search?: string }) {
    const page = query.page ?? 1; const limit = query.limit ?? 25; const offset = (page-1)*limit;
    let { data, count, error } = await this.supabase.admin.from('profiles')
      .select('id, first_name, last_name, phone, state_of_origin, email_verified, phone_verified, created_at, wallets(balance, points, total_funded, total_spent)', { count: 'exact' })
      .order('created_at', { ascending: false }).range(offset, offset+limit-1);
      

    // if (query.search) q = q.or(`first_name.ilike.%${query.search}%,last_name.ilike.%${query.search}%,phone.ilike.%${query.search}%`);
    // const  = await q;
    if (error) throw new BadRequestException(error.message);
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async getUserDetail(userId: string) {
    const [profile, wallet, tokens, exams, transactions, aiCredits, bills] = await Promise.all([
      this.supabase.admin.from('profiles').select('*').eq('id', userId).single(),
      this.supabase.admin.from('wallets').select('*').eq('user_id', userId).single(),
      this.supabase.admin.from('tokens').select('id, status, purchased_at, institutions(short_name)').eq('user_id', userId).order('purchased_at', { ascending: false }).limit(10),
      this.supabase.admin.from('student_exams').select('id, status, enrolled_at, exams(title)').eq('user_id', userId).order('enrolled_at', { ascending: false }).limit(10),
      this.supabase.admin.from('transactions').select('id, reference, transaction_type, amount, status, payment_method, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
      this.supabase.admin.from('ai_credits').select('balance, total_purchased, total_used').eq('user_id', userId).maybeSingle(),
      this.supabase.admin.from('bill_transactions').select('id, category_code, amount, status, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(10),
    ]);
    if (!profile.data) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    return { profile: profile.data, wallet: wallet.data, aiCredits: aiCredits.data, recentTokens: tokens.data ?? [], recentExams: exams.data ?? [], recentTransactions: transactions.data ?? [], recentBills: bills.data ?? [] };
  }

  async suspendUser(userId: string, adminEmail: string, reason: string) {
    const { error } = await this.supabase.admin.auth.admin.updateUserById(userId, { ban_duration: '876600h' });
    if (error) throw new BadRequestException({ code: 'SUSPEND_FAILED', message: error.message });
    await this.supabase.admin.from('audit_logs').insert({ action: 'USER_SUSPENDED', resource_type: 'USER', resource_id: userId, metadata: { reason, by: adminEmail } });
    return { message: 'User suspended successfully' };
  }

  async unsuspendUser(userId: string, adminEmail: string) {
    const { error } = await this.supabase.admin.auth.admin.updateUserById(userId, { ban_duration: 'none' });
    if (error) throw new BadRequestException({ code: 'UNSUSPEND_FAILED', message: error.message });
    await this.supabase.admin.from('audit_logs').insert({ action: 'USER_UNSUSPENDED', resource_type: 'USER', resource_id: userId, metadata: { by: adminEmail } });
    return { message: 'User unsuspended successfully' };
  }

  async adjustWallet(userId: string, dto: WalletAdjustDto, adminEmail: string) {
    const { data: wallet } = await this.supabase.admin.from('wallets').select('id, balance').eq('user_id', userId).single();
    if (!wallet) throw new NotFoundException('Wallet not found');
    if (dto.type === 'DEBIT' && wallet.balance < dto.amount) throw new BadRequestException({ code: 'INSUFFICIENT_BALANCE', message: `Balance is ₦${wallet.balance}` });
    const newBalance = dto.type === 'CREDIT' ? wallet.balance + dto.amount : wallet.balance - dto.amount;
    await this.supabase.admin.from('wallets').update({ balance: newBalance }).eq('id', wallet.id);
    await this.supabase.admin.from('wallet_transactions').insert({ wallet_id: wallet.id, user_id: userId, type: dto.type, amount: dto.amount, balance_before: wallet.balance, balance_after: newBalance, description: `Admin ${dto.type.toLowerCase()}: ${dto.reason}` });
    await this.supabase.admin.from('audit_logs').insert({ action: `ADMIN_WALLET_${dto.type}`, resource_type: 'WALLET', resource_id: wallet.id, metadata: { userId, amount: dto.amount, reason: dto.reason, by: adminEmail, balanceBefore: wallet.balance, balanceAfter: newBalance } });
    return { newBalance, type: dto.type, amount: dto.amount };
  }

  async adjustAiCredits(userId: string, dto: AiCreditDto, adminEmail: string) {
    const { data: credits } = await this.supabase.admin.from('ai_credits').select('id, balance').eq('user_id', userId).maybeSingle();
    const current = credits?.balance ?? 0;
    const newBal = Math.max(0, current + dto.amount);
    if (credits) await this.supabase.admin.from('ai_credits').update({ balance: newBal }).eq('user_id', userId);
    else await this.supabase.admin.from('ai_credits').insert({ user_id: userId, balance: newBal });
    await this.supabase.admin.from('audit_logs').insert({ action: 'ADMIN_AI_CREDIT_ADJUST', resource_type: 'AI_CREDITS', resource_id: userId, metadata: { amount: dto.amount, reason: dto.reason, by: adminEmail, balanceBefore: current, balanceAfter: newBal } });
    return { newBalance: newBal, adjusted: dto.amount };
  }
}

@ApiTags('Admin — Users')
@ApiBearerAuth('JWT')
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(private svc: AdminUsersService) {}

  @Get() @ApiOperation({ summary: 'List all users with wallet info' })
  list(@Query() q: PaginationDto & { search?: string }) { return this.svc.listUsers(q); }

  @Get(':id') @ApiOperation({ summary: 'Full user detail' })
  detail(@Param('id') id: string) { return this.svc.getUserDetail(id); }

  @Post(':id/suspend') @AdminRoles('SUPER_ADMIN','ADMIN') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Suspend user account' })
  suspend(@Param('id') id: string, @Body() dto: SuspendDto, @CurrentAdmin() admin: AdminUser) { return this.svc.suspendUser(id, admin.email, dto.reason); }

  @Post(':id/unsuspend') @AdminRoles('SUPER_ADMIN','ADMIN') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Unsuspend user account' })
  unsuspend(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) { return this.svc.unsuspendUser(id, admin.email); }

  @Post(':id/wallet/adjust') @AdminRoles('SUPER_ADMIN','ADMIN','FINANCE') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Manually credit or debit user wallet' })
  adjustWallet(@Param('id') id: string, @Body() dto: WalletAdjustDto, @CurrentAdmin() admin: AdminUser) { return this.svc.adjustWallet(id, dto, admin.email); }

  @Post(':id/ai-credits/adjust') @AdminRoles('SUPER_ADMIN','ADMIN') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Adjust user AI credits' })
  adjustAi(@Param('id') id: string, @Body() dto: AiCreditDto, @CurrentAdmin() admin: AdminUser) { return this.svc.adjustAiCredits(id, dto, admin.email); }
}
