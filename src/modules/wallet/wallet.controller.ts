import { Controller, Get, Post, Body, Query, Version } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { FundWalletDto, PurchasePointsDto } from './wallet.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Wallet')
@ApiBearerAuth('JWT')
@Controller({ path: 'wallet', version: '1' })
export class WalletController {
  constructor(private walletService: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Get wallet balance and stats' })
  getWallet(@CurrentUser() user: AuthUser) {
    return this.walletService.getWallet(user.id);
  }

  @Post('fund')
  @ApiOperation({ summary: 'Initiate wallet funding via Remita' })
  fundWallet(@CurrentUser() user: AuthUser, @Body() dto: FundWalletDto) {
    return this.walletService.fundWallet(user.id, dto);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get wallet transaction history' })
  @ApiQuery({ name: 'type', required: false, enum: ['CREDIT', 'DEBIT'] })
  getTransactions(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationDto & { type?: string },
  ) {
    return this.walletService.getTransactions(user.id, query);
  }

  @Get('point-packages')
  @Public()
  @ApiOperation({ summary: 'Get available point packages' })
  getPointPackages() {
    return this.walletService.getPointPackages();
  }

  @Post('purchase-points')
  @ApiOperation({ summary: 'Purchase a point package' })
  purchasePoints(@CurrentUser() user: AuthUser, @Body() dto: PurchasePointsDto) {
    return this.walletService.purchasePoints(user.id, dto);
  }
}
