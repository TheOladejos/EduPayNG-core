import { IsUUID, IsInt, IsEnum, IsString, Min, Max, IsOptional, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum DeliveryMethod { EMAIL = 'EMAIL', SMS = 'SMS', BOTH = 'BOTH' }
export enum TokenPaymentMethod { WALLET = 'WALLET', CARD = 'CARD', BANK_TRANSFER = 'BANK_TRANSFER', USSD = 'USSD' }

export class PurchaseTokensDto {
  @ApiProperty() @IsUUID() institutionId: string;
  @ApiProperty({ minimum: 1, maximum: 50 }) @IsInt() @Min(1) @Max(50) quantity: number;
  @ApiProperty({ enum: TokenPaymentMethod }) @IsEnum(TokenPaymentMethod) paymentMethod: TokenPaymentMethod;
  @ApiProperty({ enum: DeliveryMethod }) @IsEnum(DeliveryMethod) deliveryMethod: DeliveryMethod;
 @ApiProperty({ example: 500, minimum: 50, maximum: 50000 })
  @IsNumber()
  @Min(50, { message: 'Minimum airtime is ₦50' })
  @Max(50000)
  amount: number;
}

export class ValidateTokenDto {
  @ApiProperty({ example: 'WAE-12345-67890' }) @IsString() tokenCode: string;
  @ApiProperty({ example: 'SN-12345-67890' }) @IsString() serialNumber: string;
  @ApiPropertyOptional() @IsOptional() @IsString() examNumber?: string;
}
