import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TokensService } from './tokens.service';
import { PurchaseTokensDto, ValidateTokenDto } from './tokens.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Tokens')
@Controller({ path: 'tokens', version: '1' })
export class TokensController {
  constructor(private tokensService: TokensService) {}

  @Get('institutions')
  @Public()
  @ApiOperation({ summary: 'Get all active institutions (WAEC, NECO, JAMB, NABTEB)' })
  getInstitutions() {
    return this.tokensService.getInstitutions();
  }

  @Post('purchase')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Purchase result checker tokens' })
  purchase(@CurrentUser() user: AuthUser, @Body() dto: PurchaseTokensDto) {
    return this.tokensService.purchase(user.id, dto);
  }

  @Get('my-tokens')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Get my purchased tokens' })
  getMyTokens(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationDto & { status?: string; institutionId?: string },
  ) {
    return this.tokensService.getMyTokens(user.id, query);
  }

  @Post('validate')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a result checker token' })
  validate(@CurrentUser() user: AuthUser, @Body() dto: ValidateTokenDto) {
    return this.tokensService.validate(user.id, dto);
  }
}
