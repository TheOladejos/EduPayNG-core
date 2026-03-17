// ─── wallet.module.ts ────────────────────────────────────────────────────────
import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { SupabaseService } from '@common/supabase/supabase.service';
import { PaystackService } from '@modules/payments/gateway/paystack.gateway';
import { ConfigService } from '@nestjs/config';

@Module({
  controllers: [WalletController],
  providers: [WalletService, SupabaseService, PaystackService, ConfigService],
  exports: [WalletService],
})
export class WalletModule {}
