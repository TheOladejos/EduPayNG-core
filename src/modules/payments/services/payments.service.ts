import { Injectable } from "@nestjs/common";
import { GatewayFactory } from "../factory/gateway.factory";

@Injectable()
export class PaymentService {
  async initialize(provider: string, payload: any) {
    const gateway = GatewayFactory.create(provider);

    return gateway.initializePayment(payload);
  }

  async verify(provider: string, reference: string) {
    const gateway = GatewayFactory.create(provider);

    return gateway.verifyPayment(reference);
  }
}
