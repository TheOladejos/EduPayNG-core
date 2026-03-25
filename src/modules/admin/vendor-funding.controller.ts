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
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from "@nestjs/swagger";
import {
  IsEnum,
  IsNumber,
  IsString,
  IsOptional,
  IsDateString,
  Min,
  IsIn,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  VendorFundingService,
  VendorName,
} from "../../common/services/vendor-funding.service";
import {
  CurrentUser as CurrentAdmin,
  AuthUser as AdminUser,
} from "../../common/decorators/current-user.decorator";
import { SetMetadata } from "@nestjs/common";

export const Roles = (...roles: string[]) => SetMetadata("roles", roles);

// ─── DTOs ─────────────────────────────────────────────────────

class RecordTopupDto {
  @ApiProperty({ enum: ["REMITA", "VTPASS"] })
  @IsIn(["REMITA", "VTPASS"])
  vendor: VendorName;

  @ApiProperty({ description: "Amount transferred in Naira", example: 100000 })
  @IsNumber()
  @Min(1000)
  amount: number;

  @ApiPropertyOptional({
    description: "Your bank's transaction reference",
    example: "NIP/TXN/12345",
  })
  @IsOptional()
  @IsString()
  bankReference?: string;

  @ApiProperty({
    description: "Date you initiated the transfer",
    example: "2024-03-15",
  })
  @IsDateString()
  transferDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

class ConfirmTopupDto {
  @ApiProperty({
    description: "Vendor balance AFTER the top-up was credited",
    example: 150000,
  })
  @IsNumber()
  @Min(0)
  balanceAfter: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

class UpdateThresholdDto {
  @ApiProperty({
    description: "Alert when balance falls below this (₦)",
    example: 50000,
  })
  @IsNumber()
  @Min(0)
  minBalance: number;

  @ApiProperty({
    description: "Block purchases when balance falls below this (₦)",
    example: 10000,
  })
  @IsNumber()
  @Min(0)
  criticalBalance: number;
}

// ─── Controller ────────────────────────────────────────────────

@ApiTags("Vendor Funding")
@ApiBearerAuth("AdminJWT")
@Controller({ path: "admin/vendor-funding", version: "1" })
export class VendorFundingController {
  constructor(private svc: VendorFundingService) {}

  // ── READ: Live balances + status ─────────────────────────────

  @Get("balances")
  @ApiOperation({
    summary: "Live Remita + VTPass prefund balances",
    description:
      `Shows live balance fetched directly from Remita and VTPass APIs, ` +
      `plus runway projection (how many days until balance runs out based on spend rate). ` +
      `\n\nIMPORTANT: You cannot top up via API. ` +
      `To add funds, make a bank transfer to the account details shown in GET /bank-accounts. ` +
      `Then record the transfer with POST /topups and confirm it with PATCH /topups/:id/confirm.`,
  })
  checkBalances() {
    return this.svc.checkLiveBalances();
  }

  @Get("balances/history")
  @ApiOperation({ summary: "Historical balance chart data for a vendor" })
  getBalanceHistory(
    @Query("vendor") vendor: VendorName,
    @Query("days") days?: number,
  ) {
    return this.svc.getBalanceHistory(vendor, days ? +days : 30);
  }

  // ── READ: Bank account details ───────────────────────────────

  @Get("bank-accounts")
  @ApiOperation({
    summary: "Bank accounts to send top-up transfers to",
    description:
      `Remita and VTPass prefund accounts can only be funded via bank transfer. ` +
      `This endpoint returns the bank account details and payment references for each vendor. ` +
      `Use NIP (instant) transfer for same-day crediting.`,
  })
  getBankAccounts() {
    return this.svc.getVendorBankAccounts();
  }

  // ── WRITE: Record a top-up you initiated ─────────────────────

  @Post("topups")
  @Roles("SUPER_ADMIN", "ADMIN", "FINANCE")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Record a bank transfer top-up you just initiated",
    description:
      `Call this immediately after you submit the bank transfer from your bank app. ` +
      `Status starts as INITIATED. ` +
      `After the vendor credits your account (usually within minutes for NIP), ` +
      `call PATCH /topups/:id/confirm to verify and close the record.`,
  })
  recordTopup(@Body() dto: RecordTopupDto, @CurrentAdmin() admin: AdminUser) {
    return this.svc.recordTopup(dto, admin.email);
  }

  // ── WRITE: Confirm a top-up after vendor balance increases ───

  @Patch("topups/:id/confirm")
  @Roles("SUPER_ADMIN", "ADMIN", "FINANCE")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Confirm a top-up after verifying the vendor balance increased",
    description:
      `After the bank transfer clears and you see the vendor balance has increased, ` +
      `call this with the new balance. The system will cross-check against the live API balance.`,
  })
  @ApiParam({
    name: "id",
    description: "Top-up record ID from POST /topups response",
  })
  confirmTopup(
    @Param("id") id: string,
    @Body() dto: ConfirmTopupDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.svc.confirmTopup(id, dto, admin.email);
  }

  // ── READ: Top-up history ─────────────────────────────────────

  @Get("topups")
  @ApiOperation({
    summary: "List all top-up records — full audit trail of transfers",
  })
  listTopups(
    @Query("vendor") vendor?: VendorName,
    @Query("limit") limit?: number,
  ) {
    return this.svc.listTopups(vendor, limit ? +limit : 50);
  }

  // ── WRITE: Update alert thresholds ───────────────────────────

  @Patch("thresholds/:vendor")
  @Roles("SUPER_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Update balance alert and block thresholds for a vendor",
    description:
      `minBalance: sends an alert when balance falls below this. ` +
      `criticalBalance: blocks new purchases when balance falls below this (auto-refunds users).`,
  })
  @ApiParam({ name: "vendor", enum: ["REMITA", "VTPASS"] })
  updateThreshold(
    @Param("vendor") vendor: VendorName,
    @Body() dto: UpdateThresholdDto,
  ) {
    return this.svc.updateThreshold(
      vendor,
      dto.minBalance,
      dto.criticalBalance,
    );
  }

  // ── Manual scheduled check (can also be triggered by cron) ──

  @Post("check")
  @Roles("SUPER_ADMIN", "ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Manually trigger a balance check and alert evaluation",
    description:
      "Same as the automated cron check — useful for testing alerts.",
  })
  runCheck() {
    return this.svc.scheduledCheck();
  }
}
