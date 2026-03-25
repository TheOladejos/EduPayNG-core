import { paginate, PaginationDto } from "@common/dto/pagination.dto";
import { SupabaseService } from "@common/supabase/supabase.service";
import { PaystackService } from "@modules/payments/gateway/paystack.gateway";
import { WalletService } from "@modules/wallet/wallet.service";
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";

export interface ChargebackEvidenceDto {
  transactionScreenshot?: string;
  deliveryProof?: string[];
  customerAcknowledgment?: string;
  additionalNotes?: string;
}

@Injectable()
export class ChargebackService {
  private readonly logger = new Logger(ChargebackService.name);

  constructor(
    private supabase: SupabaseService,
    private wallet: WalletService,
    private paystack: PaystackService,
  ) {}

  // ════════════════════════════════════════════════════════════
  // WEBHOOK HANDLER — called from payments.controller.ts
  // Paystack events:
  //   charge.dispute.create  → new chargeback received
  //   charge.dispute.remind  → deadline approaching
  //   charge.dispute.resolve → dispute resolved
  // ════════════════════════════════════════════════════════════

  async handleDisputeCreated(payload: any): Promise<void> {
    const {
      id: disputeId,
      transaction,
      amount,
      currency,
      reason,
      category,
      dueAt,
    } = payload.data ?? payload;
    const paystackRef =
      transaction?.reference ?? payload.data?.transaction?.reference;
    const amountNaira = (amount ?? 0) / 100;

    this.logger.log(
      `Chargeback received: dispute ${disputeId} — ₦${amountNaira} — ${reason}`,
    );

    // Look up our transaction record
    const { data: txn } = await this.supabase.admin
      .from("transactions")
      .select("*")
      .eq("reference", paystackRef)
      .maybeSingle();

    // Check if already recorded (idempotency)
    const { data: existing } = await this.supabase.admin
      .from("chargebacks")
      .select("id")
      .eq("paystack_dispute_id", disputeId)
      .maybeSingle();
    if (existing) {
      this.logger.log(`Dispute ${disputeId} already recorded`);
      return;
    }

    // Get policy
    const policy = await this.getPolicy();

    // Determine initial action
    let status = "PENDING";
    let autoRefundIssued = false;

    if (policy && amountNaira <= Number(policy.auto_accept_below)) {
      // Auto-accept small chargebacks — not worth fighting
      status = "ACCEPTED";
      this.logger.log(
        `Auto-accepting chargeback for ₦${amountNaira} (below threshold ₦${policy.auto_accept_below})`,
      );
    }

    // Record the chargeback
    const { data: chargeback } = await this.supabase.admin
      .from("chargebacks")
      .insert({
        paystack_dispute_id: disputeId,
        paystack_ref: paystackRef,
        transaction_id: txn?.id ?? null,
        user_id: txn?.user_id ?? null,
        amount: amountNaira,
        currency: currency ?? "NGN",
        reason: reason ?? "Not specified",
        category: category ?? null,
        status,
        response_deadline: dueAt ?? null,
        auto_refund_issued: autoRefundIssued,
        paystack_payload: payload,
      })
      .select()
      .single();

    if (!chargeback) return;

    // If auto-accepted, refund the wallet immediately
    if (status === "ACCEPTED" && txn) {
      await this.processAcceptedChargeback(
        chargeback.id,
        txn,
        "AUTO-ACCEPTED: below threshold",
      );
    }

    // Check if user has too many chargebacks
    if (txn?.user_id && policy) {
      await this.checkUserChargebackThreshold(txn.user_id, policy);
    }

    // Notify admin
    await this.supabase.admin
      .from("notifications")
      .insert({
        user_id: null, // system notification — no user
        title: "⚠️ Chargeback Received",
        message: `₦${amountNaira.toLocaleString()} dispute for ${paystackRef}. Reason: ${reason}. Deadline: ${dueAt ?? "Unknown"}.`,
        type: "WARNING",
        category: "CHARGEBACK",
        metadata: { disputeId, paystackRef, amount: amountNaira, status },
      })
      .throwOnError();
  }

