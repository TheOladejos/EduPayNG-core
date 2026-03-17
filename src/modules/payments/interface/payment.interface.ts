export interface PaystackInitResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaystackVerifyResult {
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  amount: number;        // in kobo — divide by 100 for naira
  reference: string;
  channel: string;
  paidAt: string | null;
}