import { forwardRef, Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { WalletModule } from '../wallet/wallet.module';
import { RevenueService } from '@common/services/revenue.service';
import { PaymentsService } from './services/payments.service';
import { TokensModule } from '@modules/tokens/tokens.module';

@Module({
  imports: [
    WalletModule,
    forwardRef(() => TokensModule), // forwardRef avoids circular dep
  ],
  controllers: [PaymentsController],
  providers:   [PaymentsService, RevenueService],
  exports:     [PaymentsService],
})
export class PaymentsModule {}