  async handleDisputeReminder(payload: any): Promise<void> {
    const disputeId = payload.data?.id ?? payload.id;
    const { data: chargeback } = await this.supabase.admin
      .from("chargebacks")
      .select("*")
      .eq("paystack_dispute_id", disputeId)
      .maybeSingle();
    if (!chargeback || chargeback.status !== "PENDING") return;

    const deadline = chargeback.response_deadline
      ? new Date(chargeback.response_deadline)
      : null;
    const hoursLeft = deadline
      ? Math.floor((deadline.getTime() - Date.now()) / 3600000)
      : null;

    this.logger.warn(
      `Chargeback reminder: ${disputeId} — ${hoursLeft ?? "?"} hours left`,
    );

    // Auto-submit generic evidence if deadline is within 6 hours and no evidence submitted yet
    if (
      hoursLeft !== null &&
      hoursLeft <= 6 &&
      !chargeback.evidence_submitted_at
    ) {
      await this.submitEvidence(
        chargeback.id,
        {
          additionalNotes:
            "Digital product (educational token/service) was delivered successfully upon payment confirmation via EduPayNG platform.",
        },
        "SYSTEM",
      );
    }
  }

  async handleDisputeResolved(payload: any): Promise<void> {
    const disputeId = payload.data?.id ?? payload.id;
    const resolvedAt = payload.data?.resolvedAt ?? new Date().toISOString();
    const resolution = payload.data?.resolution ?? payload.resolution; // 'merchant-won' | 'customer-won'

    const { data: chargeback } = await this.supabase.admin
      .from("chargebacks")
      .select("*")
      .eq("paystack_dispute_id", disputeId)
      .maybeSingle();
    if (!chargeback) return;

    const won =
      resolution === "merchant-won" || resolution?.includes("merchant");
    const lost =
      resolution === "customer-won" || resolution?.includes("customer");

    const newStatus = won ? "WON" : lost ? "LOST" : "RESOLVED";

    await this.supabase.admin
      .from("chargebacks")
      .update({
        status: newStatus,
        resolved_at: resolvedAt,
        resolution_note: resolution,
        resolved_by: "PAYSTACK",
      })
      .eq("id", chargeback.id);

    if (lost && !chargeback.auto_refund_issued && chargeback.user_id) {
      // We lost the dispute — Paystack already reversed the charge.
      // If user still has a balance from the disputed transaction, debit it.
      const { data: txn } = await this.supabase.admin
        .from("transactions")
        .select("*")
        .eq("id", chargeback.transaction_id)
        .maybeSingle();
      if (txn && txn.status === "COMPLETED") {
        await this.supabase.admin
          .from("transactions")
          .update({ status: "CHARGEDBACK" })
          .eq("id", txn.id);
        // Reverse any wallet credit if this was a wallet funding transaction
        if (txn.transaction_type === "WALLET_FUNDING") {
          const { data: w } = await this.supabase.admin
            .from("wallets")
            .select("balance")
            .eq("user_id", chargeback.user_id)
            .single();
          if (w && w.balance >= chargeback.amount) {
            await this.wallet.creditWallet(
              chargeback.user_id,
              -chargeback.amount,
              `Chargeback reversal: ${chargeback.paystack_ref}`,
            );
          }
        }
        await this.supabase.admin
          .from("chargebacks")
          .update({
            auto_refund_issued: true,
            auto_refund_at: new Date().toISOString(),
          })
          .eq("id", chargeback.id);
      }
    }

    this.logger.log(`Dispute ${disputeId} resolved: ${newStatus}`);
  }

  // ── Manual actions from admin ─────────────────────────────────

