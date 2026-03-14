import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { RegisterDto, LoginDto } from './auth.dto';
import { generateRef } from '../../common/helpers/generators';
import { User } from '@supabase/supabase-js';

@Injectable()
export class AuthService {
  constructor(
    private supabase: SupabaseService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    // Check duplicate email
    const { data: existingAuth } = await this.supabase.admin.auth.admin
      .listUsers();
    const emailExists = existingAuth?.users?.find((u:User) => u.email === dto.email);
    if (emailExists) {
      throw new ConflictException({ code: 'EMAIL_EXISTS', message: 'Email address already registered' });
    }

    // Check duplicate phone
    if (dto.phone) {
      const { data: phoneCheck } = await this.supabase.admin
        .from('profiles').select('id').eq('phone', dto.phone).maybeSingle();
      if (phoneCheck) {
        throw new ConflictException({ code: 'PHONE_EXISTS', message: 'Phone number already registered' });
      }
    }

    // Create Supabase auth user
    const { data: authData, error: authError } = await this.supabase.admin.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: false,
      user_metadata: { firstName: dto.firstName, lastName: dto.lastName },
    });

    if (authError) {
      throw new InternalServerErrorException({ code: 'REGISTRATION_FAILED', message: authError.message });
    }

    const userId = authData.user.id;

    try {
      // Create profile
      await this.supabase.admin.from('profiles').insert({
        id: userId,
        first_name: dto.firstName,
        last_name: dto.lastName,
        phone: dto.phone ?? null,
        date_of_birth: dto.dateOfBirth ?? null,
      });

      // Create wallet
      await this.supabase.admin.from('wallets').insert({
        user_id: userId,
        balance: 0,
        points: 0,
        total_funded: 0,
        total_spent: 0,
        is_active: true,
      });

      // Handle referral
      if (dto.referralCode) {
        const { data: referrer } = await this.supabase.admin
          .from('referral_codes').select('user_id').eq('code', dto.referralCode).maybeSingle();
        if (referrer) {
          await this.supabase.admin.from('referrals').insert({
            referrer_id: referrer.user_id,
            referred_id: userId,
            status: 'PENDING',
          });
        }
      }
    } catch (err) {
      // Rollback auth user
      await this.supabase.admin.auth.admin.deleteUser(userId);
      throw new InternalServerErrorException({ code: 'SETUP_FAILED', message: 'Account setup failed' });
    }

    const tokens = this.signTokens(userId, dto.email);

    return {
      user: { id: userId, email: dto.email, firstName: dto.firstName, lastName: dto.lastName },
      session: tokens,
    };
  }

  async login(dto: LoginDto) {
    const { data, error } = await this.supabase.client.auth.signInWithPassword({
      email: dto.email,
      password: dto.password,
    });

    if (error || !data.user) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password' });
    }

    const { data: profile } = await this.supabase.admin
      .from('profiles')
      .select('first_name, last_name, avatar_url')
      .eq('id', data.user.id)
      .single();

    const tokens = this.signTokens(data.user.id, data.user.email!);

    return {
      user: {
        id: data.user.id,
        email: data.user.email,
        firstName: profile?.first_name ?? '',
        lastName: profile?.last_name ?? '',
        avatarUrl: profile?.avatar_url ?? null,
      },
      session: tokens,
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwt.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
      const tokens = this.signTokens(payload.sub, payload.email);
      return tokens;
    } catch {
      throw new UnauthorizedException({ code: 'REFRESH_FAILED', message: 'Invalid or expired refresh token' });
    }
  }

  async forgotPassword(email: string) {
    // Always return success (prevent email enumeration)
    await this.supabase.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${this.config.get('APP_URL')}/reset-password`,
    });
    return { message: 'If that email is registered, a password reset link has been sent.' };
  }

  async resetPassword(userId: string, newPassword: string) {
    const { error } = await this.supabase.admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (error) throw new BadRequestException({ code: 'RESET_FAILED', message: error.message });
    return { message: 'Password updated successfully' };
  }

  private signTokens(userId: string, email: string) {
    const payload = { sub: userId, email };
    const accessToken = this.jwt.sign(payload);
    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN', '7d'),
    });
    return { accessToken, refreshToken, expiresIn: 3600 };
  }
}
