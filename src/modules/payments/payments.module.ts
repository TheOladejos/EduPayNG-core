import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { WalletModule } from '../wallet/wallet.module';
import { RevenueService } from '@common/services/revenue.service';
import { PaymentsService } from './services/payments.service';

@Module({
  imports: [WalletModule],
  controllers: [PaymentsController],
  providers: [PaymentsService,RevenueService],
})
export class PaymentsModule {}
