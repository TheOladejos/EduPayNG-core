import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, IsNumber, IsArray, IsEnum, MaxLength, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AiCreditsService } from './ai-credit.service';

class ChatDto {
  @ApiProperty() @IsString() @MaxLength(2000) message: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() conversationId?: string;
}

class StudentProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() jambScore?: number;
  @ApiPropertyOptional() @IsOptional() waecGrades?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() necoGrades?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsArray() interests?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() preferredStates?: string[];
  @ApiPropertyOptional() @IsOptional() budgetRange?: string;
  @ApiPropertyOptional() @IsOptional() programType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() careerGoals?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() stateOfOrigin?: string;
}

class GenerateRecsDto {
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() regenerate?: boolean;
}

class PurchaseCreditsDto {
  @ApiProperty({ description: 'ID of the credit package to purchase' })
  @IsUUID()
  packageId: string;
}

@ApiTags('AI')
@ApiBearerAuth('JWT')
@Controller({ version: '1' })
export class AiController {
  constructor(
    private aiService: AiService,
    private aiCredits: AiCreditsService,
  ) {}

  @Post('ai/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Chat with EduBot (costs 1 credit per message)' })
  chat(@CurrentUser() user: AuthUser, @Body() dto: ChatDto) {
    return this.aiService.chat(user.id, dto.message, dto.conversationId);
  }

  @Get('ai/conversations')
  @ApiOperation({ summary: 'Get chat conversation history' })
  getConversations(@CurrentUser() user: AuthUser) {
    return this.aiService.getConversations(user.id);
  }

  @Post('student-profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create or update student academic profile' })
  upsertStudentProfile(@CurrentUser() user: AuthUser, @Body() dto: StudentProfileDto) {
    return this.aiService.upsertStudentProfile(user.id, dto);
  }

  @Get('ai/recommendations')
  @ApiOperation({ summary: 'Get saved course recommendations' })
  getRecommendations(@CurrentUser() user: AuthUser) {
    return this.aiService.getRecommendations(user.id);
  }

  @Post('ai/recommendations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate AI course recommendations' })
  generateRecommendations(@CurrentUser() user: AuthUser, @Body() dto: GenerateRecsDto) {
    return this.aiService.generateRecommendations(user.id, dto.regenerate);
  }

  // ── Credit management ─────────────────────────────────────────

  @Get('ai/credits')
  @ApiOperation({ summary: 'Get current EduBot credit balance' })
  getCredits(@CurrentUser() user: AuthUser) {
    return this.aiCredits.getCredits(user.id);
  }

  @Get('ai/credits/packages')
  @ApiOperation({ summary: 'List available credit packages' })
  listPackages() {
    return this.aiCredits.listPackages();
  }

  @Post('ai/credits/purchase')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Buy a credit pack (deducted from wallet)' })
  purchaseCredits(@CurrentUser() user: AuthUser, @Body() dto: PurchaseCreditsDto) {
    return this.aiCredits.purchasePackage(user.id, dto.packageId);
  }
}