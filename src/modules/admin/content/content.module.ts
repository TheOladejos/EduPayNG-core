import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsEnum,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AdminRoles } from "../admin.guard";
import { SupabaseService } from "@common/supabase/supabase.service";
import { paginate, PaginationDto } from "@common/dto/pagination.dto";

// ── DTOs ─────────────────────────────────────────────────────

class ScholarshipDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() organization: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty() @IsNumber() @Min(0) amount: number;
  @ApiProperty() @IsDateString() applicationDeadline: string;
  @ApiProperty() @IsString() category: string;
  @ApiProperty() @IsString() level: string;
  @ApiPropertyOptional() @IsOptional() @IsString() requirements?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() applicationUrl?: string;
}

class StudyMaterialDto {
  @ApiProperty() @IsString() title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty() @IsString() subject: string;
  @ApiProperty() @IsString() examType: string;
  @ApiProperty() @IsNumber() @Min(0) price: number;
  @ApiProperty() @IsBoolean() isFree: boolean;
}

class AiCreditPackageDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsNumber() @Min(1) credits: number;
  @ApiProperty() @IsNumber() @Min(0) price: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  bonusCredits?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() displayOrder?: number;
}

class PointPackageDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsNumber() @Min(1) amount: number;
  @ApiProperty() @IsNumber() @Min(1) points: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  bonusPercentage?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
}

@Injectable()
export class AdminContentService {
  constructor(private supabase: SupabaseService) {}

