import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db } from '../../db';

/**
 * The bridge keeps its own small schema (`colonyn_bridge`) next to Breeze's
 * tables. It never alters a Breeze table: the mapping between an Odoo
 * subscription and a Breeze partner lives here, and so does an append-only
 * event log for support.
 *
 * The schema is created with the superuser connection (DATABASE_URL) once at
 * start-up and granted to `breeze_app`, so the mapping row can be written in
 * the SAME transaction that creates the partner (request pool role).
 */
export async function ensureBridgeSchema(adminDatabaseUrl: string): Promise<void> {
  const admin = postgres(adminDatabaseUrl, { max: 1, onnotice: () => {}, connection: { application_name: 'colonyn-bridge-bootstrap' } });
  try {
    await admin.unsafe(`
      CREATE SCHEMA IF NOT EXISTS colonyn_bridge;

      CREATE TABLE IF NOT EXISTS colonyn_bridge.tenants (
        subscription_ref text PRIMARY KEY,
        partner_id uuid NOT NULL UNIQUE,
        admin_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_invite_sent_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS colonyn_bridge.events (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL DEFAULT now(),
        subscription_ref text,
        partner_id uuid,
        action text NOT NULL,
        outcome text NOT NULL,
        detail jsonb
      );
      CREATE INDEX IF NOT EXISTS colonyn_bridge_events_ref_idx ON colonyn_bridge.events (subscription_ref, at DESC);

      -- Plan modules and technician seats per partner (read by the API, see
      -- apps/api/src/colonyn/entitlements). No row = no Colonyn restriction.
      CREATE TABLE IF NOT EXISTS colonyn_bridge.entitlements (
        partner_id uuid PRIMARY KEY REFERENCES public.partners(id) ON DELETE CASCADE,
        features text[] NOT NULL DEFAULT '{}',
        max_technicians integer CHECK (max_technicians IS NULL OR max_technicians >= 1),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- Service desk mode the bridge switched off because the plan lost PSA
      -- ('native' or 'external:<psa connection id>'), restored when PSA returns.
      ALTER TABLE colonyn_bridge.tenants ADD COLUMN IF NOT EXISTS previous_service_mode text;

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
          GRANT USAGE ON SCHEMA colonyn_bridge TO breeze_app;
          GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA colonyn_bridge TO breeze_app;
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA colonyn_bridge TO breeze_app;
        END IF;
      END $$;
    `);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export interface TenantMapping {
  subscriptionRef: string;
  partnerId: string;
  adminUserId: string;
  createdAt: Date;
  lastInviteSentAt: Date | null;
}

function rowToMapping(row: Record<string, unknown>): TenantMapping {
  return {
    subscriptionRef: String(row.subscription_ref),
    partnerId: String(row.partner_id),
    adminUserId: String(row.admin_user_id),
    createdAt: new Date(String(row.created_at)),
    lastInviteSentAt: row.last_invite_sent_at ? new Date(String(row.last_invite_sent_at)) : null,
  };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Must be called inside a DB access context (uses the ambient transaction). */
export async function findMappingByRef(subscriptionRef: string): Promise<TenantMapping | null> {
  const result = await db.execute(sql`
    SELECT subscription_ref, partner_id, admin_user_id, created_at, last_invite_sent_at
    FROM colonyn_bridge.tenants WHERE subscription_ref = ${subscriptionRef} LIMIT 1
  `);
  const row = rowsOf(result)[0];
  return row ? rowToMapping(row) : null;
}

/** Must be called inside a DB access context (uses the ambient transaction). */
export async function insertMapping(input: { subscriptionRef: string; partnerId: string; adminUserId: string }): Promise<void> {
  await db.execute(sql`
    INSERT INTO colonyn_bridge.tenants (subscription_ref, partner_id, admin_user_id)
    VALUES (${input.subscriptionRef}, ${input.partnerId}, ${input.adminUserId})
  `);
}

/** Must be called inside a DB access context. */
export async function touchInviteSent(subscriptionRef: string, adminUserId?: string): Promise<void> {
  if (adminUserId) {
    await db.execute(sql`
      UPDATE colonyn_bridge.tenants
      SET last_invite_sent_at = now(), updated_at = now(), admin_user_id = ${adminUserId}
      WHERE subscription_ref = ${subscriptionRef}
    `);
    return;
  }
  await db.execute(sql`
    UPDATE colonyn_bridge.tenants SET last_invite_sent_at = now(), updated_at = now()
    WHERE subscription_ref = ${subscriptionRef}
  `);
}

/** Must be called inside a DB access context. */
export async function logEvent(input: {
  subscriptionRef: string | null;
  partnerId: string | null;
  action: string;
  outcome: 'ok' | 'noop' | 'error';
  detail?: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO colonyn_bridge.events (subscription_ref, partner_id, action, outcome, detail)
    VALUES (${input.subscriptionRef}, ${input.partnerId}, ${input.action}, ${input.outcome},
            ${JSON.stringify(input.detail ?? {})}::jsonb)
  `);
}

export interface EntitlementRow {
  features: string[];
  maxTechnicians: number | null;
}

/** Must be called inside a DB access context. */
export async function readEntitlementRow(partnerId: string): Promise<EntitlementRow | null> {
  const row = rowsOf(await db.execute(sql`
    SELECT features, max_technicians FROM colonyn_bridge.entitlements WHERE partner_id = ${partnerId} LIMIT 1
  `))[0];
  if (!row) return null;
  const raw = row.features;
  const features = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return { features, maxTechnicians: row.max_technicians === null || row.max_technicians === undefined ? null : Number(row.max_technicians) };
}

/** Must be called inside a DB access context. */
export async function upsertEntitlementRow(partnerId: string, features: readonly string[], maxTechnicians: number | null): Promise<void> {
  const literal = `{${features.join(',')}}`;
  await db.execute(sql`
    INSERT INTO colonyn_bridge.entitlements (partner_id, features, max_technicians, updated_at)
    VALUES (${partnerId}, ${literal}::text[], ${maxTechnicians}, now())
    ON CONFLICT (partner_id) DO UPDATE
      SET features = EXCLUDED.features, max_technicians = EXCLUDED.max_technicians, updated_at = now()
  `);
}

/** Must be called inside a DB access context. */
export async function readPreviousServiceMode(subscriptionRef: string): Promise<string | null> {
  const row = rowsOf(await db.execute(sql`
    SELECT previous_service_mode FROM colonyn_bridge.tenants WHERE subscription_ref = ${subscriptionRef} LIMIT 1
  `))[0];
  return (row?.previous_service_mode as string | null | undefined) ?? null;
}

/** Must be called inside a DB access context. */
export async function writePreviousServiceMode(subscriptionRef: string, value: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE colonyn_bridge.tenants SET previous_service_mode = ${value}, updated_at = now()
    WHERE subscription_ref = ${subscriptionRef}
  `);
}

export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
