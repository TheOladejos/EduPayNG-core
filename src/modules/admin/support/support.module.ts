import { Injectable, NotFoundException } from "@nestjs/common";
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { IsString, IsEnum, IsOptional, IsUUID } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CurrentAdmin, AdminUser } from "../admin.guard";
import { SupabaseService } from "@common/supabase/supabase.service";
import { paginate, PaginationDto } from "@common/dto/pagination.dto";

class ReplyDto {
  @ApiProperty() @IsString() message: string;
}
class UpdateTicketDto {
  @ApiPropertyOptional({ enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] })
  @IsOptional()
  @IsEnum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"])
  status?: string;
  @ApiPropertyOptional({ description: "Admin user ID to assign to" })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

@Injectable()
export class AdminSupportService {
  constructor(private supabase: SupabaseService) {}

  async listTickets(
    q: PaginationDto & {
      status?: string;
      category?: string;
      priority?: string;
      assignedTo?: string;
    },
  ) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const offset = (page - 1) * limit;
    let query = this.supabase.admin
      .from("support_tickets")
      .select(
        "id, ticket_number, subject, category, priority, status, created_at, updated_at, user_id, assigned_to, metadata",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (q.status) query = query.eq("status", q.status);
    if (q.category) query = query.eq("category", q.category);
    if (q.priority) query = query.eq("priority", q.priority);
    if (q.assignedTo) query = query.eq("assigned_to", q.assignedTo);
    const { data, count } = await query;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async getTicket(id: string) {
    const { data, error } = await this.supabase.admin
      .from("support_tickets")
      .select(
        "*, support_messages(id, sender_id, message, is_staff, created_at)",
      )
      .eq("id", id)
      .single();
    if (error || !data) throw new NotFoundException("Ticket not found");
    return data;
  }

  async replyAsStaff(ticketId: string, message: string, adminId: string) {
    const { data: ticket } = await this.supabase.admin
      .from("support_tickets")
      .select("id, status")
      .eq("id", ticketId)
      .single();
    if (!ticket) throw new NotFoundException("Ticket not found");
    const { data } = await this.supabase.admin
      .from("support_messages")
      .insert({
        ticket_id: ticketId,
        sender_id: adminId,
        message,
        is_staff: true,
      })
      .select()
      .single();
    if (ticket.status === "OPEN")
      await this.supabase.admin
        .from("support_tickets")
        .update({ status: "IN_PROGRESS", updated_at: new Date().toISOString() })
        .eq("id", ticketId);
    return {
      id: data!.id,
      message: data!.message,
      isStaff: true,
      createdAt: data!.created_at,
    };
  }

  async updateTicket(id: string, dto: UpdateTicketDto, adminEmail: string) {
    const updates: any = { updated_at: new Date().toISOString() };
    if (dto.status) updates.status = dto.status;
    if (dto.assignedTo) updates.assigned_to = dto.assignedTo;
    if (dto.notes) updates.metadata = { notes: dto.notes };
    await this.supabase.admin
      .from("support_tickets")
      .update(updates)
      .eq("id", id);
    await this.supabase.admin
      .from("audit_logs")
      .insert({
        action: "TICKET_UPDATED",
        resource_type: "SUPPORT_TICKET",
        resource_id: id,
        metadata: { updates, by: adminEmail },
      });
    return { message: "Ticket updated" };
  }

  async getStats() {
    const { data } = await this.supabase.admin
      .from("support_tickets")
      .select("status, priority, category");
    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const t of data ?? []) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
    }
    return { byStatus, byCategory, total: (data ?? []).length };
  }
}

@ApiTags("Admin — Support")
@ApiBearerAuth("JWT")
@Controller({ path: "admin/support", version: "1" })
export class AdminSupportController {
  constructor(private svc: AdminSupportService) {}

  @Get("tickets")
  @ApiOperation({ summary: "List all support tickets with filters" })
  list(
    @Query()
    q: PaginationDto & {
      status?: string;
      category?: string;
      priority?: string;
      assignedTo?: string;
    },
  ) {
    return this.svc.listTickets(q);
  }

  @Get("tickets/stats")
  @ApiOperation({ summary: "Ticket stats by status and category" })
  stats() {
    return this.svc.getStats();
  }

  @Get("tickets/:id")
  @ApiOperation({ summary: "Get ticket with full message history" })
  getOne(@Param("id") id: string) {
    return this.svc.getTicket(id);
  }

  @Post("tickets/:id/reply")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Reply to ticket as staff" })
  reply(
    @Param("id") id: string,
    @Body() dto: ReplyDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.svc.replyAsStaff(id, dto.message, admin.id);
  }

  @Patch("tickets/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update ticket status, assignment, notes" })
  update(
    @Param("id") id: string,
    @Body() dto: UpdateTicketDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.svc.updateTicket(id, dto, admin.email);
  }
}
