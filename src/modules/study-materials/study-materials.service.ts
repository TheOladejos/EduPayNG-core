import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { IsEnum, IsNumber, IsOptional, Min, Max } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SupabaseService } from "../../common/supabase/supabase.service";
import { WalletService } from "../wallet/wallet.service";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";
import { generateRef } from "../../common/helpers/generators";

export class PurchaseMaterialDto {
  @ApiPropertyOptional({ enum: ["WALLET", "FREE"], default: "FREE" })
  @IsOptional()
  @IsEnum(["WALLET", "FREE"])
  paymentMethod?: "WALLET" | "FREE" = "FREE";
}

export class ProgressDto {
  @ApiProperty() @IsNumber() @Min(0) @Max(100) progressPercentage: number;
}

@Injectable()
export class StudyMaterialsService {
  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
  ) {}

  async list(
    query: PaginationDto & {
      subject?: string;
      examType?: string;
      free?: string;
    },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    let q = this.supabase.admin
      .from("study_materials")
      .select(
        "id, title, description, subject, exam_type, price, is_free, thumbnail_url, file_type",
        { count: "exact" },
      )
      .eq("is_published", true)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (query.subject) q = q.eq("subject", query.subject);
    if (query.examType) q = q.eq("exam_type", query.examType);
    if (query.free === "true") q = q.eq("is_free", true);
    const { data, count } = await q;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async purchase(userId: string, materialId: string, dto: PurchaseMaterialDto) {
    const { data: m } = await this.supabase.admin
      .from("study_materials")
      .select("*")
      .eq("id", materialId)
      .single();
    if (!m)
      throw new NotFoundException({
        code: "MATERIAL_NOT_FOUND",
        message: "Material not found",
      });
    const { data: ex } = await this.supabase.admin
      .from("user_materials")
      .select("id")
      .eq("user_id", userId)
      .eq("material_id", materialId)
      .maybeSingle();
    if (ex)
      throw new ConflictException({
        code: "ALREADY_PURCHASED",
        message: "Already purchased",
      });
    if (!m.is_free && m.price > 0) {
      if (dto.paymentMethod === "WALLET")
        await this.wallet.debitWallet(
          userId,
          m.price,
          `Study Material - ${m.title}`,
        );
      else
        throw new ForbiddenException({
          code: "PAYMENT_REQUIRED",
          message: "Payment required",
        });
    }
    await this.supabase.admin
      .from("user_materials")
      .insert({
        user_id: userId,
        material_id: materialId,
        progress_percentage: 0,
        purchased_at: new Date().toISOString(),
      });
    if (!m.is_free)
      await this.supabase.admin
        .from("transactions")
        .insert({
          user_id: userId,
          reference: generateRef("SM"),
          transaction_type: "MATERIAL_PURCHASE",
          amount: m.price,
          payment_method: dto.paymentMethod,
          status: "COMPLETED",
          completed_at: new Date().toISOString(),
        });
    return { message: "Material unlocked", materialId };
  }

  async access(userId: string, materialId: string) {
    const { data: m } = await this.supabase.admin
      .from("study_materials")
      .select("id, file_path, is_free")
      .eq("id", materialId)
      .single();
    if (!m)
      throw new NotFoundException({
        code: "MATERIAL_NOT_FOUND",
        message: "Material not found",
      });
    if (!m.is_free) {
      const { data: a } = await this.supabase.admin
        .from("user_materials")
        .select("id")
        .eq("user_id", userId)
        .eq("material_id", materialId)
        .maybeSingle();
      if (!a)
        throw new ForbiddenException({
          code: "ACCESS_DENIED",
          message: "Purchase this material first",
        });
    }
    const { data: signed, error } = await this.supabase.admin.storage
      .from("study-materials")
      .createSignedUrl(m.file_path, 3600);
    if (error) throw new NotFoundException("Failed to generate URL");
    return { fileUrl: signed.signedUrl, expiresIn: 3600 };
  }

  async updateProgress(userId: string, materialId: string, dto: ProgressDto) {
    await this.supabase.admin
      .from("user_materials")
      .update({
        progress_percentage: dto.progressPercentage,
        completed_at:
          dto.progressPercentage >= 100 ? new Date().toISOString() : null,
      })
      .eq("user_id", userId)
      .eq("material_id", materialId);
    return { materialId, progressPercentage: dto.progressPercentage };
  }
}
