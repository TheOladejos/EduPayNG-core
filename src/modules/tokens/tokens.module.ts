import { forwardRef, Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { WalletModule } from '../wallet/wallet.module';
import { RevenueService } from '@common/services/revenue.service';
import { SettlementService } from '@common/services/settlement.service';
import { PaymentsModule } from '@modules/payments/payments.module';

@Module({
  imports: [
    WalletModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [TokensController],
  providers:   [TokensService, RevenueService, SettlementService],
  exports:     [TokensService],
})
export class TokensModule {}
