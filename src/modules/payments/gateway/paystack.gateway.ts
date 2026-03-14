import axios from "axios";
import { PaymentGateway } from "../interface/payment.interface";

export class PaystackGateway implements PaymentGateway {
  private baseUrl = "https://api.paystack.co";
  private secret = process.env.PAYSTACK_SECRET;

  async initializePayment(data: any) {
    const res = await axios.post(
      `${this.baseUrl}/transaction/initialize`,
      {
        email: data.email,
        amount: data.amount * 100,
        reference: data.reference,
        metadata: data.metadata,
      },
      {
        headers: {
          Authorization: `Bearer ${this.secret}`,
        },
      }
    );

    return { paymentUrl: res.data.data.authorization_url };
  }

  async verifyPayment(reference: string) {
    const res = await axios.get(
      `${this.baseUrl}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${this.secret}`,
        },
      }
    );

    return {
      status: res.data.data.status,
      amount: res.data.data.amount / 100,
      reference,
    };
  }
}
