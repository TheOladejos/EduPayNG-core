import { Module } from '@nestjs/common';
import { Controller, Get, Post, Delete, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsUUID, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { paginate, PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class CreateBookmarkDto {
  @ApiProperty({ enum: ['COURSE','UNIVERSITY','MATERIAL','SCHOLARSHIP','ARTICLE'] })
  @IsEnum(['COURSE','UNIVERSITY','MATERIAL','SCHOLARSHIP','ARTICLE']) itemType: string;
  @ApiProperty() @IsUUID() itemId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

@Injectable()
export class BookmarksService {
  constructor(private supabase: SupabaseService) {}
  async create(userId: string, dto: CreateBookmarkDto) {
    const { data: ex } = await this.supabase.admin.from('user_bookmarks').select('id').eq('user_id', userId).eq('item_type', dto.itemType).eq('item_id', dto.itemId).maybeSingle();
    if (ex) throw new ConflictException({ code: 'ALREADY_BOOKMARKED', message: 'Already bookmarked' });
    const { data, error } = await this.supabase.admin.from('user_bookmarks').insert({ user_id: userId, item_type: dto.itemType, item_id: dto.itemId, notes: dto.notes }).select().single();
    if (error) throw new ConflictException(error.message);
    return { id: data.id, ...dto, createdAt: data.created_at };
  }
  async list(userId: string, query: PaginationDto & { itemType?: string }) {
    const page = query.page ?? 1; const limit = query.limit ?? 20; const offset = (page - 1) * limit;
    let q = this.supabase.admin.from('user_bookmarks').select('*', { count: 'exact' }).eq('user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (query.itemType) q = q.eq('item_type', query.itemType);
    const { data, count } = await q;
    return paginate(data ?? [], count ?? 0, page, limit);
  }
  async remove(userId: string, bookmarkId: string) {
    await this.supabase.admin.from('user_bookmarks').delete().eq('id', bookmarkId).eq('user_id', userId);
    return { message: 'Bookmark removed' };
  }
}

@ApiTags('Bookmarks')
@ApiBearerAuth('JWT')
@Controller({ path: 'bookmarks', version: '1' })
export class BookmarksController {
  constructor(private svc: BookmarksService) {}
  @Post() @HttpCode(HttpStatus.CREATED) @ApiOperation({ summary: 'Create bookmark' })
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateBookmarkDto) { return this.svc.create(u.id, dto); }
  @Get() @ApiOperation({ summary: 'Get my bookmarks' })
  list(@CurrentUser() u: AuthUser, @Query() q: PaginationDto & { itemType?: string }) { return this.svc.list(u.id, q); }
  @Delete(':id') @ApiOperation({ summary: 'Remove bookmark' })
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.remove(u.id, id); }
}

@Module({ controllers: [BookmarksController], providers: [BookmarksService] })
export class BookmarksModule {}
