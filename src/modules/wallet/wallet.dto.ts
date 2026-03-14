import { IsNumber, IsEnum, IsOptional, IsUrl, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum PaymentMethod {
  WALLET = 'WALLET',
  CARD = 'CARD',
  BANK_TRANSFER = 'BANK_TRANSFER',
  USSD = 'USSD',
}

export class FundWalletDto {
  @ApiProperty({ example: 10000 })
  @IsNumber()
  @Min(100, { message: 'Minimum funding amount is ₦100' })
  @Max(1000000)
  amount: number;

  @ApiProperty({ enum: ['CARD', 'BANK_TRANSFER', 'USSD'] })
  @IsEnum(['CARD', 'BANK_TRANSFER', 'USSD'])
  paymentMethod: 'CARD' | 'BANK_TRANSFER' | 'USSD';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  callbackUrl?: string;
}

export class PurchasePointsDto {
  @ApiProperty()
  packageId: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;
}
