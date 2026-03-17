import { Global, Module } from '@nestjs/common';
import { VtpassService } from './vtPass.gateway';
import { RemitaService } from './remita.gateway';
import { PaystackService } from './paystack.gateway';

@Global()
@Module({
   providers: [PaystackService, RemitaService, VtpassService],
  exports:   [PaystackService, RemitaService, VtpassService],
})
export class GatewayModule {}
