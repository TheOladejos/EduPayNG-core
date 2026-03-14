import { Injectable, NotFoundException } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { paginate, PaginationDto } from '../../common/dto/pagination.dto';

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^0[7-9][01]\d{8}$/) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() stateOfOrigin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() dateOfBirth?: string;
}

@Injectable()
export class UsersService {
  constructor(private supabase: SupabaseService) {}

  async getProfile(userId: string, email: string) {
    const { data, error } = await this.supabase.admin
      .from('profiles')
      .select('id, first_name, last_name, phone, date_of_birth, state_of_origin, address, avatar_url, email_verified, phone_verified, created_at')
      .eq('id', userId).single();
    if (error || !data) throw new NotFoundException({ code: 'PROFILE_NOT_FOUND', message: 'Profile not found' });
    return { id: data.id, email, firstName: data.first_name, lastName: data.last_name, phone: data.phone, dateOfBirth: data.date_of_birth, stateOfOrigin: data.state_of_origin, address: data.address, avatarUrl: data.avatar_url, emailVerified: data.email_verified, phoneVerified: data.phone_verified, createdAt: data.created_at };
  }

  async updateProfile(userId: string, dto: Partial<UpdateProfileDto>) {
    const updates: any = { updated_at: new Date().toISOString() };
    if (dto.firstName) updates.first_name = dto.firstName;
    if (dto.lastName) updates.last_name = dto.lastName;
    if (dto.phone) updates.phone = dto.phone;
    if (dto.stateOfOrigin) updates.state_of_origin = dto.stateOfOrigin;
    if (dto.address) updates.address = dto.address;
    if (dto.dateOfBirth) updates.date_of_birth = dto.dateOfBirth;
    const { data, error } = await this.supabase.admin.from('profiles').update(updates).eq('id', userId).select().single();
    if (error) throw new NotFoundException(error.message);
    return { id: data.id, firstName: data.first_name, lastName: data.last_name, updatedAt: data.updated_at };
  }

  async getTransactions(userId: string, query: PaginationDto & { status?: string; type?: string }) {
    const page = query.page ?? 1; const limit = query.limit ?? 20; const offset = (page - 1) * limit;
    let q = this.supabase.admin.from('transactions').select('*', { count: 'exact' }).eq('user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (query.status) q = q.eq('status', query.status);
    if (query.type) q = q.eq('transaction_type', query.type);
    const { data, count } = await q;
    return paginate(data ?? [], count ?? 0, page, limit);
  }
}
