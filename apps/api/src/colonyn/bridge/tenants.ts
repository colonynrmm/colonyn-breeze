import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { ANONYMOUS_ACTOR_ID, INVITE_TOKEN_TTL_SECONDS } from '../../routes/auth/schemas';
import { hashInviteToken, inviteRedisKey, inviteUserRedisKey } from '../../routes/auth/helpers';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, organizations, partners, sites, users } from '../../db/schema';
import { getRedis } from '../../services';
import { createPartner } from '../../services/partnerCreate';
import { getEmailService } from '../../services/email';
import { partnerEmailCustomFromSettings } from '../../services/emailTemplates/renderPartnerEmail';
import { sanitizeRichTextHtmlWithReport } from '../../services/richTextSanitize';
import { abortPartnerOffboardingAroundStatusChange, beginPartnerOffboarding } from '../../services/tenantOffboarding';
import { restorePartnerTenantAccess, revokePartnerTenantAccess } from '../../services/tenantLifecycle';
import { clearPartnerScopePolicyCache } from '../../oauth/partnerScopePolicy';
import { scheduleServingRefreshForPartner } from '../../services/trustPage/servingSet';
import { createAuditLogAsync } from '../../services/auditService';
import { UNASSIGNED_POOL_ORG_TYPE } from '../../services/unassignedPool/orgType';
import { notHiddenOrgType } from '../../services/unassignedPool/visibility';
import type { BridgeConfig } from './config';
import {
  findMappingByRef,
  insertMapping,
  isUniqueViolation,
  logEvent,
  readEntitlementRow,
  readPreviousServiceMode,
  touchInviteSent,
  upsertEntitlementRow,
  writePreviousServiceMode,
  type TenantMapping,
} from './store';
import { COLONYN_FEATURES, type ColonynFeature } from '../entitlements/features';
import { countTechnicians } from '../entitlements/store';

export const PLANS = ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited'] as const;
export type Plan = (typeof PLANS)[number];

export class BridgeError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 422 | 500 | 503, public readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}

export interface Quota {
  plan: Plan;
  maxOrganizations: number | null;
  maxDevices: number | null;
  /** Plan modules. Undefined = leave the current entitlements untouched (older Odoo). */
  features?: ColonynFeature[];
  /** Technician seats; null = unlimited. Only applied together with `features`. */
  maxTechnicians?: number | null;
}

export interface ProvisionInput extends Quota {
  subscriptionRef: string;
  companyName: string;
  adminName: string;
  adminEmail: string;
}

/** Built-in Colonyn copy, used when no template partner is configured or it has none. */
const COLONYN_STAFF_INVITE = {
  subject: '{{inviter_name}} mengundang Anda ke Colonyn RMM',
  heading: 'Undangan bergabung ke Colonyn RMM',
  buttonLabel: 'Aktifkan akun',
  html: [
    '<p>Halo {{name}},</p>',
    '<p>Terima kasih telah berlangganan Colonyn RMM. Akun {{partner_name}} sudah siap. Klik tombol di bawah untuk membuat kata sandi dan mengaktifkan akun Anda.</p>',
    '<p>{{cta_button}}</p>',
    '<p>Undangan ini berlaku {{expires_days}} hari. Jika Anda tidak merasa mendaftar, abaikan email ini atau hubungi support@colonyn.com.</p>',
    '<p>Salam,<br>Tim Colonyn</p>',
  ].join(''),
};

const BRIDGE_ACTOR_EMAIL = 'colonyn-bridge@system';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface TenantView {
  subscription_ref: string;
  partner_id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  max_organizations: number | null;
  max_devices: number | null;
  admin: { user_id: string; email: string; name: string; status: string } | null;
  /** null = no Colonyn restriction recorded for this tenant (every module available). */
  features: ColonynFeature[] | null;
  max_technicians: number | null;
  service_management_mode: string;
  ai_for_office_enabled: boolean;
  usage: { organizations: number; sites: number; devices: number; technicians: number };
  warnings: string[];
  login_url: string;
  created_at: string;
  last_invite_sent_at: string | null;
}

