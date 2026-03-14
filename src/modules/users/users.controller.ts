import { Controller, Get, Put, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService, UpdateProfileDto } from './users.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Users')
@ApiBearerAuth('JWT')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser() user: AuthUser) {
    return this.usersService.getProfile(user.id, user.email);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update user profile' })
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get user transaction history' })
  getTransactions(@CurrentUser() user: AuthUser, @Query() query: PaginationDto & { status?: string; type?: string }) {
    return this.usersService.getTransactions(user.id, query);
  }
}
