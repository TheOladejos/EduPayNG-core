import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { v4 as uuid } from 'uuid';


export interface VtpassBillResult {
  reference:   string;
  status:      'delivered' | 'failed' | 'pending';
  token?:      string | Array<string>;        // electricity token
  quantity?:      string;        // electricity units
  productName: string;
  purchased_code?: string;
  Pin?: string;
  cards?: { pin: string; serial: string }; // for exam tokens
  commission_rate: number;      // for bills with variable commission
}

export interface VtpassVariation {
  variationCode: string;
  name:          string;
  variationAmount: string;
  fixedPrice:    string;
}

@Injectable()
export class VtpassService {
  private readonly logger = new Logger(VtpassService.name);
  private readonly http: AxiosInstance;

  constructor(private config: ConfigService) {
    const apiKey  = config.getOrThrow('VTPASS_API_KEY');
    const pubKey  = config.getOrThrow('VTPASS_PUBLIC_KEY');
    const baseUrl = config.get('VTPASS_BASE_URL', 'https://vtpass.com/api');

    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        'api-key':    apiKey,
        'public-key': pubKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000, // Bills can be slow — 30s
    });
  }

  // ── Check your VTPass prefund wallet balance ──────────────────
  // VTPass is prepaid — you must top up before users can buy bills.
  // Call this from a scheduled job. Alert when balance is low.

  async checkPrefundBalance(): Promise<{ balance: number; currency: string }> {
    try {
      const { data } = await this.http.get('/balance');
      return {
        balance:  Number(data.contents?.balance ?? 0),
        currency: 'NGN',
      };
    } catch (err) {
      this.logger.error('VTPass balance check failed', err);
      return { balance: -1, currency: 'NGN' };
    }
  }

  // ── Purchase exam token via VTPass (WAEC, JAMB) ──────────────
  // VTPass supports WAEC and JAMB result checker token purchases
  // via their educational services API.

  async purchaseToken(params: {
    serviceId:  string;   // VTPass serviceID e.g. 'waec', 'jamb'
    quantity:   number;
    reference:  string;
    phone:      string;
    institutionName?: string; // for logging only
  }){

    const requestId = this.genRequestId();

    const { data } = await this.http.post('/pay', {
      request_id:     requestId,
      serviceID:      params.serviceId,
      billersCode:    params.phone,
      variation_code: 'prepaid',
      amount:         0,          // amount is fixed by VTPass for tokens
      phone:          params.phone,
      quantity:       params.quantity,
    });

    const result = this.parseBillResult(requestId, data, params.institutionName);

    if (result.status === 'failed') {
      throw new BadRequestException({
        code:    'VTPASS_TOKEN_FAILED',
        message: data?.response_description ?? 'Token purchase failed via VTPass',
      });
    }

    // VTPass returns tokens array for result checker purchases
    const tokens: any[] = data.purchased_code
      ? [{ pin: data.purchased_code, serial: data.content?.transactions?.serial_number }]
      : (data.content?.transactions?.pins ?? []);

    return tokens.map((t: any) => ({
      tokenCode:    t.pin ?? t.token_code ?? t.tokenCode,
      serialNumber: t.serial ?? t.serial_number ?? requestId,
      expiresAt:    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      rawResponse:  t,
    }));
  }

  // ── Get variations (data bundles, cable bouquets) ─────────────

  async getVariations(serviceId: string): Promise<VtpassVariation[]> {
    const { data } = await this.http.get(`/service-variations?serviceID=${serviceId}`);
    return (data.content?.variations ?? []).map((v: any) => ({
      variationCode:   v.variation_code,
      name:            v.name,
      variationAmount: v.variation_amount,
      fixedPrice:      v.fixedPrice,
    }));
  }
  // ── Purchase airtime ──────────────────────────────────────────

  async buyAirtime(params: {
    serviceId:   string;   // 'mtn' | 'airtel' | 'glo' | '9mobile'
    phone:       string;
    amountNaira: number;
  }): Promise<VtpassBillResult> {
    const requestId = this.genRequestId();
    const { data }  = await this.http.post('/pay', {
      request_id:  requestId,
      serviceID:   params.serviceId,
      amount:      params.amountNaira,
      phone:       params.phone,
    });

    return this.parseBillResult(requestId, data);
  }

  // ── Purchase data bundle ──────────────────────────────────────

  async buyData(params: {
    serviceId:     string;   // 'mtn-data' | 'airtel-data' etc.
    phone:         string;
    variationCode: string;   // specific bundle code from getVariations()
    amountNaira:   number;
  }): Promise<VtpassBillResult> {
    const requestId = this.genRequestId();
    const { data }  = await this.http.post('/pay', {
      request_id:     requestId,
      serviceID:      params.serviceId,
      billersCode:    params.phone,
      variation_code: params.variationCode,
      amount:         params.amountNaira,
      phone:          params.phone,
    });

    return this.parseBillResult(requestId, data);
  }

  // ── Requery a transaction (for polling pending status) ────────

  async requery(requestId: string): Promise<VtpassBillResult> {
    const { data } = await this.http.post('/requery', { request_id: requestId });
    return this.parseBillResult(requestId, data);
  }

  // ── Internal helpers ──────────────────────────────────────────

  private parseBillResult(requestId: string, data: any, institutionName?: string): VtpassBillResult {
    const txnData = data.content?.transactions ?? {};
    const code    = data.code ?? txnData.status;

    // VTPass success codes
    const isDelivered = ['000', 'delivered'].includes(String(code));
    const isFailed    = ['099', 'failed'].includes(String(code));

    return {
      // requestId,
      reference:   data.requestId ?? requestId,
      status:      isDelivered ? 'delivered' : isFailed ? 'failed' : 'pending',
      productName: txnData.product_name ?? '',
      commission_rate: Number(txnData.commission_details?.rate ?? 0),
      quantity: txnData.quantity ,
      ...(txnData.type.toLowerCase() === "education" && institutionName==="WAEC" ? { 
        purchased_code: txnData.purchased_code,
        ...(txnData.tokens ? {
          token: txnData.tokens.map((t: any, i: number) => ({ transactionId: `${txnData.transactionId}$${i}`, token: t }),
        )
        }:{}),
        cards: (txnData.cards ?? []).map((p: any) => ({ pin: p.Pin, serial: p.Serial })),
       } : {}),
      ...(txnData.type.toLowerCase() === "education" && institutionName==="JAMB" ? { 
        purchased_code: txnData.purchased_code,
        pin: txnData.Pin ,
        } : {})
       };
    };
  

  private genRequestId(): string {
    // VTPass requires: datetime prefix + unique suffix, max 45 chars
    const ts  = new Date().toISOString().replace(/[-T:.Z]/g, '').substring(0, 14);
    const uid = uuid().replace(/-/g, '').substring(0, 10).toUpperCase();
    return `${ts}${uid}`;
  }
}