async function requireMapping(subscriptionRef: string): Promise<TenantMapping> {
  const mapping = await withSystemDbAccessContext(() => findMappingByRef(subscriptionRef));
  if (!mapping) throw new BridgeError(404, 'TENANT_NOT_FOUND', `No tenant for subscription ${subscriptionRef}`);
  return mapping;
}

async function countUsage(partnerId: string): Promise<Omit<TenantView['usage'], 'technicians'>> {
  const orgIds = db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt), ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE)));

  const [orgCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      isNull(organizations.deletedAt),
      notHiddenOrgType(),
    ));
  const [siteCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(sites)
    .where(sql`${sites.orgId} IN (${orgIds})`);
  // Same predicate as services/partnerDeviceCapacity.ts (licensed devices).
  const [deviceCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(
      sql`${devices.orgId} IN (${orgIds})`,
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
    ));

  return {
    organizations: orgCount?.value ?? 0,
    sites: siteCount?.value ?? 0,
    devices: deviceCount?.value ?? 0,
  };
}

export async function getTenant(config: BridgeConfig, subscriptionRef: string): Promise<TenantView> {
  const mapping = await requireMapping(subscriptionRef);
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .select({
        id: partners.id,
        name: partners.name,
        slug: partners.slug,
        status: partners.status,
        plan: partners.plan,
        maxOrganizations: partners.maxOrganizations,
        maxDevices: partners.maxDevices,
        serviceManagementMode: partners.serviceManagementMode,
        aiForOfficeEnabled: partners.aiForOfficeEnabled,
        createdAt: partners.createdAt,
      })
      .from(partners)
      .where(eq(partners.id, mapping.partnerId))
      .limit(1);
    if (!partner) throw new BridgeError(404, 'PARTNER_MISSING', 'Mapped partner no longer exists in Breeze');

    const [admin] = await db
      .select({ id: users.id, email: users.email, name: users.name, status: users.status })
      .from(users)
      .where(eq(users.id, mapping.adminUserId))
      .limit(1);

    const entitlements = await readEntitlementRow(partner.id);
    const technicians = await countTechnicians(partner.id);
    const maxTechnicians = entitlements?.maxTechnicians ?? null;
    return {
      subscription_ref: mapping.subscriptionRef,
      partner_id: partner.id,
      name: partner.name,
      slug: partner.slug,
      status: partner.status,
      plan: partner.plan,
      max_organizations: partner.maxOrganizations,
      max_devices: partner.maxDevices,
      admin: admin ? { user_id: admin.id, email: admin.email, name: admin.name, status: admin.status } : null,
      features: entitlements
        ? COLONYN_FEATURES.filter((f) => entitlements.features.includes(f))
        : null,
      max_technicians: maxTechnicians,
      service_management_mode: partner.serviceManagementMode,
      ai_for_office_enabled: partner.aiForOfficeEnabled,
      usage: { ...(await countUsage(partner.id)), technicians },
      warnings: maxTechnicians !== null && technicians > maxTechnicians ? ['TECHNICIANS_OVER_LIMIT'] : [],
      login_url: `${config.appUrl}/login`,
      created_at: partner.createdAt.toISOString(),
      last_invite_sent_at: mapping.lastInviteSentAt ? mapping.lastInviteSentAt.toISOString() : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

async function loadTemplateBag(templatePartnerId: string | null): Promise<Record<string, unknown>> {
  if (!templatePartnerId) return {};
  const [row] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, templatePartnerId))
    .limit(1);
  const bag = (row?.settings as { emailTemplates?: unknown } | null)?.emailTemplates;
  return bag && typeof bag === 'object' && !Array.isArray(bag) ? { ...(bag as Record<string, unknown>) } : {};
}

function sanitizedColonynInvite() {
  const report = sanitizeRichTextHtmlWithReport(COLONYN_STAFF_INVITE.html);
  return { ...COLONYN_STAFF_INVITE, html: report.html };
}

export interface ProvisionResult {
  created: boolean;
  tenant: TenantView;
  invite: { sent: boolean; invite_url?: string; warning?: string };
}

