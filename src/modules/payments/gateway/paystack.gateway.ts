import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { PaystackInitResult, PaystackVerifyResult } from '../interface/payment.interface';

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly http: AxiosInstance;
  private readonly secretKey: string;

  constructor(private config: ConfigService) {
    this.secretKey = config.getOrThrow('PAYSTACK_SECRET');
    const baseURL = config.getOrThrow('PAYSTACK_BASE_URL');

    this.http = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  }

  // ── Initialize a payment — returns URL to redirect user to ──

  async initialize(params: {
    email: string;
    amountNaira: number;
    reference: string;
    callbackUrl: string;
    metadata?: Record<string, any>;
  }): Promise<PaystackInitResult> {
    const amountKobo = Math.round(params.amountNaira * 100);

    const { data } = await this.http.post('/transaction/initialize', {
      email:        params.email,
      amount:       amountKobo,
      reference:    params.reference,
      callback_url: params.callbackUrl,
      metadata:     params.metadata ?? {},
      channels:     ['card', 'bank', 'ussd', 'bank_transfer'],
    });

    if (!data.status) throw new BadRequestException({ code: 'PAYSTACK_INIT_FAILED', message: data.message });

    return {
      authorizationUrl: data.data.authorization_url,
      accessCode:       data.data.access_code,
      reference:        data.data.reference,
    };
  }

  // ── Verify a transaction by reference ────────────────────────

  async verify(reference: string): Promise<PaystackVerifyResult> {
    const { data } = await this.http.get(`/transaction/verify/${encodeURIComponent(reference)}`);

    return {
      status:    data.data.status,
      amount:    data.data.amount / 100,  // kobo → naira
      reference: data.data.reference,
      channel:   data.data.channel,
      paidAt:    data.data.paid_at ?? null,
    };
  }

  // ── Verify webhook signature ──────────────────────────────────
  // Call this in the webhook controller BEFORE processing anything.

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
    const hash = crypto
      .createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest('hex');

    const isValid = hash === signatureHeader;
    if (!isValid) this.logger.warn('Invalid Paystack webhook signature');
    return isValid;
  }
}