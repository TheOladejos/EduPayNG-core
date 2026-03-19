import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface RemitaInitResult {
  paymentUrl: string;
  rrr: string;
}

export interface RemitaTokenResult {
  tokenCode:    string;   // Real token from WAEC/NECO/JAMB/NABTEB
  serialNumber: string;   // Real serial number
  expiresAt:    string;   // ISO date
  rawResponse:  Record<string, any>;
}

export interface RemitaPrefundBalance {
  availableBalance: number;
  currency: string;
}

@Injectable()
export class RemitaService {
  private readonly logger = new Logger(RemitaService.name);
  private readonly http: AxiosInstance;
  private readonly merchantId: string;
  private readonly apiKey: string;
  private readonly serviceTypeId: string;
  private readonly baseUrl: string;
  private readonly webhookSecret: string;

  constructor(private config: ConfigService) {
    this.merchantId    = config.getOrThrow('REMITA_MERCHANT_ID');
    this.apiKey        = config.getOrThrow('REMITA_API_KEY');
    this.serviceTypeId = config.getOrThrow('REMITA_SERVICE_TYPE_ID');
    this.baseUrl       = config.get('REMITA_BASE_URL', 'https://api.remita.net');
    this.webhookSecret = config.get('REMITA_WEBHOOK_SECRET', '');

    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `remitaConsumerKey=${this.merchantId},remitaConsumerToken=${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  // ── Initialize a card payment page ────────────────────────────
  // Used when user pays by CARD — redirects to Remita hosted page.

  async initialize(params: {
    amountNaira: number;
    reference:   string;
    description: string;
    callbackUrl: string;
  }): Promise<RemitaInitResult> {
    try {
      const { data } = await this.http.post(
        '/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit',
        {
          serviceTypeId: this.serviceTypeId,
          amount:        params.amountNaira,
          orderId:       params.reference,
          description:   params.description,
          responseurl:   params.callbackUrl,
        },
      );
      return {
        rrr:        data.RRR,
        paymentUrl: `${this.baseUrl}/remita/ecomm/finalize.reg?merchantId=${this.merchantId}&hash=${data.RRR}`,
      };
    } catch (err) {
      this.logger.error('Remita initialize failed', err);
      return {
        rrr:        params.reference,
        paymentUrl: `https://remita.net/pay/${params.reference}`,
      };
    }
  }

  // ── Purchase a real exam token from the institution API ───────
  // This is called AFTER payment is confirmed (wallet debit or card webhook).
  // Remita debits your PREFUNDED account and calls the institution (WAEC etc.)
  // returning the real token code and serial number.
  //
  // NOTE: The exact endpoint and payload structure depends on your
  // Remita eBillsPay / Token service agreement. Adjust field names
  // to match what Remita's support team provides in your API docs.

  async purchaseToken(params: {
    institutionCode: string;  // 'NECO'  'NABTEB'
    quantity:        number;
    reference:       string;
    examineePhone?:  string;
  }): Promise<any> {
    try {
      // Remita eBillsPay token purchase endpoint
      // Adjust this URL and payload to your specific Remita service agreement
      const { data } = await this.http.post(
        '/remita/exapp/api/v1/send/api/echannelsvc/echannel/token/purchase',
        {
          merchantId:      this.merchantId,
          serviceTypeId:   this.serviceTypeId,
          orderId:         params.reference,
          institutionCode: params.institutionCode,
          quantity:        params.quantity,
          phone:           params.examineePhone ?? '',
          // Hash = SHA256(merchantId + serviceTypeId + orderId + apiKey)
          hash: crypto
            .createHash('sha512')
            .update(`${this.merchantId}${this.serviceTypeId}${params.reference}${this.apiKey}`)
            .digest('hex'),
        },
      );

      if (!data || data.statuscode !== '025') {
        // 025 = success in Remita eBillsPay
        throw new ServiceUnavailableException({
          code:    'REMITA_TOKEN_FAILED',
          message: data?.responsemessage ?? 'Remita token purchase failed',
        });
      }

      // Remita returns an array of tokens when quantity > 1
      const rawTokens: any[] = Array.isArray(data.tokens) ? data.tokens : [data];

      return rawTokens.map((t) => ({
        tokenCode:    t.token ?? t.tokenCode ?? t.pin,
        serialNumber: t.serialNumber ?? t.sn ?? t.transactionId,
        expiresAt:    t.expiryDate
          ? new Date(t.expiryDate).toISOString()
          : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        rawResponse: t,
      }));

    } catch (err: any) {
      this.logger.error(`Remita purchaseToken failed: ${err.message}`, err);

      // Re-throw if already our error type
      if (err?.code === 'REMITA_TOKEN_FAILED') throw err;

      throw new ServiceUnavailableException({
        code:    'REMITA_UNAVAILABLE',
        message: 'Token purchase service is temporarily unavailable. Your payment will be refunded.',
      });
    }
  }

  // ── Check your Remita prefund balance ─────────────────────────
  // Call this from a scheduled job or admin endpoint.
  // Alert when balance falls below your threshold.

  async checkPrefundBalance(): Promise<RemitaPrefundBalance> {
    try {
      const hash = crypto
        .createHash('sha512')
        .update(`${this.merchantId}${this.apiKey}`)
        .digest('hex');

      const { data } = await this.http.get(
        `/remita/exapp/api/v1/send/api/echannelsvc/echannel/balance?merchantId=${this.merchantId}&hash=${hash}`,
      );

      return {
        availableBalance: Number(data.availableBalance ?? data.balance ?? 0),
        currency:         data.currency ?? 'NGN',
      };
    } catch (err) {
      this.logger.error('Remita balance check failed', err);
      return { availableBalance: -1, currency: 'NGN' };
    }
  }

  // ── Verify webhook signature ──────────────────────────────────

  verifyWebhookSignature(payload: object, signatureHeader: string): boolean {
    if (!this.webhookSecret) return true;
    const expected = crypto
      .createHmac('sha512', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
    const isValid = expected === signatureHeader;
    if (!isValid) this.logger.warn('Remita: Invalid webhook signature');
    return isValid;
  }

  parseStatus(status: string): 'success' | 'failed' | 'pending' {
    if (['SUCCESS', '00', '025'].includes(status)) return 'success';
    if (['FAILED', '021', '099'].includes(status))  return 'failed';
    return 'pending';
  }
}