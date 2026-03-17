import {
  IsUUID, IsString, IsNumber, IsEnum,
  Min, Max, Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum BillPaymentMethod {
  WALLET = 'WALLET',
}

// ── Airtime ──────────────────────────────────────────────────

export class BuyAirtimeDto {
  @ApiProperty({ description: 'Biller name from GET /bills/billers?category=AIRTIME' })
  @IsString()
  billerId: string;

  @ApiProperty({ example: '08012345678' })
  @IsString()
  @Matches(/^0[7-9][01]\d{8}$/, { message: 'Invalid Nigerian phone number' })
  phone: string;

  @ApiProperty({ example: 500, minimum: 50, maximum: 50000 })
  @IsNumber()
  @Min(50, { message: 'Minimum airtime is ₦50' })
  @Max(50000)
  amount: number;

  @ApiProperty({ enum: BillPaymentMethod, default: 'WALLET' })
  @IsEnum(BillPaymentMethod)
  paymentMethod: BillPaymentMethod;
}

// ── Data Bundle ───────────────────────────────────────────────

export class BuyDataDto {
  @ApiProperty({ description: 'Biller UUID from GET /bills/billers?category=DATA' })
  @IsUUID()
  billerId: string;

  @ApiProperty({ example: '08012345678' })
  @IsString()
  @Matches(/^0[7-9][01]\d{8}$/, { message: 'Invalid Nigerian phone number' })
  phone: string;

  @ApiProperty({ description: 'Product UUID from GET /bills/products?billerId=xxx' })
  @IsUUID()
  productId: string;

  @ApiProperty({ enum: BillPaymentMethod, default: 'WALLET' })
  @IsEnum(BillPaymentMethod)
  paymentMethod: BillPaymentMethod;
}