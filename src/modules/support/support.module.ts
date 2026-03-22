import { Module } from "@nestjs/common";
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  IsString,
  IsEnum,
  IsOptional,
  MinLength,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SupabaseService } from "../../common/supabase/supabase.service";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";
import {
  CurrentUser,
  AuthUser,
} from "../../common/decorators/current-user.decorator";
import { generateTicketNumber } from "../../common/helpers/generators";

class CreateTicketDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(150) subject: string;
  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description: string;
  @ApiProperty({
    enum: ["BILLING", "TECHNICAL", "ACCOUNT", "TOKEN", "EXAM", "OTHER"],
  })
  @IsEnum(["BILLING", "TECHNICAL", "ACCOUNT", "TOKEN", "EXAM", "OTHER"])
  category: string;
  @ApiPropertyOptional({ enum: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM" })
  @IsOptional()
  @IsEnum(["LOW", "MEDIUM", "HIGH"])
  priority?: string = "MEDIUM";
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  transactionReference?: string;
}

class AddMessageDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2000) message: string;
}

@Injectable()
export class SupportService {
  constructor(private supabase: SupabaseService) {}

  async createTicket(userId: string, dto: CreateTicketDto) {
    const { data, error } = await this.supabase.admin
      .from("support_tickets")
      .insert({
        user_id: userId,
        ticket_number: generateTicketNumber(),
        subject: dto.subject,
        description: dto.description,
        category: dto.category,
        priority: dto.priority ?? "MEDIUM",
        status: "OPEN",
        metadata: { transactionReference: dto.transactionReference },
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return {
      id: data.id,
      ticketNumber: data.ticket_number,
      subject: data.subject,
      status: "OPEN",
      createdAt: data.created_at,
    };
  }

  async listTickets(
    userId: string,
    query: PaginationDto & { status?: string },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    let q = this.supabase.admin
      .from("support_tickets")
      .select(
        "id, ticket_number, subject, category, priority, status, created_at",
        { count: "exact" },
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (query.status) q = q.eq("status", query.status);
    const { data, count } = await q;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async getTicket(userId: string, ticketId: string) {
    const { data, error } = await this.supabase.admin
      .from("support_tickets")
      .select(
        "*, support_messages(id, sender_id, message, is_staff, created_at)",
      )
      .eq("id", ticketId)
      .eq("user_id", userId)
      .single();
    if (error || !data)
      throw new NotFoundException({
        code: "TICKET_NOT_FOUND",
        message: "Ticket not found",
      });
    return data;
  }

  async addMessage(userId: string, ticketId: string, dto: AddMessageDto) {
    const { data: ticket, error: ticketError } = await this.supabase.admin
      .from("support_tickets")
      .select("id, status")
      .eq("id", ticketId)
      .eq("user_id", userId)
      .single();
    if (ticketError || !ticket)
      throw new NotFoundException({
        code: "TICKET_NOT_FOUND",
        message: "Ticket not found",
      });
    if (ticket.status === "CLOSED")
      throw new BadRequestException({
        code: "TICKET_CLOSED",
        message: "Cannot reply to a closed ticket",
      });
    const { data, error } = await this.supabase.admin
      .from("support_messages")
      .insert({
        ticket_id: ticketId,
        sender_id: userId,
        message: dto.message,
        is_staff: false,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    if (ticket.status === "RESOLVED") {
      const { error: updateError } = await this.supabase.admin
        .from("support_tickets")
        .update({ status: "IN_PROGRESS" })
        .eq("id", ticketId);

        if(updateError) throw new BadRequestException(updateError.message)
    }
      return { id: data.id, message: data.message, createdAt: data.created_at };
  }
}

@ApiTags("Support")
@ApiBearerAuth("JWT")
@Controller({ path: "support/tickets", version: "1" })
export class SupportController {
  constructor(private svc: SupportService) {}
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a support ticket" })
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTicketDto) {
    return this.svc.createTicket(u.id, dto);
  }
  @Get()
  @ApiOperation({ summary: "List my support tickets" })
  list(
    @CurrentUser() u: AuthUser,
    @Query() q: PaginationDto & { status?: string },
  ) {
    return this.svc.listTickets(u.id, q);
  }
  @Get(":id")
  @ApiOperation({ summary: "Get ticket with messages" })
  getOne(@CurrentUser() u: AuthUser, @Param("id") id: string) {
    return this.svc.getTicket(u.id, id);
  }
  @Post(":id/messages")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Add message to ticket" })
  addMsg(
    @CurrentUser() u: AuthUser,
    @Param("id") id: string,
    @Body() dto: AddMessageDto,
  ) {
    return this.svc.addMessage(u.id, id, dto);
  }
}

@Module({ controllers: [SupportController], providers: [SupportService] })
export class SupportModule {}
