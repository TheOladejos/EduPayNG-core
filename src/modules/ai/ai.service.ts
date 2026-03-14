import {
  Injectable, NotFoundException, BadRequestException,
  ServiceUnavailableException, ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AiCreditsService, CREDITS_PER_QUERY } from './ai-credit.service';

const SYSTEM_PROMPT = `You are EduBot, an expert educational counselor for Nigerian students on EduPayNG.
You specialize in:
- University and course selection based on WAEC, NECO, JAMB, NABTEB results
- Nigerian universities (federal, state, private)
- Career guidance aligned with Nigerian job market realities
- JAMB subject combinations and O'Level requirements
- UTME cut-off marks by university and course
- Scholarship opportunities for Nigerian students

Be warm, encouraging, and practical. Always tailor advice to the Nigerian educational context.
When recommending courses, mention: entry requirements, career prospects, and top Nigerian universities that offer it.
Keep responses concise and actionable.`;

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor(
    private supabase: SupabaseService,
    private config: ConfigService,
    private aiCredits: AiCreditsService,
  ) {
    this.openai = new OpenAI({ apiKey: config.getOrThrow('OPENAI_API_KEY') });
  }

  async chat(userId: string, message: string, conversationId?: string) {
    // ── 1. Check & debit 1 credit BEFORE hitting OpenAI ─────────
    // Throws INSUFFICIENT_AI_CREDITS (402) if balance is 0
    await this.aiCredits.chargeOneQuery(userId);

    // ── 2. Get or create conversation ────────────────────────────
    let convId = conversationId;

    if (!convId) {
      const { data: conv, error } = await this.supabase.admin
        .from('ai_conversations')
        .insert({ user_id: userId, title: message.substring(0, 60), status: 'ACTIVE' })
        .select().single();
      if (error) throw new BadRequestException('Failed to create conversation');
      convId = conv.id;
    } else {
      const { data: existing } = await this.supabase.admin
        .from('ai_conversations').select('id').eq('id', convId).eq('user_id', userId).single();
      if (!existing) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
    }

    await this.supabase.admin.from('ai_messages').insert({ conversation_id: convId, role: 'USER', content: message });

    const { data: history } = await this.supabase.admin
      .from('ai_messages').select('role, content')
      .eq('conversation_id', convId).order('created_at', { ascending: true }).limit(20);

    const { data: profile } = await this.supabase.admin
      .from('student_profiles').select('*').eq('user_id', userId).maybeSingle();

    let systemContent = SYSTEM_PROMPT;
    if (profile) {
      systemContent += `\n\nStudent Context:\n- JAMB Score: ${profile.jamb_score ?? 'Not provided'}\n- WAEC Grades: ${JSON.stringify(profile.waec_grades ?? {})}\n- Interests: ${profile.interests?.join(', ') ?? 'Not specified'}\n- State: ${profile.state_of_origin ?? 'Not specified'}`;
    }

    // ── 3. Call OpenAI ────────────────────────────────────────────
    try {
      const model = this.config.get('OPENAI_MODEL', 'gpt-4o-mini');
      const completion = await this.openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemContent },
          ...(history ?? []).map(m => ({ role: m.role.toLowerCase() as 'user' | 'assistant', content: m.content })),
        ],
        temperature: 0.7,
        max_tokens: 800,
      });

      const reply = completion.choices[0].message.content ?? '';
      const usage = completion.usage;

      await this.supabase.admin.from('ai_messages').insert({
        conversation_id: convId, role: 'ASSISTANT', content: reply,
        tokens_used: usage?.total_tokens ?? 0,
      });

      // ── 4. Log usage for analytics ────────────────────────────
      await this.aiCredits.logUsage({
        userId,
        conversationId: convId as string,
        inputTokens:    usage?.prompt_tokens ?? 0,
        outputTokens:   usage?.completion_tokens ?? 0,
        totalTokens:    usage?.total_tokens ?? 0,
        model,
        creditsCharged: CREDITS_PER_QUERY,
      });

      // ── 5. Return updated credit balance so UI can reflect it ─
      const credits = await this.aiCredits.getCredits(userId);

      return {
        conversationId: convId,
        message: reply,
        tokensUsed: usage?.total_tokens ?? 0,
        creditsRemaining: credits?.balance ?? 0,
      };
    } catch (err: any) {
      // If OpenAI call fails, refund the credit
      await this.supabase.admin
        .from('ai_credits')
        .update({ balance: this.supabase.admin.rpc('increment', { x: 1 }) as any })
        .eq('user_id', userId);

      if (err?.code === 'INSUFFICIENT_AI_CREDITS') throw err;
      throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'AI assistant is temporarily unavailable' });
    }
  }

  async getConversations(userId: string) {
    const { data } = await this.supabase.admin
      .from('ai_conversations').select('id, title, status, created_at, updated_at')
      .eq('user_id', userId).order('updated_at', { ascending: false });
    return data ?? [];
  }

  async upsertStudentProfile(userId: string, dto: any) {
    const { data, error } = await this.supabase.admin
      .from('student_profiles')
      .upsert({ user_id: userId, ...this.toSnakeCase(dto), updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async getRecommendations(userId: string) {
    const { data } = await this.supabase.admin
      .from('course_recommendations').select('*').eq('user_id', userId).order('score', { ascending: false }).limit(20);
    return data ?? [];
  }

  async generateRecommendations(userId: string, regenerate = false) {
    const { data: profile } = await this.supabase.admin
      .from('student_profiles').select('*').eq('user_id', userId).maybeSingle();

    if (!profile) throw new BadRequestException({ code: 'PROFILE_REQUIRED', message: 'Complete your student profile first' });

    if (!regenerate) {
      const { data: recent } = await this.supabase.admin
        .from('course_recommendations').select('id').eq('user_id', userId)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).limit(1);
      if (recent?.length) throw new ConflictException({ code: 'RECOMMENDATIONS_EXIST', message: 'Set regenerate=true to refresh' });
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.config.get('OPENAI_MODEL', 'gpt-4o-mini'),
        messages: [{
          role: 'user',
          content: `Suggest 5 Nigerian university-course combinations for this student.
Profile: JAMB: ${profile.jamb_score ?? 'N/A'}, WAEC: ${JSON.stringify(profile.waec_grades ?? {})}, Interests: ${profile.interests?.join(', ')}, Career: ${profile.career_goals ?? 'N/A'}
Return ONLY valid JSON array: [{"universityName":"...","courseName":"...","faculty":"...","score":85,"reasoning":"...","minimumJamb":220,"minimumWaecPasses":5}]`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0.6,
        max_tokens: 1000,
      });

      const parsed = JSON.parse(completion.choices[0].message.content ?? '{}');
      const recommendations = Array.isArray(parsed) ? parsed : (parsed.recommendations ?? []);

      if (regenerate) await this.supabase.admin.from('course_recommendations').delete().eq('user_id', userId);

      await this.supabase.admin.from('course_recommendations').insert(
        recommendations.map((r: any) => ({ user_id: userId, score: r.score, reasoning: r.reasoning, raw_data: r }))
      );

      return { count: recommendations.length, recommendations };
    } catch {
      throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'AI service unavailable' });
    }
  }

  private toSnakeCase(obj: Record<string, any>) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), v]));
  }
}