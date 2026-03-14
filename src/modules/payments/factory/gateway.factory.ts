
import { PaystackGateway } from "../gateway/paystack.gateway";

export class GatewayFactory {
  static create(provider: string) {
    switch (provider) {
      case "paystack":
        return new PaystackGateway();

    //   case "flutterwave":
    //     return new FlutterwaveGateway();

    //   case "monnify":
    //     return new MonnifyGateway();

      default:
        throw new Error("Invalid payment provider");
    }
  }
}
