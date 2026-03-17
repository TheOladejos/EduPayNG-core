import {
  Controller, Get, Post, Body, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { BillsService } from './bills.services';
import {
  BuyAirtimeDto, BuyDataDto,
} from './bills.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Bills')
@Controller({ path: 'bills', version: '1' })
export class BillsController {
  constructor(private billsService: BillsService) {}

  // ── Catalog (public) ──────────────────────────────────────────

  @Get('categories')
  @Public()
  @ApiOperation({ summary: 'List bill categories (Airtime, Data)' })
  getCategories() {
    return this.billsService.getCategories();
  }

  @Get('billers')
  @Public()
  @ApiQuery({ name: 'category', required: false, enum: ['AIRTIME','DATA'] })
  @ApiOperation({ summary: 'List billers, optionally filtered by category' })
  getBillers(@Query('category') category?: string) {
    return this.billsService.getBillers(category);
  }

  @Get('products')
  @Public()
  @ApiQuery({ name: 'billerId', required: true })
  @ApiOperation({ summary: 'List products/bundles for a biller (data bundles)' })
  getProducts(@Query('billerId') billerId: string) {
    return this.billsService.getProducts(billerId);
  }
  
  // ── Purchases (authenticated) ─────────────────────────────────

  @Post('airtime')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buy airtime — deducted instantly from wallet' })
  buyAirtime(@CurrentUser() user: AuthUser, @Body() dto: BuyAirtimeDto) {
    return this.billsService.buyAirtime(user.id, dto);
  }

  @Post('data')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buy data bundle — deducted instantly from wallet' })
  buyData(@CurrentUser() user: AuthUser, @Body() dto: BuyDataDto) {
    return this.billsService.buyData(user.id, dto);
  }
  // ── History ───────────────────────────────────────────────────

  @Get('history')
  @ApiBearerAuth('JWT')
  @ApiQuery({ name: 'category', required: false })
  @ApiOperation({ summary: 'Get my bill payment history' })
  getHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationDto & { categoryCode?: string },
  ) {
    return this.billsService.getMyBillHistory(user.id, query);
  }
} 