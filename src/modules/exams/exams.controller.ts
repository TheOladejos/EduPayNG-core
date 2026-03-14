import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ExamsService } from './exams.service';
import { EnrollExamDto, StartExamDto, SubmitAnswerDto, SubmitExamDto } from './exams.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Exams')
@Controller({ path: 'exams', version: '1' })
export class ExamsController {
  constructor(private examsService: ExamsService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'List available exams' })
  list(@Query() query: PaginationDto & { category?: string; examType?: string; free?: string }) {
    return this.examsService.listExams(query);
  }

  @Post('enroll')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enroll in an exam' })
  enroll(@CurrentUser() user: AuthUser, @Body() dto: EnrollExamDto) {
    return this.examsService.enroll(user.id, dto);
  }

  @Post('start')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start exam and receive questions' })
  start(@CurrentUser() user: AuthUser, @Body() dto: StartExamDto) {
    return this.examsService.startExam(user.id, dto);
  }

  @Post('answer')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save an answer (auto-save, can call multiple times)' })
  answer(@CurrentUser() user: AuthUser, @Body() dto: SubmitAnswerDto) {
    return this.examsService.submitAnswer(user.id, dto);
  }

  @Post('submit')
  @ApiBearerAuth('JWT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit exam and receive scored results' })
  submit(@CurrentUser() user: AuthUser, @Body() dto: SubmitExamDto) {
    return this.examsService.submitExam(user.id, dto);
  }
}
