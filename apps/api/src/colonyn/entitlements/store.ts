import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { isColonynFeature, type ColonynFeature } from './features';

/**
 * Read side of the plan entitlements the Colonyn Bridge writes into
 * `colonyn_bridge.entitlements` (one row per partner).
 *
 * - No row for a partner: nothing is restricted (partners created outside
 *   Colonyn, e.g. the operator's own partner, keep every module).
 * - Table or schema not created yet (Bridge never started on this database):
 *   nothing is restricted either; logged once.
 * - Any other read error is thrown: callers fail closed for gated modules.
 */
export interface Entitlements {
  /** null = every module allowed. */
  features: ReadonlySet<ColonynFeature> | null;
  /** null = no technician limit. */
  maxTechnicians: number | null;
}

export const UNRESTRICTED: Entitlements = Object.freeze({ features: null, maxTechnicians: null });

/**
 * Kill switch: COLONYN_ENTITLEMENTS=off disables every plan check (rollback
 * without a redeploy of the Bridge). Under vitest the checks are off unless a
 * test sets COLONYN_ENTITLEMENTS=on, so upstream suites keep testing upstream
 * behaviour with their own database mocks.
 */
export function entitlementsEnforced(): boolean {
  const flag = process.env.COLONYN_ENTITLEMENTS?.trim().toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0') return false;
  if (flag === 'on' || flag === 'true' || flag === '1') return true;
  return !process.env.VITEST;
}

const TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 5_000;

const entitlementCache = new Map<string, { value: Entitlements; at: number }>();
const orgPartnerCache = new Map<string, { partnerId: string | null; at: number }>();
let missingTableLogged = false;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export function isMissingRelationError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: string }).code;
    // 42P01 undefined_table, 3F000 invalid_schema_name
    if (code === '42P01' || code === '3F000') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function systemRead<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'colonyn.entitlements'));
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, value);
}

export function parseEntitlementRow(row: Record<string, unknown> | undefined): Entitlements {
  if (!row) return UNRESTRICTED;
  const raw = row.features;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.replace(/^\{|\}$/g, '').split(',').filter(Boolean)
      : [];
  const features = new Set<ColonynFeature>(list.filter(isColonynFeature));
  const max = row.max_technicians;
  const maxTechnicians = max === null || max === undefined ? null : Number(max);
  return {
    features,
    maxTechnicians: maxTechnicians !== null && Number.isFinite(maxTechnicians) && maxTechnicians > 0 ? maxTechnicians : null,
  };
}

async function loadEntitlements(partnerId: string): Promise<Entitlements> {
  try {
    const result = await systemRead(() => db.execute(sql`
      SELECT features, max_technicians FROM colonyn_bridge.entitlements WHERE partner_id = ${partnerId} LIMIT 1
    `));
    return parseEntitlementRow(rowsOf(result)[0]);
  } catch (err) {
    if (isMissingRelationError(err)) {
      if (!missingTableLogged) {
        missingTableLogged = true;
        console.warn('[colonyn] colonyn_bridge.entitlements not found; plan modules are not enforced until the Bridge creates it');
      }
      return UNRESTRICTED;
    }
    throw err;
  }
}

export async function getEntitlements(partnerId: string, now: number = Date.now()): Promise<Entitlements> {
  if (!entitlementsEnforced()) return UNRESTRICTED;
  const hit = entitlementCache.get(partnerId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = await loadEntitlements(partnerId);
  remember(entitlementCache, partnerId, { value, at: now });
  return value;
}

export async function hasFeature(partnerId: string | null | undefined, feature: ColonynFeature): Promise<boolean> {
  if (!partnerId) return true;
  const { features } = await getEntitlements(partnerId);
  return features === null || features.has(feature);
}

export async function partnerIdForOrg(orgId: string | null | undefined, now: number = Date.now()): Promise<string | null> {
  if (!orgId || !entitlementsEnforced()) return null;
  const hit = orgPartnerCache.get(orgId);
  if (hit && now - hit.at < TTL_MS * 10) return hit.partnerId;
  const result = await systemRead(() => db.execute(sql`SELECT partner_id FROM organizations WHERE id = ${orgId} LIMIT 1`));
  const partnerId = (rowsOf(result)[0]?.partner_id as string | undefined) ?? null;
  remember(orgPartnerCache, orgId, { partnerId, at: now });
  return partnerId;
}

/** Org-scoped variant for workers that only know the organization. */
export async function orgHasFeature(orgId: string, feature: ColonynFeature): Promise<boolean> {
  return hasFeature(await partnerIdForOrg(orgId), feature);
}

/** Staff seats in use: distinct active or invited users with a membership in the partner or one of its orgs. */
export async function countTechnicians(partnerId: string): Promise<number> {
  const result = await systemRead(() => db.execute(sql`
    SELECT count(DISTINCT u.id)::int AS n
    FROM users u
    WHERE u.status IN ('active', 'invited')
      AND u.is_platform_admin = false
      AND (
        EXISTS (SELECT 1 FROM partner_users pu WHERE pu.user_id = u.id AND pu.partner_id = ${partnerId})
        OR EXISTS (
          SELECT 1 FROM organization_users ou JOIN organizations o ON o.id = ou.org_id
          WHERE ou.user_id = u.id AND o.partner_id = ${partnerId}
        )
      )
  `));
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/** Whether this e-mail already holds a seat in the partner (re-inviting it adds nothing). */
export async function holdsSeat(partnerId: string, email: string): Promise<boolean> {
  const result = await systemRead(() => db.execute(sql`
    SELECT 1 FROM users u
    WHERE lower(u.email) = lower(${email}) AND u.status IN ('active', 'invited')
      AND (
        EXISTS (SELECT 1 FROM partner_users pu WHERE pu.user_id = u.id AND pu.partner_id = ${partnerId})
        OR EXISTS (
          SELECT 1 FROM organization_users ou JOIN organizations o ON o.id = ou.org_id
          WHERE ou.user_id = u.id AND o.partner_id = ${partnerId}
        )
      )
    LIMIT 1
  `));
  return rowsOf(result).length > 0;
}

export function invalidateEntitlements(partnerId?: string): void {
  if (partnerId) entitlementCache.delete(partnerId);
  else entitlementCache.clear();
}

export const __test = {
  reset() {
    entitlementCache.clear();
    orgPartnerCache.clear();
    missingTableLogged = false;
  },
};
