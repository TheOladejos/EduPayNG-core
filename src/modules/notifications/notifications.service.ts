import { Injectable } from '@nestjs/common';
import { Controller, Get, Put, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { paginate, PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@Injectable()
export class NotificationsService {
  constructor(private supabase: SupabaseService) {}

  async getNotifications(userId: string, query: PaginationDto & { isRead?: string; category?: string }) {
    const page = query.page ?? 1; const limit = query.limit ?? 20; const offset = (page - 1) * limit;
    let q = this.supabase.admin.from('notifications').select('*', { count: 'exact' })
      .eq('user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (query.isRead !== undefined) q = q.eq('is_read', query.isRead === 'true');
    if (query.category) q = q.eq('category', query.category);
    const { data, count } = await q;
    const { count: unread } = await this.supabase.admin.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false);
    return { ...paginate(data ?? [], count ?? 0, page, limit), unreadCount: unread ?? 0 };
  }

  async markRead(userId: string, notificationId: string) {
    await this.supabase.admin.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', notificationId).eq('user_id', userId);
    return { message: 'Marked as read' };
  }

  async markAllRead(userId: string) {
    await this.supabase.admin.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('user_id', userId).eq('is_read', false);
    return { message: 'All notifications marked as read' };
  }
}

@ApiTags('Notifications')
@ApiBearerAuth('JWT')
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get user notifications' })
  get(@CurrentUser() user: AuthUser, @Query() q: PaginationDto & { isRead?: string; category?: string }) {
    return this.svc.getNotifications(user.id, q);
  }

  @Put(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.markRead(user.id, id);
  }

  @Put('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.svc.markAllRead(user.id);
  }
}
