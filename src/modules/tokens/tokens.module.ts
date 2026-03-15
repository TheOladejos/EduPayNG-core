import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { WalletModule } from '../wallet/wallet.module';
import { RevenueService } from '@common/services/revenue.service';
import { SettlementService } from '@common/services/settlement.service';

@Module({
  imports: [WalletModule],
  controllers: [TokensController],
  providers: [TokensService,RevenueService, SettlementService],
})
export class TokensModule {}