export async function provisionTenant(config: BridgeConfig, input: ProvisionInput): Promise<ProvisionResult> {
  const email = input.adminEmail.trim().toLowerCase();

  // Idempotent replay: the same subscription always maps to the same tenant.
  const existing = await withSystemDbAccessContext(() => findMappingByRef(input.subscriptionRef));
  if (existing) {
    return { created: false, tenant: await getTenant(config, input.subscriptionRef), invite: { sent: false, warning: 'already_provisioned' } };
  }

  let createdIds: { partnerId: string; adminUserId: string; orgId: string };
  try {
    createdIds = await withSystemDbAccessContext(async () => {
      const [emailOwner] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (emailOwner) {
        throw new BridgeError(409, 'EMAIL_IN_USE', 'This e-mail already belongs to a Breeze user');
      }

      const created = await createPartner({
        orgName: input.companyName.trim(),
        adminEmail: email,
        adminName: input.adminName.trim(),
        passwordHash: null,
        origin: { mcp: false, userAgent: 'colonyn-bridge' },
        status: 'active',
      });

      const templates = await loadTemplateBag(config.templatePartnerId);
      if (!templates.staff_invite) templates.staff_invite = sanitizedColonynInvite();

      await db
        .update(partners)
        .set({
          plan: input.plan,
          maxOrganizations: input.maxOrganizations,
          maxDevices: input.maxDevices,
          // Paid, verified-by-payment customers skip the self-signup probation.
          trustState: 'trusted',
          trustChangedAt: new Date(),
          trustReason: 'colonyn_paid_subscription',
          updatedAt: new Date(),
        })
        .where(eq(partners.id, created.partnerId));

      // Only the emailTemplates key is touched, so encrypted settings stay as written.
      await db.execute(sql`
        UPDATE partners
        SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{emailTemplates}', ${JSON.stringify(templates)}::jsonb, true)
        WHERE id = ${created.partnerId}
      `);

      // createPartner() makes an active, password-less admin; the invite flow
      // needs the 'invited' state so /accept-invite lets them set a password.
      await db
        .update(users)
        .set({ status: 'invited', lastLoginAt: null, updatedAt: new Date() })
        .where(eq(users.id, created.adminUserId));

      await insertMapping({ subscriptionRef: input.subscriptionRef, partnerId: created.partnerId, adminUserId: created.adminUserId });
      if (input.features !== undefined) {
        await applyEntitlements(input.subscriptionRef, created.partnerId, input.features, input.maxTechnicians ?? null);
      }
      await logEvent({
        subscriptionRef: input.subscriptionRef,
        partnerId: created.partnerId,
        action: 'provision',
        outcome: 'ok',
        detail: {
          plan: input.plan, maxOrganizations: input.maxOrganizations, maxDevices: input.maxDevices, adminEmail: email,
          features: input.features, maxTechnicians: input.maxTechnicians,
        },
      });

      return { partnerId: created.partnerId, adminUserId: created.adminUserId, orgId: created.orgId };
    });
  } catch (err) {
    // A concurrent call for the same subscription won the race.
    if (isUniqueViolation(err)) {
      const winner = await withSystemDbAccessContext(() => findMappingByRef(input.subscriptionRef));
      if (winner) {
        return { created: false, tenant: await getTenant(config, input.subscriptionRef), invite: { sent: false, warning: 'already_provisioned' } };
      }
      throw new BridgeError(409, 'CONFLICT', 'Tenant could not be created because of a conflicting record');
    }
    throw err;
  }

  audit(createdIds.partnerId, 'colonyn.tenant.provision', input.companyName, {
    subscriptionRef: input.subscriptionRef,
    plan: input.plan,
    maxOrganizations: input.maxOrganizations,
    maxDevices: input.maxDevices,
    features: input.features,
    maxTechnicians: input.maxTechnicians,
  });

  const invite = await deliverInvite(config, {
    subscriptionRef: input.subscriptionRef,
    partnerId: createdIds.partnerId,
    userId: createdIds.adminUserId,
    email,
    name: input.adminName.trim(),
  });

  return { created: true, tenant: await getTenant(config, input.subscriptionRef), invite };
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

function buildInviteUrl(config: BridgeConfig, token: string): string {
  return `${config.appUrl}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** Mirrors routes/users.ts generateInviteToken(): same Redis keys, same TTL. */
async function generateInviteToken(userId: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const existingHash = await redis.get(inviteUserRedisKey(userId));
  if (existingHash) await redis.del(inviteRedisKey(existingHash));
  const token = nanoid(48);
  const tokenHash = hashInviteToken(token);
  await redis.setex(inviteRedisKey(tokenHash), INVITE_TOKEN_TTL_SECONDS, userId);
  await redis.setex(inviteUserRedisKey(userId), INVITE_TOKEN_TTL_SECONDS, tokenHash);
  return token;
}

async function deliverInvite(
  config: BridgeConfig,
  target: { subscriptionRef: string; partnerId: string; userId: string; email: string; name: string },
): Promise<ProvisionResult['invite']> {
  const token = await generateInviteToken(target.userId).catch((err) => {
    console.error('[colonyn-bridge] invite token generation failed:', err);
    return null;
  });
  if (!token) {
    await withSystemDbAccessContext(() => logEvent({ subscriptionRef: target.subscriptionRef, partnerId: target.partnerId, action: 'invite', outcome: 'error', detail: { reason: 'redis_unavailable' } }));
    return { sent: false, warning: 'invite_token_unavailable' };
  }
  const inviteUrl = buildInviteUrl(config, token);

  const partner = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ name: partners.name, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, target.partnerId))
      .limit(1);
    return row;
  });

  const emailService = getEmailService();
  let sent = false;
  let failure: string | undefined;
  if (emailService) {
    try {
      await emailService.sendInvite({
        to: target.email,
        name: target.name,
        inviterName: config.inviterName,
        inviteUrl,
        partnerName: partner?.name,
        expiresDays: Math.round(INVITE_TOKEN_TTL_SECONDS / 86400),
        custom: partnerEmailCustomFromSettings(partner?.settings, 'staff_invite'),
      });
      sent = true;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      console.error(`[colonyn-bridge] invite e-mail to ${target.email} failed:`, failure);
    }
  } else {
    failure = 'email_service_not_configured';
  }

  await withSystemDbAccessContext(async () => {
    if (sent) await touchInviteSent(target.subscriptionRef, target.userId);
    await logEvent({
      subscriptionRef: target.subscriptionRef,
      partnerId: target.partnerId,
      action: 'invite',
      outcome: sent ? 'ok' : 'error',
      detail: sent ? { to: target.email } : { to: target.email, reason: failure },
    });
  });

  // When Breeze could not send the mail, Odoo receives the link and can send it itself.
  return sent ? { sent: true } : { sent: false, invite_url: inviteUrl, warning: failure };
}

export async function resendInvite(
  config: BridgeConfig,
  subscriptionRef: string,
  change: { adminEmail?: string; adminName?: string },
): Promise<ProvisionResult['invite'] & { admin_email: string }> {
  const mapping = await requireMapping(subscriptionRef);

  const admin = await withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({ id: users.id, email: users.email, name: users.name, status: users.status })
      .from(users)
      .where(eq(users.id, mapping.adminUserId))
      .limit(1);
    if (!user) throw new BridgeError(404, 'ADMIN_MISSING', 'Admin user no longer exists');
    if (user.status !== 'invited') {
      throw new BridgeError(409, 'ALREADY_ACCEPTED', 'The admin already activated the account; use password reset instead');
    }

    const nextEmail = change.adminEmail?.trim().toLowerCase();
    const nextName = change.adminName?.trim();
    if ((nextEmail && nextEmail !== user.email) || (nextName && nextName !== user.name)) {
      if (nextEmail && nextEmail !== user.email) {
        const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, nextEmail)).limit(1);
        if (owner) throw new BridgeError(409, 'EMAIL_IN_USE', 'This e-mail already belongs to a Breeze user');
      }
      await db
        .update(users)
        .set({ ...(nextEmail ? { email: nextEmail } : {}), ...(nextName ? { name: nextName } : {}), updatedAt: new Date() })
        .where(eq(users.id, user.id));
      if (nextEmail) {
        await db.update(partners).set({ billingEmail: nextEmail, updatedAt: new Date() }).where(eq(partners.id, mapping.partnerId));
      }
      return { ...user, email: nextEmail ?? user.email, name: nextName ?? user.name };
    }
    return user;
  });

  const invite = await deliverInvite(config, {
    subscriptionRef,
    partnerId: mapping.partnerId,
    userId: admin.id,
    email: admin.email,
    name: admin.name,
  });
  return { ...invite, admin_email: admin.email };
}

// ---------------------------------------------------------------------------
// Plan / quota
// ---------------------------------------------------------------------------

export async function updatePlan(config: BridgeConfig, subscriptionRef: string, quota: Quota): Promise<TenantView> {
  const mapping = await requireMapping(subscriptionRef);
  await withSystemDbAccessContext(async () => {
    await db
      .update(partners)
      .set({ plan: quota.plan, maxOrganizations: quota.maxOrganizations, maxDevices: quota.maxDevices, updatedAt: new Date() })
      .where(and(eq(partners.id, mapping.partnerId), isNull(partners.deletedAt)));
    if (quota.features !== undefined) {
      await applyEntitlements(subscriptionRef, mapping.partnerId, quota.features, quota.maxTechnicians ?? null);
    }
    await logEvent({ subscriptionRef, partnerId: mapping.partnerId, action: 'plan', outcome: 'ok', detail: { ...quota } });
  });
  if (quota.features !== undefined) refreshPartnerCaches(mapping.partnerId, 'colonyn.plan');
  audit(mapping.partnerId, 'colonyn.tenant.plan', subscriptionRef, { ...quota });
  return getTenant(config, subscriptionRef);
}

/**
 * Write the plan modules and their side effects on Breeze's own switches.
 * Must run inside a DB access context (the caller's transaction).
 *
 * - Service desk: losing PSA switches `service_management_mode` off and
 *   remembers what it was; regaining PSA restores it. A tenant that turned
 *   the service desk off by itself (nothing remembered) is left alone.
 * - AI for Office follows the AI module.
 */
async function applyEntitlements(
  subscriptionRef: string,
  partnerId: string,
  features: readonly ColonynFeature[],
  maxTechnicians: number | null,
): Promise<void> {
  const wanted = COLONYN_FEATURES.filter((f) => features.includes(f));
  await upsertEntitlementRow(partnerId, wanted, maxTechnicians);

  const [partner] = await db
    .select({
      mode: partners.serviceManagementMode,
      connectionId: partners.serviceManagementPsaConnectionId,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  if (!partner) throw new BridgeError(404, 'PARTNER_MISSING', 'Mapped partner no longer exists in Breeze');

  const update: Partial<typeof partners.$inferInsert> = { aiForOfficeEnabled: wanted.includes('ai'), updatedAt: new Date() };
  if (!wanted.includes('psa')) {
    if (partner.mode !== 'off') {
      await writePreviousServiceMode(subscriptionRef, partner.mode === 'external' && partner.connectionId ? `external:${partner.connectionId}` : 'native');
      update.serviceManagementMode = 'off';
      update.serviceManagementPsaConnectionId = null;
    }
  } else if (partner.mode === 'off') {
    const previous = await readPreviousServiceMode(subscriptionRef);
    if (previous) {
      const external = previous.startsWith('external:') ? previous.slice('external:'.length) : null;
      update.serviceManagementMode = external ? 'external' : 'native';
      update.serviceManagementPsaConnectionId = external;
      await writePreviousServiceMode(subscriptionRef, null);
    }
  }

  try {
    await db.execute(sql`SAVEPOINT colonyn_service_mode`);
    await db.update(partners).set(update).where(eq(partners.id, partnerId));
    await db.execute(sql`RELEASE SAVEPOINT colonyn_service_mode`);
  } catch (err) {
    // The remembered PSA connection was deleted meanwhile: fall back to the native service desk.
    await db.execute(sql`ROLLBACK TO SAVEPOINT colonyn_service_mode`);
    if (update.serviceManagementMode !== 'external') throw err;
    await db.update(partners)
      .set({ ...update, serviceManagementMode: 'native', serviceManagementPsaConnectionId: null })
      .where(eq(partners.id, partnerId));
  }
}

function refreshPartnerCaches(partnerId: string, reason: string): void {
  scheduleServingRefreshForPartner(partnerId, reason);
  clearPartnerScopePolicyCache(partnerId);
}

// ---------------------------------------------------------------------------
// Lifecycle (mirrors PATCH /orgs/partners/:id status handling in routes/orgs.ts)
// ---------------------------------------------------------------------------

type TargetStatus = 'active' | 'suspended' | 'offboarding';

async function currentStatus(partnerId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ status: partners.status }).from(partners).where(eq(partners.id, partnerId)).limit(1),
  );
  if (!row) throw new BridgeError(404, 'PARTNER_MISSING', 'Mapped partner no longer exists in Breeze');
  return row.status;
}

export async function setStatus(
  config: BridgeConfig,
  subscriptionRef: string,
  target: TargetStatus,
  reason: string | undefined,
): Promise<{ changed: boolean; tenant: TenantView }> {
  const mapping = await requireMapping(subscriptionRef);
  const partnerId = mapping.partnerId;
  const before = await currentStatus(partnerId);

  if (before === target) {
    await withSystemDbAccessContext(() => logEvent({ subscriptionRef, partnerId, action: `status:${target}`, outcome: 'noop', detail: { reason } }));
    return { changed: false, tenant: await getTenant(config, subscriptionRef) };
  }
  if (before === 'churned') {
    throw new BridgeError(409, 'TENANT_CHURNED', 'This tenant has already been closed');
  }
  if (before === 'offboarding' && target === 'suspended') {
    throw new BridgeError(409, 'TENANT_OFFBOARDING', 'A cancelled tenant cannot be suspended; reactivate it first');
  }

  const write = async () => {
    const [row] = await db
      .update(partners)
      .set({ status: target, updatedAt: new Date() })
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .returning({ id: partners.id });
    return row;
  };

  if (target === 'offboarding') {
    await withSystemDbAccessContext(write);
    // Users are signed out now; agents only receive self-uninstall until the
    // drain reaper severs them and flips the partner to churned.
    await beginPartnerOffboarding(partnerId, null);
  } else {
    // Ending a drain (offboarding -> active) cancels the queued uninstalls in
    // the same transaction as the status write (#3996).
    const { statusChange } = await abortPartnerOffboardingAroundStatusChange(partnerId, write);
    if (!statusChange) throw new BridgeError(404, 'PARTNER_MISSING', 'Mapped partner no longer exists in Breeze');
    if (target === 'suspended') await revokePartnerTenantAccess(partnerId);
    else await restorePartnerTenantAccess(partnerId);
  }

  scheduleServingRefreshForPartner(partnerId, 'colonyn.status');
  clearPartnerScopePolicyCache(partnerId);

  await withSystemDbAccessContext(() => logEvent({ subscriptionRef, partnerId, action: `status:${target}`, outcome: 'ok', detail: { from: before, reason } }));
  audit(partnerId, `colonyn.tenant.${target}`, subscriptionRef, { from: before, reason });

  return { changed: true, tenant: await getTenant(config, subscriptionRef) };
}

// ---------------------------------------------------------------------------
// Hooks from Breeze
// ---------------------------------------------------------------------------

export async function subscriptionRefForPartner(partnerId: string): Promise<string | null> {
  const result = await withSystemDbAccessContext(() =>
    db.execute(sql`SELECT subscription_ref FROM colonyn_bridge.tenants WHERE partner_id = ${partnerId} LIMIT 1`),
  );
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as { subscription_ref?: string } | undefined;
  return row?.subscription_ref ?? null;
}

export async function recordHook(partnerId: string, subscriptionRef: string | null, event: string, data: Record<string, unknown>): Promise<void> {
  await withSystemDbAccessContext(() => logEvent({ subscriptionRef, partnerId, action: `hook:${event}`, outcome: 'ok', detail: data }));
}

// ---------------------------------------------------------------------------

function audit(partnerId: string, action: string, resourceName: string, details: Record<string, unknown>): void {
  void createAuditLogAsync({
    partnerId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    actorEmail: BRIDGE_ACTOR_EMAIL,
    action,
    resourceType: 'partner',
    resourceId: partnerId,
    resourceName,
    details,
    result: 'success',
  }).catch((err) => console.error('[colonyn-bridge] audit write failed:', err));
}

// Re-exported for tests.
export const __test = { generateInviteToken, countUsage, COLONYN_STAFF_INVITE };
