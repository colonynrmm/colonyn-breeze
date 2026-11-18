/**
 * One-time move of existing tenants to the Colonyn billing currency.
 *
 *   docker compose ... run --rm colonyn-bridge node dist/colonyn-bridge.cjs currency-backfill           # preview
 *   docker compose ... run --rm colonyn-bridge node dist/colonyn-bridge.cjs currency-backfill --apply   # write
 *
 * Partners: `partners.currency_code` is the default new organizations inherit, and Breeze has no screen
 * to change it. This sets it and makes sure a default rate profile exists in that currency.
 *
 * Organizations: changed only through `changeOrgCurrency` (the one writer Breeze allows), and only when
 * nothing in the organization is stamped in another currency and no rate setting would be skipped.
 * Anything else is listed for the partner to change under Organization → Settings → Billing, where Breeze
 * shows exactly what is affected. No amount is ever converted.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { ensureDefaultProfile } from '../../services/billingProfileService';
import { changeOrgCurrency, getOrgCurrencyImpact, type OrgCurrencyImpact } from '../../services/orgCurrencyService';
import type { InvoiceActor } from '../../services/invoiceTypes';

const SYSTEM_ACTOR: InvoiceActor = { userId: null, partnerId: null, accessibleOrgIds: null };

export interface BackfillReport {
  currency: string;
  applied: boolean;
  partners: Array<{ id: string; name: string; from: string }>;
  orgsChanged: Array<{ id: string; name: string; partner: string; from: string }>;
  orgsManual: Array<{ id: string; name: string; partner: string; from: string; reason: string }>;
}

/** Why an organization cannot be moved automatically, or null when it is safe. */
export function manualReason(impact: OrgCurrencyImpact): string | null {
  const stamped = impact.impactsByCurrency.map((g) => g.currencyCode);
  if (stamped.length) return `documents or unbilled work in ${stamped.join(', ')}`;
  const w = impact.configurationWarnings;
  if (w.assignedBillingProfile.currencyMismatch) return `assigned rate profile is ${w.assignedBillingProfile.currencyCode}`;
  if (w.orgCatalogOverridesSkipped > 0) return `${w.orgCatalogOverridesSkipped} catalog price override(s) in another currency`;
  return null;
}

export async function runCurrencyBackfill(currency: string, apply: boolean): Promise<BackfillReport> {
  return withSystemDbAccessContext(async () => {
    const report: BackfillReport = { currency, applied: apply, partners: [], orgsChanged: [], orgsManual: [] };

    const partnerRows = await db
      .select({ id: partners.id, name: partners.name, currencyCode: partners.currencyCode })
      .from(partners)
      .where(and(isNull(partners.deletedAt), ne(partners.currencyCode, currency)));
    for (const p of partnerRows) {
      report.partners.push({ id: p.id, name: p.name, from: p.currencyCode });
      if (!apply) continue;
      await db.transaction(async (tx) => {
        await tx.update(partners).set({ currencyCode: currency, updatedAt: new Date() }).where(eq(partners.id, p.id));
        await ensureDefaultProfile(p.id, currency, tx);
      });
    }

    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name, currencyCode: organizations.currencyCode, partner: partners.name })
      .from(organizations)
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(and(isNull(organizations.deletedAt), isNull(partners.deletedAt), ne(organizations.currencyCode, currency)));
    for (const o of orgRows) {
      const base = { id: o.id, name: o.name, partner: o.partner, from: o.currencyCode };
      const reason = manualReason(await getOrgCurrencyImpact(o.id, currency, SYSTEM_ACTOR));
      if (reason) {
        report.orgsManual.push({ ...base, reason });
        continue;
      }
      report.orgsChanged.push(base);
      if (apply) {
        await changeOrgCurrency(
          o.id,
          { currencyCode: currency, expectedCurrentCurrencyCode: o.currencyCode, confirmSnapshotRetention: true },
          SYSTEM_ACTOR,
        );
      }
    }
    return report;
  });
}

export function formatBackfillReport(r: BackfillReport): string {
  const verb = r.applied ? 'changed' : 'would change';
  const lines = [`[colonyn-bridge] currency backfill to ${r.currency} (${r.applied ? 'APPLIED' : 'preview, nothing written'})`];
  lines.push(`Partners ${verb}: ${r.partners.length}`);
  for (const p of r.partners) lines.push(`  - ${p.name} (${p.from} -> ${r.currency})`);
  lines.push(`Organizations ${verb}: ${r.orgsChanged.length}`);
  for (const o of r.orgsChanged) lines.push(`  - ${o.partner} / ${o.name} (${o.from} -> ${r.currency})`);
  lines.push(`Organizations left for Settings -> Billing: ${r.orgsManual.length}`);
  for (const o of r.orgsManual) lines.push(`  - ${o.partner} / ${o.name} (${o.from}): ${o.reason}`);
  if (!r.applied) lines.push('Run again with --apply to write these changes.');
  return lines.join('\n');
}
