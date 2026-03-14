import { Controller, Get, Post, Put, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StudyMaterialsService, PurchaseMaterialDto, ProgressDto } from './study-materials.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Study Materials')
@Controller({ path: 'study-materials', version: '1' })
export class StudyMaterialsController {
  constructor(private svc: StudyMaterialsService) {}

  @Get() @Public() @ApiOperation({ summary: 'Browse study materials' })
  list(@Query() q: PaginationDto & { subject?: string; examType?: string; free?: string }) { return this.svc.list(q); }

  @Post(':id/purchase') @ApiBearerAuth('JWT') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Purchase a study material' })
  purchase(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PurchaseMaterialDto) { return this.svc.purchase(u.id, id, dto); }

  @Post(':id/access') @ApiBearerAuth('JWT') @HttpCode(HttpStatus.OK) @ApiOperation({ summary: 'Get signed download URL' })
  access(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.access(u.id, id); }

  @Put(':id/progress') @ApiBearerAuth('JWT') @ApiOperation({ summary: 'Update material progress' })
  progress(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ProgressDto) { return this.svc.updateProgress(u.id, id, dto); }
}
