import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { ExamsModule } from './modules/exams/exams.module';
import { AiModule } from './modules/ai/ai.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { StudyMaterialsModule } from './modules/study-materials/study-materials.module';
import { ScholarshipsModule } from './modules/scholarships/scholarships.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SupportModule } from './modules/support/support.module';
import { BookmarksModule } from './modules/bookmarks/bookmarks.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { SupabaseModule } from './common/supabase/supabase.module';

@Module({
  imports: [
    // Config (loads .env)
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('THROTTLE_TTL', 60) * 1000,
          limit: config.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
    }),

    // Shared
    SupabaseModule,

    // Feature modules
    AuthModule,
    UsersModule,
    WalletModule,
    TokensModule,
    ExamsModule,
    AiModule,
    PaymentsModule,
    StudyMaterialsModule,
    ScholarshipsModule,
    NotificationsModule,
    SupportModule,
    BookmarksModule,
    ReferralsModule,
  ],
  providers: [
    // Apply rate limiting globally
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