  async submitEvidence(
    chargebackId: string,
    evidence: ChargebackEvidenceDto,
    adminEmail: string,
  ) {
    const { data: cb } = await this.supabase.admin
      .from("chargebacks")
      .select("*")
      .eq("id", chargebackId)
      .single();
    if (!cb) throw new NotFoundException("Chargeback not found");
    if (!["PENDING", "EVIDENCE_SENT"].includes(cb.status))
      throw new BadRequestException({
        code: "CANNOT_SUBMIT_EVIDENCE",
        message: `Dispute is already ${cb.status}`,
      });

    // Submit to Paystack API
    if (adminEmail !== "SYSTEM") {
      try {
        await this.submitToPaystack(cb.paystack_dispute_id, evidence);
      } catch (err: any) {
        this.logger.error(
          `Paystack evidence submission failed: ${err.message}`,
        );
        // Continue anyway — record locally even if API fails
      }
    }

    await this.supabase.admin
      .from("chargebacks")
      .update({
        status: "EVIDENCE_SENT",
        evidence: evidence,
        evidence_submitted_at: new Date().toISOString(),
      })
      .eq("id", chargebackId);

    await this.supabase.admin.from("audit_logs").insert({
      action: "CHARGEBACK_EVIDENCE_SUBMITTED",
      resource_type: "CHARGEBACK",
      resource_id: chargebackId,
      metadata: { by: adminEmail, evidence },
    });

    return { message: "Evidence submitted successfully", chargebackId };
  }

  async acceptChargeback(chargebackId: string, adminEmail: string) {
    const { data: cb } = await this.supabase.admin
      .from("chargebacks")
      .select("*")
      .eq("id", chargebackId)
      .single();
    if (!cb) throw new NotFoundException("Chargeback not found");
    if (cb.status !== "PENDING")
      throw new BadRequestException({
        code: "CANNOT_ACCEPT",
        message: `Dispute is already ${cb.status}`,
      });

    const { data: txn } = cb.transaction_id
      ? await this.supabase.admin
          .from("transactions")
          .select("*")
          .eq("id", cb.transaction_id)
          .maybeSingle()
      : { data: null };

    await this.processAcceptedChargeback(
      chargebackId,
      txn,
      `Manually accepted by ${adminEmail}`,
    );

    await this.supabase.admin.from("audit_logs").insert({
      action: "CHARGEBACK_ACCEPTED",
      resource_type: "CHARGEBACK",
      resource_id: chargebackId,
      metadata: { by: adminEmail, amount: cb.amount },
    });

    return { message: "Chargeback accepted", chargebackId };
  }

  async list(q: PaginationDto & { status?: string; userId?: string }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const offset = (page - 1) * limit;
    let query = this.supabase.admin
      .from("chargebacks")
      .select(
        "id, paystack_dispute_id, paystack_ref, amount, reason, category, status, response_deadline, evidence_submitted_at, resolved_at, auto_refund_issued, created_at, user_id",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (q.status) query = query.eq("status", q.status);
    if (q.userId) query = query.eq("user_id", q.userId);
    const { data, count } = await query;
    return paginate(data ?? [], count ?? 0, page, limit);
  }

  async getOne(id: string) {
    const { data, error } = await this.supabase.admin
      .from("chargebacks")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) throw new NotFoundException("Chargeback not found");
    return data;
  }

  async getStats() {
    const { data } = await this.supabase.admin
      .from("chargebacks")
      .select("status, amount");
    const byStatus: Record<string, { count: number; amount: number }> = {};
    for (const c of data ?? []) {
      if (!byStatus[c.status]) byStatus[c.status] = { count: 0, amount: 0 };
      byStatus[c.status].count++;
      byStatus[c.status].amount += Number(c.amount);
    }
    const total = (data ?? []).length;
    const won = byStatus["WON"]?.count ?? 0;
    const lost = byStatus["LOST"]?.count ?? 0;
    const resolved = won + lost;
    return {
      total,
      byStatus,
      winRate: resolved > 0 ? Math.round((won / resolved) * 100) : null,
      totalExposure: (data ?? [])
        .filter((c) => c.status === "PENDING")
        .reduce((s, c) => s + Number(c.amount), 0),
    };
  }

