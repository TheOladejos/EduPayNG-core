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
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ApiProperty } from "@nestjs/swagger";
import { SupabaseService } from "../../common/supabase/supabase.service";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";
import {
  CurrentUser,
  AuthUser,
} from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";

class ApplyScholarshipDto {
  @ApiProperty()
  applicationData: {
    personalStatement: string;
    academicRecords?: Record<string, any>;
    references?: string[];
  };
}

@Injectable()
export class ScholarshipsService {
  constructor(private supabase: SupabaseService) {}

  async list(query: PaginationDto & { category?: string; level?: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    let q = this.supabase.admin
      .from("scholarships")
      .select(
        "id, title, organization, description, amount, application_deadline, category, level, logo_url",
        { count: "exact" },
      )
      .eq("is_active", true)
      .gte("application_deadline", new Date().toISOString())
      .order("application_deadline", { ascending: true })
      .range(offset, offset + limit - 1);
    if (query.category) q = q.eq("category", query.category);
    if (query.level) q = q.eq("level", query.level);
    const { data, count } = await q;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async apply(userId: string, scholarshipId: string, dto: ApplyScholarshipDto) {
    const { data: s } = await this.supabase.admin
      .from("scholarships")
      .select("*")
      .eq("id", scholarshipId)
      .eq("is_active", true)
      .single();
    if (!s)
      throw new NotFoundException({
        code: "SCHOLARSHIP_NOT_FOUND",
        message: "Scholarship not found",
      });
    if (new Date(s.application_deadline) < new Date())
      throw new BadRequestException({
        code: "DEADLINE_PASSED",
        message: "Application deadline passed",
      });
    const { data: ex } = await this.supabase.admin
      .from("scholarship_applications")
      .select("id")
      .eq("user_id", userId)
      .eq("scholarship_id", scholarshipId)
      .maybeSingle();
    if (ex)
      throw new ConflictException({
        code: "ALREADY_APPLIED",
        message: "Already applied",
      });
    const { data, error } = await this.supabase.admin
      .from("scholarship_applications")
      .insert({
        user_id: userId,
        scholarship_id: scholarshipId,
        application_data: dto.applicationData,
        status: "SUBMITTED",
        submitted_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return {
      id: data.id,
      scholarshipTitle: s.title,
      status: "SUBMITTED",
      submittedAt: data.submitted_at,
    };
  }

  async myApplications(userId: string) {
    const { data } = await this.supabase.admin
      .from("scholarship_applications")
      .select("*, scholarships(title, organization)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    return data ?? [];
  }
}

@ApiTags("Scholarships")
@Controller({ path: "scholarships", version: "1" })
export class ScholarshipsController {
  constructor(private svc: ScholarshipsService) {}
  @Get()
  @Public()
  @ApiOperation({ summary: "Browse available scholarships" })
  list(@Query() q: PaginationDto & { category?: string; level?: string }) {
    return this.svc.list(q);
  }
  @Post(":id/apply")
  @ApiBearerAuth("JWT")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Apply for a scholarship" })
  apply(
    @CurrentUser() u: AuthUser,
    @Param("id") id: string,
    @Body() dto: ApplyScholarshipDto,
  ) {
    return this.svc.apply(u.id, id, dto);
  }
  @Get("my-applications")
  @ApiBearerAuth("JWT")
  @ApiOperation({ summary: "Get my scholarship applications" })
  mine(@CurrentUser() u: AuthUser) {
    return this.svc.myApplications(u.id);
  }
}

@Module({
  controllers: [ScholarshipsController],
  providers: [ScholarshipsService],
})
export class ScholarshipsModule {}
