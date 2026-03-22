import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { VtpassService } from '@modules/payments/gateway/vtPass.gateway';


// Categories whose prices come from VTPass and need periodic sync
// Airtime is excluded because it has no "plans" — it's a free amount
const SYNCABLE_CATEGORIES = ['DATA'] as const;

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    private supabase: SupabaseService,
    private vtpass: VtpassService,
  ) {}

  // ════════════════════════════════════════════════════════════════
  // TOKEN PRICING  (admin-controlled selling prices)
  // ════════════════════════════════════════════════════════════════

  async getInstitutionPricing() {
    const { data } = await this.supabase.admin
      .from('institutions')
      .select('id, code, name, short_name, token_price, vendor_cost, gateway, is_active')
      .order('display_order');

    return (data ?? []).map(i => ({
      id:          i.id,
      code:        i.code,
      name:        i.name,
      shortName:   i.short_name,
      gateway:     i.gateway,
      isActive:    i.is_active,
      vendorCost:  Number(i.vendor_cost),   // what VTPass/Remita charges you — fixed by exam body
      sellingPrice: Number(i.token_price),   // what you charge student — you control this
      margin:      Number(i.token_price) - Number(i.vendor_cost),
      marginPct:   Number(i.vendor_cost) > 0
        ? Math.round(((Number(i.token_price) - Number(i.vendor_cost)) / Number(i.vendor_cost)) * 100)
        : 0,
    }));
  }

  async updateInstitutionPricing(
    institutionId: string,
    dto: { sellingPrice?: number; vendorCost?: number; isActive?: boolean },
    adminEmail: string,
  ) {
    const { data: existing } = await this.supabase.admin
      .from('institutions').select('*').eq('id', institutionId).single();
    if (!existing) throw new NotFoundException('Institution not found');

    const updates: Record<string, any> = {};
    if (dto.sellingPrice !== undefined) updates.token_price  = dto.sellingPrice;
    if (dto.vendorCost   !== undefined) updates.vendor_cost  = dto.vendorCost;
    if (dto.isActive     !== undefined) updates.is_active    = dto.isActive;

    const { data } = await this.supabase.admin
      .from('institutions').update(updates).eq('id', institutionId).select().single();

    await this.supabase.admin.from('audit_logs').insert({
      action: 'INSTITUTION_PRICE_UPDATED', resource_type: 'INSTITUTION', resource_id: institutionId,
      metadata: {
        by: adminEmail, changes: updates,
        before: { token_price: existing.token_price, vendor_cost: existing.vendor_cost },
      },
    });

    this.logger.log(`Institution pricing updated: ${existing.code} → ₦${dto.sellingPrice ?? existing.token_price} by ${adminEmail}`);

    return {
      id:           data!.id,
      code:         data!.code,
      sellingPrice: data!.token_price,
      vendorCost:   data!.vendor_cost,
      margin:       Number(data!.token_price) - Number(data!.vendor_cost),
      message:      `${existing.short_name} token price updated to ₦${dto.sellingPrice ?? existing.token_price}`,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // BILL PRODUCT SYNC  (VTPass controls these prices — you just sync)
  // ════════════════════════════════════════════════════════════════

  async getBillProducts(billerId?: string) {
    let q = this.supabase.admin
      .from('bill_products')
      .select('id, vtpass_code, name, description, amount, validity, is_active, billers(id, name, short_name, category_code)')
      .order('amount', { ascending: true });

    if (billerId) q = q.eq('biller_id', billerId);

    const { data } = await q;
    return data ?? [];
  }

  async syncBillProductsFromVtpass(adminEmail: string): Promise<{
    synced:  number;
    updated: number;
    errors:  string[];
  }> {
    // Fetch all billers that have VTPass-controlled products
    const { data: billers } = await this.supabase.admin
      .from('billers')
      .select('id, vtpass_code, name, short_name, category_code')
      .in('category_code', SYNCABLE_CATEGORIES)
      .eq('is_active', true);

    let totalSynced = 0;
    let totalUpdated = 0;
    const errors: string[] = [];

    for (const biller of billers ?? []) {
      try {
        this.logger.log(`Syncing products for ${biller.short_name} (${biller.vtpass_code})`);

        const variations = await this.vtpass.getVariations(biller.vtpass_code);

        if (!variations.length) {
          this.logger.warn(`No variations returned for ${biller.vtpass_code}`);
          continue;
        }

        // Upsert each variation into bill_products
        for (const v of variations) {
          const productData = {
            biller_id:   biller.id,
            vtpass_code: v.variationCode,
            name:        v.name,
            amount:      Number(v.variationAmount),
            is_active:   true,
          };

          const { data: existing } = await this.supabase.admin
            .from('bill_products')
            .select('id, amount')
            .eq('biller_id', biller.id)
            .eq('vtpass_code', v.variationCode)
            .maybeSingle();

          if (existing) {
            // Update if price changed
            if (Number(existing.amount) !== Number(v.variationAmount)) {
              await this.supabase.admin.from('bill_products').update({ amount: Number(v.variationAmount), name: v.name }).eq('id', existing.id);
              totalUpdated++;
              this.logger.log(`Price updated: ${biller.short_name} — ${v.name}: ₦${existing.amount} → ₦${v.variationAmount}`);
            }
          } else {
            await this.supabase.admin.from('bill_products').insert(productData);
            totalSynced++;
          }
        }

        // Mark removed products as inactive (not returned by VTPass anymore)
        const activeVtpassCodes = variations.map(v => v.variationCode);
        await this.supabase.admin.from('bill_products')
          .update({ is_active: false })
          .eq('biller_id', biller.id)
          .not('vtpass_code', 'in', `(${activeVtpassCodes.map(c => `"${c}"`).join(',')})`);

      } catch (err: any) {
        const msg = `Failed to sync ${biller.short_name}: ${err.message}`;
        this.logger.error(msg);
        errors.push(msg);
      }
    }

    await this.supabase.admin.from('audit_logs').insert({
      action: 'BILL_PRODUCTS_SYNCED', resource_type: 'BILL_PRODUCTS',
      metadata: { by: adminEmail, newProducts: totalSynced, priceUpdates: totalUpdated, errors },
    });

    return { synced: totalSynced, updated: totalUpdated, errors };
  }

  // ════════════════════════════════════════════════════════════════
  // BILL MARGIN CONFIG  (your markup on bills)
  // ════════════════════════════════════════════════════════════════

  async getBillMargins() {
    const { data } = await this.supabase.admin
      .from('bill_margin_config')
      .select('*')
      .order('category_code');

    // Return defaults if table is empty
    if (!data?.length) {
      return [
        { category_code: 'AIRTIME',     margin_pct: 2,  margin_flat: 0, note: '2% margin on airtime purchases' },
        { category_code: 'DATA',        margin_pct: 5,  margin_flat: 0, note: '5% margin on data bundles' },
      ];
    }

    return data;
  }

  async updateBillMargin(
    categoryCode: string,
    dto: { marginPct: number; marginFlat?: number; note?: string },
    adminEmail: string,
  ) {
    const { data } = await this.supabase.admin
      .from('bill_margin_config')
      .upsert({
        category_code: categoryCode,
        margin_pct:    dto.marginPct,
        margin_flat:   dto.marginFlat ?? 0,
        note:          dto.note ?? null,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'category_code' })
      .select()
      .single();

    await this.supabase.admin.from('audit_logs').insert({
      action: 'BILL_MARGIN_UPDATED', resource_type: 'PRICING',
      metadata: { by: adminEmail, categoryCode, marginPct: dto.marginPct },
    });

    return data;
  }
}