  // ── Scholarships ──────────────────────────────────────────────
  async listScholarships(q: PaginationDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const offset = (page - 1) * limit;
    const { data, count } = await this.supabase.admin
      .from("scholarships")
      .select(
        "id, title, organization, amount, application_deadline, category, level, is_active, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    return paginate(data ?? [], count ?? 0, page, limit);
  }
  async createScholarship(dto: ScholarshipDto) {
    const { data, error } = await this.supabase.admin
      .from("scholarships")
      .insert({
        title: dto.title,
        organization: dto.organization,
        description: dto.description,
        amount: dto.amount,
        application_deadline: dto.applicationDeadline,
        category: dto.category,
        level: dto.level,
        requirements: dto.requirements,
        application_url: dto.applicationUrl,
        is_active: true,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }
  async updateScholarship(
    id: string,
    dto: Partial<ScholarshipDto> & { isActive?: boolean },
  ) {
    const updates: any = {};
    if (dto.title !== undefined) updates.title = dto.title;
    if (dto.organization !== undefined) updates.organization = dto.organization;
    if (dto.description !== undefined) updates.description = dto.description;
    if (dto.amount !== undefined) updates.amount = dto.amount;
    if (dto.applicationDeadline !== undefined)
      updates.application_deadline = dto.applicationDeadline;
    if (dto.requirements !== undefined) updates.requirements = dto.requirements;
    if (dto.isActive !== undefined) updates.is_active = dto.isActive;
    const { data, error } = await this.supabase.admin
      .from("scholarships")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new NotFoundException(error.message);
    return data;
  }
  async deleteScholarship(id: string) {
    await this.supabase.admin.from("scholarships").delete().eq("id", id);
    return { message: "Scholarship deleted" };
  }

  // ── Study Materials ───────────────────────────────────────────
  async listMaterials(q: PaginationDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const offset = (page - 1) * limit;
    const { data, count } = await this.supabase.admin
      .from("study_materials")
      .select(
        "id, title, subject, exam_type, price, is_free, is_published, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    return paginate(data ?? [], count ?? 0, page, limit);
  }
  async createMaterial(dto: StudyMaterialDto) {
    const { data, error } = await this.supabase.admin
      .from("study_materials")
      .insert({
        title: dto.title,
        description: dto.description,
        subject: dto.subject,
        exam_type: dto.examType,
        price: dto.price,
        is_free: dto.isFree,
        is_published: false,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }
  async toggleMaterialPublished(id: string) {
    const { data: m } = await this.supabase.admin
      .from("study_materials")
      .select("is_published")
      .eq("id", id)
      .single();
    if (!m) throw new NotFoundException("Material not found");
    const { data } = await this.supabase.admin
      .from("study_materials")
      .update({ is_published: !m.is_published })
      .eq("id", id)
      .select()
      .single();
    return data;
  }

  // ── AI Credit Packages ────────────────────────────────────────
  async listAiPackages() {
    const { data } = await this.supabase.admin
      .from("ai_credit_packages")
      .select("*")
      .order("display_order");
    return data ?? [];
  }
  async upsertAiPackage(dto: AiCreditPackageDto, id?: string) {
    const payload = {
      name: dto.name,
      credits: dto.credits,
      price: dto.price,
      bonus_credits: dto.bonusCredits ?? 0,
      description: dto.description,
      display_order: dto.displayOrder ?? 0,
    };
    const { data, error } = id
      ? await this.supabase.admin
          .from("ai_credit_packages")
          .update(payload)
          .eq("id", id)
          .select()
          .single()
      : await this.supabase.admin
          .from("ai_credit_packages")
          .insert(payload)
          .select()
          .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ── Point Packages ────────────────────────────────────────────
  async listPointPackages() {
    const { data } = await this.supabase.admin
      .from("point_packages")
      .select("*")
      .order("display_order");
    return data ?? [];
  }
  async upsertPointPackage(dto: PointPackageDto, id?: string) {
    const payload = {
      name: dto.name,
      amount: dto.amount,
      points: dto.points,
      bonus_percentage: dto.bonusPercentage ?? 0,
      description: dto.description,
    };
    const { data, error } = id
      ? await this.supabase.admin
          .from("point_packages")
          .update(payload)
          .eq("id", id)
          .select()
          .single()
      : await this.supabase.admin
          .from("point_packages")
          .insert(payload)
          .select()
          .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }
}

@ApiTags("Admin — Content")
@ApiBearerAuth("JWT")
@Controller({ path: "admin/content", version: "1" })
export class AdminContentController {
  constructor(private svc: AdminContentService) {}

  // Scholarships
  @Get("scholarships")
  @ApiOperation({
    summary: "List all scholarships (admin view, includes inactive)",
  })
  listScholarships(@Query() q: PaginationDto) {
    return this.svc.listScholarships(q);
  }
  @Post("scholarships")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create scholarship" })
  createScholarship(@Body() dto: ScholarshipDto) {
    return this.svc.createScholarship(dto);
  }
  @Put("scholarships/:id")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @ApiOperation({ summary: "Update scholarship" })
  updateScholarship(
    @Param("id") id: string,
    @Body() dto: Partial<ScholarshipDto> & { isActive?: boolean },
  ) {
    return this.svc.updateScholarship(id, dto);
  }
  @Delete("scholarships/:id")
  @AdminRoles("SUPER_ADMIN")
  @ApiOperation({ summary: "Delete scholarship" })
  deleteScholarship(@Param("id") id: string) {
    return this.svc.deleteScholarship(id);
  }

  // Study Materials
  @Get("materials")
  @ApiOperation({ summary: "List all study materials" })
  listMaterials(@Query() q: PaginationDto) {
    return this.svc.listMaterials(q);
  }
  @Post("materials")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create study material" })
  createMaterial(@Body() dto: StudyMaterialDto) {
    return this.svc.createMaterial(dto);
  }
  @Post("materials/:id/toggle")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Toggle material published status" })
  toggleMaterial(@Param("id") id: string) {
    return this.svc.toggleMaterialPublished(id);
  }

  // AI Credit Packages
  @Get("ai-packages")
  @ApiOperation({ summary: "List AI credit packages" })
  listAiPackages() {
    return this.svc.listAiPackages();
  }
  @Post("ai-packages")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create AI credit package" })
  createAiPackage(@Body() dto: AiCreditPackageDto) {
    return this.svc.upsertAiPackage(dto);
  }
  @Put("ai-packages/:id")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @ApiOperation({ summary: "Update AI credit package" })
  updateAiPackage(@Param("id") id: string, @Body() dto: AiCreditPackageDto) {
    return this.svc.upsertAiPackage(dto, id);
  }

  // Point Packages
  @Get("point-packages")
  @ApiOperation({ summary: "List point packages" })
  listPointPackages() {
    return this.svc.listPointPackages();
  }
  @Post("point-packages")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create point package" })
  createPointPackage(@Body() dto: PointPackageDto) {
    return this.svc.upsertPointPackage(dto);
  }
  @Put("point-packages/:id")
  @AdminRoles("SUPER_ADMIN", "ADMIN")
  @ApiOperation({ summary: "Update point package" })
  updatePointPackage(@Param("id") id: string, @Body() dto: PointPackageDto) {
    return this.svc.upsertPointPackage(dto, id);
  }
}
