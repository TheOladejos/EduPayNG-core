import { IsUUID, IsString, IsEnum, IsOptional, IsBoolean, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ExamPaymentMethod { WALLET = 'WALLET', CARD = 'CARD', POINTS = 'POINTS', FREE = 'FREE' }

export class EnrollExamDto {
  @ApiProperty() @IsUUID() examId: string;
  @ApiPropertyOptional({ enum: ExamPaymentMethod, default: 'FREE' })
  @IsOptional() @IsEnum(ExamPaymentMethod) paymentMethod?: ExamPaymentMethod = ExamPaymentMethod.FREE;
}

export class StartExamDto {
  @ApiProperty() @IsUUID() studentExamId: string;
}

export class SubmitAnswerDto {
  @ApiProperty() @IsUUID() studentExamId: string;
  @ApiProperty() @IsUUID() questionId: string;
  @ApiProperty() @IsString() selectedOption: string;
}

export class SubmitExamDto {
  @ApiProperty() @IsUUID() studentExamId: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() forcedSubmit?: boolean;
}
