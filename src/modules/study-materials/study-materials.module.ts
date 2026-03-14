import { Module } from '@nestjs/common';
import { StudyMaterialsController } from './study-materials.controller';
import { StudyMaterialsService } from './study-materials.service';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [StudyMaterialsController],
  providers: [StudyMaterialsService],
})
export class StudyMaterialsModule {}
