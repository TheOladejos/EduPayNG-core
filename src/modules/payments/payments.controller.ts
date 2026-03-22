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
  constructor(private svc: PaymentsService) {}

  @Post('verify')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify payment status by reference. Poll this after Paystack redirect.' })
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyDto) {
    return this.svc.verifyTransaction(user.id, dto.transactionReference);
  }

  // ── Paystack webhook — handles ALL payment events ─────────────
  // charge.success → wallet funding / token purchase / hybrid / points
  // charge.failed  → release hybrid wallet hold
  @Post('webhook/paystack')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async paystackWebhook(
    @Req() req: Request,
    @Headers('x-paystack-signature') sig: string,
  ) {
    try {
      const rawBody = (req as any).rawBody as Buffer;
      const payload = JSON.parse(rawBody.toString());

      if (payload.event === 'charge.success') {
        await this.svc.handlePaystackWebhook(rawBody, sig);
      } else if (payload.event === 'charge.failed') {
        await this.svc.handlePaystackChargeFailure(rawBody, sig);
      }
      // Return 200 for all events — Paystack will retry if we return non-200
      return { received: true };
    } catch (err) {
      this.logger.error('Paystack webhook error', err);
      return { received: true }; // still 200 to prevent retries on our own errors
    }
  }

  // ── VTPass webhook — async bill status reconciliation only ─────
  @Post('webhook/vtpass')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async vtpassWebhook(@Body() payload: any) {
    try {
      await this.svc.handleVtpassWebhook(payload);
      return { received: true };
    } catch (err) {
      this.logger.error('VTPass webhook error', err);
      return { received: true };
    }
  }
}