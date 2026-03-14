import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiCreditsService } from './ai-credit.service';
import { AiService } from './ai.service';
import { RevenueService } from '@common/services/revenue.service';
import { WalletModule } from '@modules/wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [AiController],
  providers: [AiService, AiCreditsService, RevenueService],
  exports: [AiCreditsService],
})
export class AiModule {}
