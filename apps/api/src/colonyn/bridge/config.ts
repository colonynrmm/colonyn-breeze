/**
 * Colonyn Bridge configuration.
 *
 * The bridge runs from the same image and environment as the Breeze API (it is
 * a second tsup entry, like `dist/worker.cjs`), so database, Redis and e-mail
 * settings come from the Breeze variables. Only the COLONYN_* values below are
 * bridge-specific.
 */

export interface BridgeConfig {
  port: number;
  /** Bearer token Odoo sends on every call. */
  apiToken: string;
  /** HMAC secret for request signatures from Odoo. */
  hmacSecret: string;
  /** Allowed clock skew for signed requests, in seconds. */
  maxSkewSeconds: number;
  /** Where lifecycle events are pushed (Odoo controller). Optional. */
  odooWebhookUrl: string | null;
  /** HMAC secret for events pushed to Odoo. */
  odooWebhookSecret: string | null;
  /** Secret Breeze uses to sign partner hooks (PARTNER_HOOKS_SECRET). */
  partnerHooksSecret: string | null;
  /** Partner whose saved e-mail templates are copied to every new tenant. */
  templatePartnerId: string | null;
  /** Shown as the inviter in the activation e-mail. */
  inviterName: string;
  /** Returned to Breeze on the device-limit hook (upgrade page in Odoo). */
  upgradeUrl: string | null;
  /** Public dashboard URL, used for login links in responses. */
  appUrl: string;
  /** Superuser connection used only to create the bridge's own schema. */
  adminDatabaseUrl: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[colonyn-bridge] ${name} is required`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadBridgeConfig(): BridgeConfig {
  const apiToken = required('COLONYN_BRIDGE_TOKEN');
  const hmacSecret = required('COLONYN_BRIDGE_HMAC_SECRET');
  if (apiToken.length < 32 || hmacSecret.length < 32) {
    throw new Error('[colonyn-bridge] COLONYN_BRIDGE_TOKEN and COLONYN_BRIDGE_HMAC_SECRET must be at least 32 characters');
  }

  const templatePartnerId = optional('COLONYN_TEMPLATE_PARTNER_ID');
  if (templatePartnerId && !UUID_RE.test(templatePartnerId)) {
    throw new Error('[colonyn-bridge] COLONYN_TEMPLATE_PARTNER_ID must be a partner UUID');
  }

  const appUrl = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');

  return {
    port: Number.parseInt(process.env.COLONYN_BRIDGE_PORT ?? '3010', 10) || 3010,
    apiToken,
    hmacSecret,
    maxSkewSeconds: Number.parseInt(process.env.COLONYN_BRIDGE_MAX_SKEW_SECONDS ?? '300', 10) || 300,
    odooWebhookUrl: optional('COLONYN_ODOO_WEBHOOK_URL'),
    odooWebhookSecret: optional('COLONYN_ODOO_WEBHOOK_SECRET'),
    partnerHooksSecret: optional('PARTNER_HOOKS_SECRET'),
    templatePartnerId,
    inviterName: optional('COLONYN_INVITER_NAME') ?? 'Tim Colonyn',
    upgradeUrl: optional('COLONYN_UPGRADE_URL'),
    appUrl,
    adminDatabaseUrl: required('DATABASE_URL'),
  };
}
