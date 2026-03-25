import {
  Injectable,
  Logger,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";
import { v4 as uuid } from "uuid";

export interface VtpassBillResult {
  reference: string;
  status: "delivered" | "failed" | "pending";
  token?: Array<{ transactionId: string; token: string }>; // for exam tokens
  quantity?: string;
  productName: string;
  purchased_code?: string;
  Pin?: string;
  cards?: { pin: string; serial: string }[]; // for exam tokens
  commission_rate: number; // for bills with variable commission
}

export interface VtpassVariation {
  variationCode: string;
  name: string;
  variationAmount: string;
  fixedPrice: string;
}

@Injectable()
export class VtpassService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VtpassService.name);
  private readonly http: AxiosInstance;
  private readonly TOP_SERVICES = ["mtn-data", "airtel-data"];
  private readonly variationsCache = new Map<
    string,
    { data: any[]; timestamp: number }
  >();
  private readonly CACHE_TTL = 3600 * 1000;
  private cleanupInterval: NodeJS.Timeout;

  constructor(private config: ConfigService) {
    const apiKey = config.getOrThrow("VTPASS_API_KEY");
    const pubKey = config.getOrThrow("VTPASS_PUBLIC_KEY");
    const baseUrl = config.getOrThrow("VTPASS_BASE_URL");

    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        "api-key": apiKey,
        "public-key": pubKey,
        "Content-Type": "application/json",
      },
      timeout: 30000, // Bills can be slow — 30s
    });
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.logger.log("Cleaned up Bills Cache interval.");
    }
  }

  async onModuleInit() {
    this.logger.log("Priming Bills Cache for top services...");

    const primingTasks = this.TOP_SERVICES.map((id) =>
      this.refreshVariations(id),
    );

    await Promise.allSettled(primingTasks);

    this.logger.log("Bills Cache Priming complete.");

    this.cleanupInterval = setInterval(
      () => this.pruneStaleCache(),
      30 * 60 * 1000,
    );
  }

  // ── Check your VTPass prefund wallet balance ──────────────────
  // VTPass is prepaid — you must top up before users can buy bills.
  // Call this from a scheduled job. Alert when balance is low.

  async checkPrefundBalance(): Promise<{ balance: number; currency: string }> {
    try {
      const { data } = await this.http.get("/balance");
      return {
        balance: Number(data.contents?.balance ?? 0),
        currency: "NGN",
      };
    } catch (err) {
      this.logger.error("VTPass balance check failed", err);
      return { balance: -1, currency: "NGN" };
    }
  }

  // ── Verify exam profile ID (JAMB PROFILE CODE) ─────────────────────────

      async verifyProfileID(dto: {
    serviceID: string; // 'waec' or 'jamb'
    profileID: string; // candidate's registration number
    variationCode: string; // e.g. 'utme-mock' or 'utme-no-mock'
  }): Promise<{ isValid: boolean; name: string | null }> {
     const { data } = await this.http.post("/merchant-verify", {
      billersCode: dto.profileID,
      serviceID: dto.serviceID,
      type: dto.variationCode,
     })
      return {
        isValid: data.code === "000",
        name: data.content?.Customer_Name ?? null,
      }
  }


  // ── Purchase exam token via VTPass (WAEC, JAMB) ──────────────
  // VTPass supports WAEC and JAMB result checker token purchases
  // via their educational services API.

  async purchaseToken(params: {
    serviceId: string; // VTPass serviceID e.g. 'waec', 'jamb'
    quantity: number;
    reference: string;
    phone: string;
    variationCode?: string; // e.g. 'utme-mock' or 'utme-no-mock'
    amountNaira?: number; // optional, only needed if you want to specify a custom amount instead of the default for the variation
    institutionName?: string; // for logging only
  }) {
    const requestId = this.genRequestId(); 

    const { data } = await this.http.post("/pay", {
      request_id: requestId,
      serviceID: params.serviceId,
      variation_code: params.variationCode, // use cached variation code if available, otherwise fallback to provided one
      amount: params.amountNaira,  // amount is fixed by VTPass for tokens/ default price
      phone: params.phone,
      quantity: params.quantity,
    });

    const result = this.parseBillResult(
      requestId,
      data,
      params.institutionName,
    );

    if (result.status === "failed") {
      throw new BadRequestException({
        code: "VTPASS_TOKEN_FAILED",
        message:
          data?.response_description ?? "Token purchase failed via VTPass",
      });
    }


    return result;
  }

  async clearVariationsCache(serviceId: string) {
    this.variationsCache.delete(serviceId);
    this.logger.log("Variation cache cleared manually.");
    return { message: "Cache cleared" };
  }
  // ── Get variations (data bundles, cable bouquets) ─────────────

  async getVariations(serviceId: string): Promise<VtpassVariation[]> {
    const cached = this.variationsCache.get(serviceId);
    const now = Date.now();

    // 1. If no cache exists at all, we MUST wait for the API (First time only)
    if (!cached) {
      if (this.variationsCache.size >= 4) {
        this.makeRoomInCache();
      }
      return await this.refreshVariations(serviceId);
    }

    // 2. Check if the cache is expired
    const isExpired = now - cached.timestamp > this.CACHE_TTL;

    if (isExpired) {
      this.logger.log(
        `Cache stale for ${serviceId}. Triggering background refresh...`,
      );

      // 3. THE MAGIC: Fire and forget. We DON'T 'await' this.
      // This updates the cache in the background while the current user gets instant data.
      this.refreshVariations(serviceId).catch((err) =>
        this.logger.error(
          `Background refresh failed for ${serviceId}: ${err.message}`,
        ),
      );
    }
    return cached.data;
  }
  // ── Purchase airtime ──────────────────────────────────────────

  async buyAirtime(params: {
    serviceId: string; // 'mtn' | 'airtel' | 'glo' | '9mobile'
    phone: string;
    amountNaira: number;
  }): Promise<VtpassBillResult> {
    const requestId = this.genRequestId();
    const { data } = await this.http.post("/pay", {
      request_id: requestId,
      serviceID: params.serviceId,
      amount: params.amountNaira,
      phone: params.phone,
    });

    return this.parseBillResult(requestId, data);
  }

  // ── Purchase data bundle ──────────────────────────────────────

  async buyData(params: {
    serviceId: string; // 'mtn-data' | 'airtel-data' etc.
    phone: string;
    variationCode: string; // specific bundle code from getVariations()
    amountNaira: number;
  }): Promise<VtpassBillResult> {
    const requestId = this.genRequestId();
    const { data } = await this.http.post("/pay", {
      request_id: requestId,
      serviceID: params.serviceId,
      billersCode: params.phone,
      variation_code: params.variationCode,
      amount: params.amountNaira,
      phone: params.phone,
    });

    return this.parseBillResult(requestId, data);
  }

  // ── Requery a transaction (for polling pending status) ────────

  async requery(requestId: string): Promise<VtpassBillResult> {
    const { data } = await this.http.post("/requery", {
      request_id: requestId,
    });
    return this.parseBillResult(requestId, data);
  }

  // ── Internal helpers ──────────────────────────────────────────

  private parseBillResult(
    requestId: string,
    data: any,
    institutionName?: string,
  ): VtpassBillResult {
    const txnData = data.content?.transactions ?? {};
    const code = data.code ?? txnData.status;

    // VTPass success codes
    const isDelivered = ["000", "delivered"].includes(String(code));
    const isFailed = ["099", "failed"].includes(String(code));

    return {
      // requestId,
      reference: data.requestId ?? requestId,
      status: isDelivered ? "delivered" : isFailed ? "failed" : "pending",
      productName: txnData.product_name ?? "",
      commission_rate: Number(txnData.commission_details?.rate ?? 0),
      quantity: txnData.quantity,
      ...(txnData.type.toLowerCase() === "education" &&
      institutionName === "WAEC"
        ? {
            purchased_code: txnData.purchased_code,
            ...(txnData.tokens
              ? {
                  token: txnData.tokens.map((t: any, i: number) => ({
                    transactionId: `${txnData.transactionId}$${i}`,
                    token: t,
                  })),
                }
              : {}),
            cards: (txnData.cards ?? []).map((p: any) => ({
              pin: p.Pin,
              serial: p.Serial,
            })),
          }
        : {}),
      ...(txnData.type.toLowerCase() === "education" &&
      institutionName === "JAMB"
        ? {
            purchased_code: txnData.purchased_code,
            pin: txnData.Pin,
          }
        : {}),
    };
  }

  private async refreshVariations(
    serviceId: string,
  ): Promise<VtpassVariation[]> {
    const { data } = await this.http.get(
      `/service-variations?serviceID=${serviceId}`,
    );
    const variations = (data.content?.variations ?? []).map((v: any) => ({
      variationCode: v.variation_code,
      name: v.name,
      variationAmount: v.variation_amount,
      fixedPrice: v.fixedPrice,
    }));

    this.variationsCache.set(serviceId, {
      data: variations,
      timestamp: Date.now(),
    });

    return variations;
  }

  private makeRoomInCache() {
    const oldestKey = this.variationsCache.keys().next().value;
    if (oldestKey) {
      this.variationsCache.delete(oldestKey);
      this.logger.debug(`Cache full. Evicted oldest entry: ${oldestKey}`);
    }
  }

  private pruneStaleCache() {
    const now = Date.now();
    let count = 0;

    for (const [key, value] of this.variationsCache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.variationsCache.delete(key);
        count++;
      }
    }

    if (count > 0) {
      this.logger.log(
        `Maintenance: Pruned ${count} stale entries from variationsCache.`,
      );
    }
  }

  private genRequestId(): string {
    // VTPass requires: datetime prefix + unique suffix, max 45 chars
    const ts = new Date()
      .toISOString()
      .replace(/[-T:.Z]/g, "")
      .substring(0, 14);
    const uid = uuid().replace(/-/g, "").substring(0, 10).toUpperCase();
    return `${ts}${uid}`;
  }
}