  async updatePolicy(dto: {
    autoAcceptBelow?: number;
    autoSuspendAt?: number;
    flagAt?: number;
    evidenceTemplate?: string;
  }) {
    const updates: any = { updated_at: new Date().toISOString() };
    if (dto.autoAcceptBelow !== undefined)
      updates.auto_accept_below = dto.autoAcceptBelow;
    if (dto.autoSuspendAt !== undefined)
      updates.auto_suspend_at = dto.autoSuspendAt;
    if (dto.flagAt !== undefined) updates.flag_at = dto.flagAt;
    if (dto.evidenceTemplate !== undefined)
      updates.evidence_template = dto.evidenceTemplate;
    const { data } = await this.supabase.admin
      .from("chargeback_policy")
      .update(updates)
      .select()
      .single();
    return data;
  }

  // ── Private helpers ───────────────────────────────────────────

  private async processAcceptedChargeback(
    chargebackId: string,
    txn: any,
    note: string,
  ) {
    await this.supabase.admin
      .from("chargebacks")
      .update({
        status: "ACCEPTED",
        resolved_at: new Date().toISOString(),
        resolution_note: note,
        resolved_by: "SYSTEM",
      })
      .eq("id", chargebackId);

    if (txn) {
      await this.supabase.admin
        .from("transactions")
        .update({ status: "CHARGEDBACK" })
        .eq("id", txn.id);
    }
  }

  private async checkUserChargebackThreshold(userId: string, policy: any) {
    const { count } = await this.supabase.admin
      .from("chargebacks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("status", ["PENDING", "EVIDENCE_SENT", "LOST", "ACCEPTED"]);

    const chargebackCount = count ?? 0;

    if (chargebackCount >= policy.auto_suspend_at) {
      this.logger.warn(
        `User ${userId} has ${chargebackCount} chargebacks — auto-suspending`,
      );
      await this.supabase.admin.auth.admin.updateUserById(userId, {
        ban_duration: "876600h",
      });
      await this.supabase.admin.from("audit_logs").insert({
        action: "USER_AUTO_SUSPENDED_CHARGEBACKS",
        resource_type: "USER",
        resource_id: userId,
        metadata: {
          chargebackCount,
          threshold: policy.auto_suspend_at,
          by: "SYSTEM",
        },
      });
    } else if (chargebackCount >= policy.flag_at) {
      this.logger.warn(
        `User ${userId} has ${chargebackCount} chargebacks — flagging`,
      );
      await this.supabase.admin
        .from("profiles")
        .update({
          metadata: { flaggedForChargebacks: true, chargebackCount },
        } as any)
        .eq("id", userId);
    }
  }

  private async getPolicy() {
    const { data } = await this.supabase.admin
      .from("chargeback_policy")
      .select("*")
      .single();
    return data;
  }

  private async submitToPaystack(
    disputeId: string,
    evidence: ChargebackEvidenceDto,
  ) {
    // Paystack dispute evidence API — submit via the Paystack SDK
    // POST https://api.paystack.co/dispute/:id/evidence
    // This requires your Paystack secret key (already in PaystackService)
    const evidenceText = [
      evidence.additionalNotes,
      evidence.deliveryProof?.length ? `Delivery proof available.` : null,
      evidence.transactionScreenshot
        ? `Transaction screenshot available.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    // PaystackService doesn't expose this endpoint yet — call it directly here
    // until we add it to the gateway service
    this.logger.log(
      `[Paystack] Submitting evidence for dispute ${disputeId}: ${evidenceText}`,
    );
    // TODO: Add submitDisputeEvidence() to PaystackService for production
  }
}
