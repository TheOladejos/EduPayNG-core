import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from "@nestjs/common";
import { SupabaseService } from "../../common/supabase/supabase.service";
import { WalletService } from "../wallet/wallet.service";
import {
  EnrollExamDto,
  StartExamDto,
  SubmitAnswerDto,
  SubmitExamDto,
  ExamPaymentMethod,
} from "./exams.dto";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";

@Injectable()
export class ExamsService {
  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
  ) {}

  async listExams(
    query: PaginationDto & {
      category?: string;
      examType?: string;
      free?: string;
    },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    let q = this.supabase.admin
      .from("exams")
      .select(
        "id, title, description, exam_type, duration_minutes, total_marks, pass_mark, price, is_free, thumbnail_url, exam_categories(id, name)",
        { count: "exact" },
      )
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (query.category) q = q.eq("category_id", query.category);
    if (query.examType) q = q.eq("exam_type", query.examType);
    if (query.free === "true") q = q.eq("is_free", true);

    const { data, error, count } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async enroll(userId: string, dto: EnrollExamDto) {
    const { data: exam } = await this.supabase.admin
      .from("exams")
      .select("*")
      .eq("id", dto.examId)
      .eq("is_active", true)
      .single();
    if (!exam)
      throw new NotFoundException({
        code: "EXAM_NOT_FOUND",
        message: "Exam not found",
      });

    const { data: existing } = await this.supabase.admin
      .from("student_exams")
      .select("id, status")
      .eq("user_id", userId)
      .eq("exam_id", dto.examId)
      .in("status", ["NOT_STARTED", "IN_PROGRESS"])
      .maybeSingle();
    if (existing)
      throw new ConflictException({
        code: "ALREADY_ENROLLED",
        message: "Already enrolled in this exam",
      });

    if (!exam.is_free && exam.price > 0) {
      if (dto.paymentMethod === ExamPaymentMethod.WALLET) {
        await this.wallet.debitWallet(
          userId,
          exam.price,
          `CBT Enrollment - ${exam.title}`,
        );
      } else if (dto.paymentMethod === ExamPaymentMethod.POINTS) {
        const { data: w } = await this.supabase.admin
          .from("wallets")
          .select("points")
          .eq("user_id", userId)
          .single();
        if (!w || w.points < exam.price)
          throw new BadRequestException({
            code: "INSUFFICIENT_POINTS",
            message: "Insufficient points",
          });
        await this.supabase.admin
          .from("wallets")
          .update({ points: w.points - exam.price })
          .eq("user_id", userId);
      } else {
        throw new BadRequestException({
          code: "PAYMENT_REQUIRED",
          message: "Payment required for this exam",
        });
      }
    }

    const { data: enrollment, error } = await this.supabase.admin
      .from("student_exams")
      .insert({
        user_id: userId,
        exam_id: dto.examId,
        status: "NOT_STARTED",
        enrolled_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    await this.wallet.sendNotification(
      userId,
      "Exam Enrollment Successful",
      `You are enrolled in "${exam.title}". Good luck!`,
      "SUCCESS",
      "EXAM",
    );

    return {
      enrollmentId: enrollment.id,
      examId: dto.examId,
      examTitle: exam.title,
      status: "NOT_STARTED",
      durationMinutes: exam.duration_minutes,
    };
  }

  async startExam(userId: string, dto: StartExamDto) {
    const { data: se, error } = await this.supabase.admin
      .from("student_exams")
      .select("*, exams(id, title, duration_minutes, total_marks, pass_mark)")
      .eq("id", dto.studentExamId)
      .eq("user_id", userId)
      .single();

    if (error || !se)
      throw new NotFoundException({
        code: "ENROLLMENT_NOT_FOUND",
        message: "Exam session not found",
      });
    if (se.status === "COMPLETED")
      throw new BadRequestException({
        code: "EXAM_COMPLETED",
        message: "Exam already submitted",
      });

    const { data: questions } = await this.supabase.admin
      .from("questions")
      .select(
        "id, question_number, question_text, question_type, options, marks, image_url",
      )
      .eq("exam_id", se.exam_id)
      .order("question_number");

    if (se.status === "IN_PROGRESS") {
      const expiry = new Date(
        new Date(se.started_at).getTime() + se.exams.duration_minutes * 60000,
      );
      if (new Date() > expiry)
        throw new BadRequestException({
          code: "EXAM_EXPIRED",
          message: "Exam time expired",
        });

      const { data: answered } = await this.supabase.admin
        .from("student_answers")
        .select("question_id, selected_option")
        .eq("student_exam_id", dto.studentExamId);

      return this.buildStartResponse(
        se,
        questions ?? [],
        answered ?? [],
        expiry,
      );
    }

    const startedAt = new Date();
    const expiresAt = new Date(
      startedAt.getTime() + se.exams.duration_minutes * 60000,
    );

    await this.supabase.admin
      .from("student_exams")
      .update({ status: "IN_PROGRESS", started_at: startedAt.toISOString() })
      .eq("id", dto.studentExamId);

    return this.buildStartResponse(se, questions ?? [], [], expiresAt);
  }

  async submitAnswer(userId: string, dto: SubmitAnswerDto) {
    const { data: se } = await this.supabase.admin
      .from("student_exams")
      .select("*,exams(status, started_at, duration_minutes)")
      .eq("id", dto.studentExamId)
      .eq("user_id", userId)
      .single();

    if (!se)
      throw new NotFoundException({
        code: "SESSION_NOT_FOUND",
        message: "Exam session not found",
      });
    if (se.status !== "IN_PROGRESS")
      throw new BadRequestException({
        code: "EXAM_NOT_ACTIVE",
        message: "Exam is not in progress",
      });

    const expiry = new Date(
      new Date(se.started_at).getTime() + se.exams.duration_minutes * 60000,
    );
    if (new Date() > expiry)
      throw new BadRequestException({
        code: "EXAM_EXPIRED",
        message: "Exam time has expired",
      });

    await this.supabase.admin.from("student_answers").upsert(
      {
        student_exam_id: dto.studentExamId,
        question_id: dto.questionId,
        user_id: userId,
        selected_option: dto.selectedOption,
        answered_at: new Date().toISOString(),
      },
      { onConflict: "student_exam_id,question_id" },
    );

    return {
      saved: true,
      questionId: dto.questionId,
      selectedOption: dto.selectedOption,
    };
  }

  async submitExam(userId: string, dto: SubmitExamDto) {
    const { data: se, error } = await this.supabase.admin
      .from("student_exams")
      .select("*, exams(id, title, total_marks, pass_mark, duration_minutes)")
      .eq("id", dto.studentExamId)
      .eq("user_id", userId)
      .single();

    if (error || !se)
      throw new NotFoundException({
        code: "SESSION_NOT_FOUND",
        message: "Exam session not found",
      });
    if (se.status === "COMPLETED")
      throw new ConflictException({
        code: "ALREADY_SUBMITTED",
        message: "Exam already submitted",
      });
    if (se.status !== "IN_PROGRESS")
      throw new BadRequestException({
        code: "NOT_STARTED",
        message: "Exam not started",
      });

    const { data: questions } = await this.supabase.admin
      .from("questions")
      .select("id, correct_answer, marks")
      .eq("exam_id", se.exam_id);
    const { data: answers } = await this.supabase.admin
      .from("student_answers")
      .select("question_id, selected_option")
      .eq("student_exam_id", dto.studentExamId);

    const answerMap = new Map(
      (answers ?? []).map((a) => [a.question_id, a.selected_option]),
    );

    let totalScore = 0,
      correctAnswers = 0,
      wrongAnswers = 0,
      unanswered = 0;

    const breakdown = (questions ?? []).map((q) => {
      const selected = answerMap.get(q.id);
      const isCorrect = selected === q.correct_answer;
      if (!selected) unanswered++;
      else if (isCorrect) {
        correctAnswers++;
        totalScore += q.marks;
      } else wrongAnswers++;
      return {
        questionId: q.id,
        selectedOption: selected ?? null,
        correctAnswer: q.correct_answer,
        isCorrect: selected ? isCorrect : null,
        marksAwarded: isCorrect ? q.marks : 0,
      };
    });

    const totalMarks = se.exams.total_marks;
    const percentageScore = Math.round((totalScore / totalMarks) * 100);
    const passed = percentageScore >= se.exams.pass_mark;
    const submittedAt = new Date().toISOString();

    const { data: result } = await this.supabase.admin
      .from("exam_results")
      .insert({
        student_exam_id: dto.studentExamId,
        user_id: userId,
        exam_id: se.exam_id,
        total_score: totalScore,
        total_marks: totalMarks,
        percentage_score: percentageScore,
        correct_answers: correctAnswers,
        wrong_answers: wrongAnswers,
        unanswered,
        passed,
        time_taken_seconds: Math.floor(
          (new Date(submittedAt).getTime() -
            new Date(se.started_at).getTime()) /
            1000,
        ),
        breakdown,
      })
      .select()
      .single();

    await this.supabase.admin
      .from("student_exams")
      .update({ status: "COMPLETED", submitted_at: submittedAt })
      .eq("id", dto.studentExamId);

    await this.wallet.sendNotification(
      userId,
      passed ? "🎉 You Passed!" : "Exam Completed",
      `${se.exams.title}: ${percentageScore}% (${totalScore}/${totalMarks}). ${passed ? "Congratulations!" : `Pass mark is ${se.exams.pass_mark}%.`}`,
      passed ? "SUCCESS" : "INFO",
      "EXAM",
    );

    return {
      resultId: result?.id,
      examTitle: se.exams.title,
      totalScore,
      totalMarks,
      percentageScore,
      passed,
      passMark: se.exams.pass_mark,
      correctAnswers,
      wrongAnswers,
      unanswered,
      submittedAt,
      breakdown,
    };
  }

  private buildStartResponse(
    se: any,
    questions: any[],
    answered: any[],
    expiresAt: Date,
  ) {
    return {
      studentExamId: se.id,
      status: "IN_PROGRESS",
      startedAt: se.started_at ?? new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      timeRemainingSeconds: Math.max(
        0,
        Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      ),
      exam: {
        title: se.exams.title,
        totalMarks: se.exams.total_marks,
        passMark: se.exams.pass_mark,
      },
      questions: questions.map((q) => ({
        id: q.id,
        questionNumber: q.question_number,
        questionText: q.question_text,
        questionType: q.question_type,
        options: q.options,
        marks: q.marks,
        imageUrl: q.image_url ?? null,
      })),
      answeredQuestions: answered.map((a) => ({
        questionId: a.question_id,
        selectedOption: a.selected_option,
      })),
    };
  }
}
