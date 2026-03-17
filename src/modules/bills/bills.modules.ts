
import { Module } from '@nestjs/common';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.services';
import { WalletModule } from '../wallet/wallet.module';
import { RevenueService } from '../../common/services/revenue.service';

@Module({
  imports: [WalletModule],
  controllers: [BillsController],
  providers: [BillsService, RevenueService],
})
export class BillsModule {}