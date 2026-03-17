import { Controller, Post, Get, Body, Headers, Req, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiExcludeEndpoint } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './services/payments.service';

class VerifyDto { @ApiProperty() @IsString() transactionReference: string; }

@ApiTags('Payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);
  constructor(private paymentsService: PaymentsService) {}

  @Post('verify')
  @ApiBearerAuth('JWT') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify payment status by transaction reference' })
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyDto) {
    return this.paymentsService.verifyTransaction(user.id, dto.transactionReference);
  }

  // Paystack webhook — receives raw body for signature verification
  @Post('webhook/paystack')
  @Public() @HttpCode(HttpStatus.OK) @ApiExcludeEndpoint()
  async paystackWebhook(@Req() req: Request, @Headers('x-paystack-signature') sig: string) {
    try {
      const rawBody = (req as any).rawBody as Buffer;
      await this.paymentsService.handlePaystackWebhook(rawBody, sig);
      return { received: true };
    } catch (err) { this.logger.error('Paystack webhook error', err); return { received: false }; }
  }

  // Remita webhook — token card payments
  @Post('webhook/remita')
  @Public() @HttpCode(HttpStatus.OK) @ApiExcludeEndpoint()
  async remitaWebhook(@Body() payload: any, @Headers('x-remita-signature') sig: string) {
    try {
      await this.paymentsService.handleRemitaWebhook(payload, sig);
      return { received: true };
    } catch (err) { this.logger.error('Remita webhook error', err); return { received: false }; }
  }

  // VTPass webhook — bill async status reconciliation
  @Post('webhook/vtpass')
  @Public() @HttpCode(HttpStatus.OK) @ApiExcludeEndpoint()
  async vtpassWebhook(@Body() payload: any) {
    try {
      await this.paymentsService.handleVtpassWebhook(payload);
      return { received: true };
    } catch (err) { this.logger.error('VTPass webhook error', err); return { received: false }; }
  }
}