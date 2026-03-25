import { Module } from '@nestjs/common';
import { Controller, Get, Post, Patch, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsUrl, IsArray, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChargebackService, ChargebackEvidenceDto } from './chargeback.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentAdmin, AdminUser, AdminRoles } from '../admin.guard';
import { WalletModule } from '../../wallet/wallet.module';

class SubmitEvidenceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() transactionScreenshot?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() deliveryProof?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() customerAcknowledgment?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() additionalNotes?: string;
}

class UpdatePolicyDto {
  @ApiPropertyOptional({ description: 'Auto-accept chargebacks below this Naira amount' })
  @IsOptional() @IsNumber() @Min(0) autoAcceptBelow?: number;
  @ApiPropertyOptional({ description: 'Auto-suspend user after this many chargebacks' })
  @IsOptional() @IsNumber() @Min(1) autoSuspendAt?: number;
  @ApiPropertyOptional({ description: 'Flag user after this many chargebacks' })
  @IsOptional() @IsNumber() @Min(1) flagAt?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() evidenceTemplate?: string;
}

@ApiTags('Admin — Chargebacks')
@ApiBearerAuth('JWT')
@Controller({ path: 'admin/chargebacks', version: '1' })
export class ChargebackController {
  constructor(private svc: ChargebackService) {}

  @Get()
  @ApiOperation({ summary: 'List all chargebacks with status filter' })
  list(@Query() q: PaginationDto & { status?: string; userId?: string }) {
    return this.svc.list(q);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Chargeback stats — win rate, total exposure, counts by status' })
  stats() { return this.svc.getStats(); }

  @Get(':id')
  @ApiOperation({ summary: 'Get chargeback detail with full Paystack payload' })
  getOne(@Param('id') id: string) { return this.svc.getOne(id); }

  @Post(':id/evidence')
  @AdminRoles('SUPER_ADMIN', 'ADMIN', 'FINANCE')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit evidence for a chargeback to Paystack',
    description:
      'Evidence is submitted to Paystack to fight the dispute. ' +
      'Must be submitted before the response_deadline. ' +
      'Include transaction screenshots and delivery proof (token delivery confirmation emails, etc.)',
  })
  submitEvidence(
    @Param('id') id: string,
    @Body() dto: SubmitEvidenceDto,
    @CurrentAdmin() admin: AdminUser,
  ) { return this.svc.submitEvidence(id, dto, admin.email); }

  @Post(':id/accept')
  @AdminRoles('SUPER_ADMIN', 'ADMIN', 'FINANCE')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept / concede a chargeback',
    description:
      'Voluntarily accept the chargeback. ' +
      'Use this for small amounts or legitimate disputes where fighting is not worth it. ' +
      'The transaction will be marked CHARGEDBACK. ' +
      'If it was a WALLET_FUNDING transaction, the wallet balance will be reversed.',
  })
  accept(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    return this.svc.acceptChargeback(id, admin.email);
  }

  @Patch('policy')
  @AdminRoles('SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update chargeback automation policy',
    description:
      'autoAcceptBelow: auto-accept without fighting if amount < this (₦). ' +
      'autoSuspendAt: auto-suspend user if they have this many chargebacks. ' +
      'flagAt: flag user for manual review at this count. ' +
      'evidenceTemplate: default text submitted when auto-responding near deadline.',
  })
  updatePolicy(@Body() dto: UpdatePolicyDto) { return this.svc.updatePolicy(dto); }
}

@Module({
  imports:     [WalletModule],
  controllers: [ChargebackController],
  providers:   [ChargebackService],
  exports:     [ChargebackService],
})
export class ChargebackModule {}
