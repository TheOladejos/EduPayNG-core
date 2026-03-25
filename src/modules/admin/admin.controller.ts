import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  IsNumber,
  IsOptional,
  IsString,
  IsBoolean,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SettlementService } from "../../common/services/settlement.service";
import { RevenueService } from "../../common/services/revenue.service";
import { PricingService } from "../../common/services/pricing.service";
import { SupabaseService } from "../../common/supabase/supabase.service";
import {
  CurrentUser as CurrentAdmin,
  AuthUser as AdminUser,
} from "../../common/decorators/current-user.decorator";
import { RemitaService } from "@modules/payments/gateway/remita.gateway";
import { VtpassService } from "@modules/payments/gateway/vtPass.gateway";

const REMITA_MIN_BALANCE = 10_000;
const VTPASS_MIN_BALANCE = 5_000;

class RevenueQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() to?: string;
}

class UpdateTokenPriceDto {
  @ApiPropertyOptional({
    description: "Price you charge the student (₦)",
    example: 3500,
  })
  @IsOptional()
  @IsNumber()
  @Min(100)
  sellingPrice?: number;

  @ApiPropertyOptional({
    description:
      "What VTPass/Remita charges you (₦) — update only when exam body announces a change",
    example: 3000,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  vendorCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateBillMarginDto {
  @ApiProperty({ description: "Margin percentage e.g. 5 = 5%", example: 5 })
  @IsNumber()
  @Min(0)
  @Max(50)
  marginPct: number;

  @ApiPropertyOptional({
    description: "Optional flat naira fee on top",
    example: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  marginFlat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

@ApiTags("Admin")
@ApiBearerAuth("AdminJWT")
@Controller({ path: "admin", version: "1" })
export class AdminController {
  constructor(
    private settlement: SettlementService,
    private revenue: RevenueService,
    private pricing: PricingService,
    private remita: RemitaService,
    private vtpass: VtpassService,
    private supabase: SupabaseService,
  ) {}

  // ── Reconciliation ────────────────────────────────────────────

  @Get("reconciliation")
  @ApiOperation({
    summary: "Wallet reconciliation report — ledger_drift must always be 0",
  })
  getReconciliation() {
    return this.settlement.getReconciliation();
  }

  // ── Settlements ───────────────────────────────────────────────

  @Get("settlements/pending")
  @ApiOperation({ summary: "List all pending vendor payables" })
  getPendingSettlements(@Query("vendor") vendor?: string) {
    return this.settlement.getPendingSettlements(vendor as any);
  }

  @Get("settlements/summary")
  @ApiOperation({
    summary: "Vendor settlement summary (pending vs settled per vendor)",
  })
  getVendorSummary() {
    return this.settlement.getVendorSummary();
  }

  @Post("settlements/:id/settle")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Mark a settlement as paid to vendor" })
  markSettled(@Param("id") id: string, @CurrentAdmin() admin: AdminUser) {
    return this.settlement.markSettled(id, admin.email);
  }

  // ── Revenue ───────────────────────────────────────────────────

  @Get("revenue/summary")
  @ApiOperation({ summary: "Platform revenue — gross, cost, and net profit" })
  getRevenueSummary(@Query() query: RevenueQueryDto) {
    return this.revenue.getSummary(query.from, query.to);
  }

  // ── Vendor Balances ───────────────────────────────────────────

  @Get("vendor-balances")
  @ApiOperation({ summary: "Live Remita + VTPass prefund balances" })
  async getVendorBalances() {
    const [remitaBal, vtpassBal] = await Promise.all([
      this.remita.checkPrefundBalance(),
      this.vtpass.checkPrefundBalance(),
    ]);

    await this.supabase.admin.from("vendor_balance_log").insert([
      {
        vendor: "REMITA",
        balance: remitaBal.availableBalance,
        is_low: remitaBal.availableBalance < REMITA_MIN_BALANCE,
        threshold: REMITA_MIN_BALANCE,
      },
      {
        vendor: "VTPASS",
        balance: vtpassBal.balance,
        is_low: vtpassBal.balance < VTPASS_MIN_BALANCE,
        threshold: VTPASS_MIN_BALANCE,
      },
    ]);

    return {
      remita: {
        availableBalance: remitaBal.availableBalance,
        isLow: remitaBal.availableBalance < REMITA_MIN_BALANCE,
        status:
          remitaBal.availableBalance < REMITA_MIN_BALANCE ? "⚠️ LOW" : "✅ OK",
        usedFor: "NECO, NABTEB tokens",
      },
      vtpass: {
        availableBalance: vtpassBal.balance,
        isLow: vtpassBal.balance < VTPASS_MIN_BALANCE,
        status: vtpassBal.balance < VTPASS_MIN_BALANCE ? "⚠️ LOW" : "✅ OK",
        usedFor: "WAEC, JAMB tokens + all bills",
      },
      paystack: {
        note: "Settles to your bank T+1. Check dashboard.paystack.com.",
        usedFor: "Wallet funding",
      },
      checkedAt: new Date().toISOString(),
    };
  }

  @Get("vendor-balances/history")
  @ApiOperation({ summary: "Historical vendor balance log" })
  async getVendorBalanceHistory(
    @Query("vendor") vendor?: string,
    @Query("limit") limit = 50,
  ) {
    let q = this.supabase.admin
      .from("vendor_balance_log")
      .select("vendor, balance, is_low, threshold, checked_at")
      .order("checked_at", { ascending: false })
      .limit(limit);
    if (vendor) q = q.eq("vendor", vendor.toUpperCase());
    const { data } = await q;
    return data ?? [];
  }

  // ════════════════════════════════════════════════════════════════
  // PRICING MANAGEMENT
  // ════════════════════════════════════════════════════════════════

  // ── Token pricing ─────────────────────────────────────────────

  @Get("pricing/tokens")
  @ApiOperation({
    summary: "View token prices for all institutions",
    description:
      "Shows vendor_cost (what VTPass/Remita charges you — set by exam body) " +
      "and selling_price (what you charge the student — you control this). " +
      "Margin = selling_price - vendor_cost.",
  })
  getTokenPricing() {
    return this.pricing.getInstitutionPricing();
  }

  @Patch("pricing/tokens/:institutionId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Update token selling price or vendor cost",
    description:
      "Update sellingPrice when you want to change your margin. " +
      "Update vendorCost ONLY when WAEC/NECO/JAMB/NABTEB officially announce a price change " +
      "(check Remita/VTPass dashboards for confirmation). " +
      "Never raise vendorCost without confirming with your gateway first.",
  })
  updateTokenPrice(
    @Param("institutionId") id: string,
    @Body() dto: UpdateTokenPriceDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.pricing.updateInstitutionPricing(id, dto, admin.email);
  }

  // ── Bill product sync ─────────────────────────────────────────

  @Get("pricing/bills/products")
  @ApiOperation({
    summary: "View synced bill products (data bundles, cable bouquets)",
    description:
      "These prices come from VTPass — you do not set them. " +
      "The amount column shows the VTPass base price. " +
      "Your actual charge to user = base price × (1 + margin_pct/100).",
  })
  getBillProducts(@Query("billerId") billerId?: string) {
    return this.pricing.getBillProducts(billerId);
  }

  @Post("pricing/bills/sync")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "⟳ Sync bill products from VTPass",
    description:
      "Fetches latest data bundle and cable TV plans from VTPass API and updates your database. " +
      "Run this when:\n" +
      "• MTN/Airtel/Glo/9Mobile change their data bundle prices or plans\n" +
      "• DStv/GOtv/StarTimes change their bouquet prices\n" +
      "• You notice wrong prices being charged to users\n\n" +
      "Airtime and electricity are NOT synced (no fixed plans). " +
      "This may take 30–60 seconds to complete.",
  })
  syncBillProducts(@CurrentAdmin() admin: AdminUser) {
    return this.pricing.syncBillProductsFromVtpass(admin.email);
  }

  // ── Bill margin ───────────────────────────────────────────────

  @Get("pricing/bills/margins")
  @ApiOperation({
    summary: "View your margin config per bill category",
    description:
      "Your actual charge = VTPass base price × (1 + margin_pct/100) + margin_flat.\n" +
      "Example: MTN 1GB = ₦1,000 base, 5% margin → you charge ₦1,050.",
  })
  getBillMargins() {
    return this.pricing.getBillMargins();
  }

  @Patch("pricing/bills/margins/:categoryCode")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Update your margin for a bill category",
    description:
      "categoryCode: AIRTIME | DATA | ELECTRICITY | CABLE_TV\n" +
      "marginPct: 0-50 (percentage). Keep airtime/electricity ≤ 3% (industry norm). " +
      "Changes take effect immediately for new purchases.",
  })
  updateBillMargin(
    @Param("categoryCode") categoryCode: string,
    @Body() dto: UpdateBillMarginDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.pricing.updateBillMargin(
      categoryCode.toUpperCase(),
      dto,
      admin.email,
    );
  }
}
