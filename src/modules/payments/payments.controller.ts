import { Controller, Post, Body, Headers, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiExcludeEndpoint } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

class VerifyDto {
  @ApiProperty() @IsString() transactionReference: string;
}

@ApiTags('Payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private paymentsService: PaymentsService) {}

  @Post('verify')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify payment status by transaction reference' })
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyDto) {
    return this.paymentsService.verifyTransaction(user.id, dto.transactionReference);
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint() // Don't show in Swagger
  async webhook(
    @Body() payload: any,
    @Headers('x-remita-signature') signature: string,
  ) {
    try {
      await this.paymentsService.handleWebhook(payload, signature);
      return { received: true };
    } catch (err) {
      this.logger.error('Webhook error', err);
      return { received: false };
    }
  }
}
