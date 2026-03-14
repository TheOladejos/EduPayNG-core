export interface PaymentGateway {
  initializePayment(data: {
    email: string;
    amount: number;
    reference: string;
    metadata?: Record<string, any>;
  }): Promise<{ paymentUrl: string }>;

  verifyPayment(reference: string): Promise<{
    status: "success" | "failed" | "pending";
    amount: number;
    reference: string;
  }>;
}
