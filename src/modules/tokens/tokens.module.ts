import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { WalletModule } from '../wallet/wallet.module';
import { RevenueService } from '@common/services/revenue.service';

@Module({
  imports: [WalletModule],
  controllers: [TokensController],
  providers: [TokensService,RevenueService],
})
export class TokensModule {}
