import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOUNT_CLASSIFICATION, featureForPath, toApiRelativePath } from './featureMap';

/**
 * Upgrade guard: every router Breeze mounts must be classified, and the rules
 * must agree with the classification. When a Breeze upgrade adds a router this
 * test fails until someone decides which Colonyn module it belongs to.
 */
const indexSource = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
const mounts = [...indexSource.matchAll(/\b(?:api|app)\.route\(\s*'([^']*)'\s*,\s*([A-Za-z0-9_]+)/g)].map((m) => ({
  prefix: toApiRelativePath(m[1]!),
  router: m[2]!,
}));

describe('Colonyn feature map vs. index.ts', () => {
  it('finds the mounts', () => {
    expect(mounts.length).toBeGreaterThan(150);
  });

  it('classifies every mounted router', () => {
    const unclassified = [...new Set(mounts.map((m) => m.router))].filter((r) => !(r in MOUNT_CLASSIFICATION));
    expect(unclassified, `classify these routers in featureMap.ts MOUNT_CLASSIFICATION`).toEqual([]);
  });

  it('has no stale classifications', () => {
    const mounted = new Set(mounts.map((m) => m.router));
    const stale = Object.keys(MOUNT_CLASSIFICATION).filter((r) => !mounted.has(r));
    expect(stale).toEqual([]);
  });

  it('gates whole-module routers at their prefix', () => {
    const wrong = mounts
      .filter((m) => m.prefix !== '/' && !['core', 'mixed', 'public'].includes(MOUNT_CLASSIFICATION[m.router]!))
      .filter((m) => featureForPath(m.prefix) !== MOUNT_CLASSIFICATION[m.router]
        || featureForPath(`${m.prefix}/x`) !== MOUNT_CLASSIFICATION[m.router])
      .map((m) => `${m.prefix} (${m.router}) -> ${featureForPath(m.prefix)}, expected ${MOUNT_CLASSIFICATION[m.router]}`);
    expect(wrong).toEqual([]);
  });

  it('never gates core routers', () => {
    const gated = mounts
      .filter((m) => m.prefix !== '/' && MOUNT_CLASSIFICATION[m.router] === 'core')
      .filter((m) => featureForPath(m.prefix) !== null || featureForPath(`${m.prefix}/core-probe`) !== null)
      .map((m) => `${m.prefix} (${m.router}) -> ${featureForPath(m.prefix)}`);
    expect(gated).toEqual([]);
  });
});

describe('featureForPath', () => {
  it.each([
    // PSA, including root-, /orgs- and /portal-mounted paths
    ['/tickets', 'psa'],
    ['/tickets/123/comments', 'psa'],
    ['/ticket-approval-requests/1/decide-on-behalf', 'psa'],
    ['/ticket-forms', 'psa'],
    ['/ticketing/approval-settings', 'psa'],
    ['/time-entries/1/write-off-held', 'psa'],
    ['/contracts/contract-templates', 'psa'],
    ['/invoices', 'psa'],
    ['/billing/autopay', 'psa'],
    ['/billing/reporting-totals', 'psa'],
    ['/partner/billing-settings', 'psa'],
    ['/partner/billing/payment-settings', 'psa'],
    ['/orgs/o1/invoices/assemble', 'psa'],
    ['/orgs/o1/billing-settings', 'psa'],
    ['/orgs/o1/autopay', 'psa'],
    ['/orgs/o1/deliverables/occurrences/x/deliver', 'psa'],
    ['/orgs/o1/documents', 'psa'],
    ['/orgs/o1/trust-page', 'psa'],
    ['/orgs/o1/caller-verifications/1', 'psa'],
    ['/orgs/o1/contacts/c1/caller-verifications', 'psa'],
    ['/orgs/organizations/o1/ticket-settings', 'psa'],
    ['/orgs/organizations/o1/billing-profile', 'psa'],
    ['/portal/tickets/1', 'psa'],
    ['/portal/invoices', 'psa'],
    ['/portal/quotes/1', 'psa'],
    // AI
    ['/ai/sessions', 'ai'],
    ['/ai/admin/tool-executions', 'ai'],
    ['/ai/models/connections', 'ai'],
    ['/mcp', 'ai'],
    ['/fleet/findings', 'ai'],
    ['/partner/ai/script-policy', 'ai'],
    // Backup
    ['/backup/configs', 'backup'],
    ['/c2c/jobs', 'backup'],
    ['/dr/plans', 'backup'],
    ['/portal/backups/overview', 'backup'],
    // Security+
    ['/pam/requests', 'security_plus'],
    ['/dns-security/policies', 'security_plus'],
    ['/audit-baselines', 'security_plus'],
    // Integrations
    ['/api-keys', 'integrations'],
    ['/webhooks', 'integrations'],
    ['/webhooks/abc/deliveries', 'integrations'],
    ['/sso/providers', 'integrations'],
    ['/m365/connections', 'integrations'],
    ['/partner-api/devices', 'integrations'],
  ])('%s -> %s', (path, feature) => {
    expect(featureForPath(path)).toBe(feature);
  });

  it.each([
    '/devices/1',
    '/orgs',
    '/orgs/organizations/o1/effective-settings',
    '/orgs/partners/me',
    '/orgs/o1/key-dates',
    '/partner/me',
    '/partner/sending-domains',
    '/security/dashboard',
    '/vulnerabilities',
    '/playbooks',
    '/alerts',
    '/approvals',
    '/users/invite',
    '/portal/devices',
    '/portal/dashboard',
    '/portal/auth/login',
    '/sso/login/partner',
    '/sso/callback',
    '/sso/exchange',
    '/webhooks/tickets/inbound',
    '/webhooks/stripe/connect',
    '/webhooks/xero',
    '/webhooks/quickbooks',
    '/webhooks/email-provider/resend',
    '/aiming', // prefix rules stop at a path segment
    '/backups-old',
  ])('%s is core', (path) => {
    expect(featureForPath(path)).toBeNull();
  });

  it('strips the API prefix and query', () => {
    expect(toApiRelativePath('/api/v1/tickets')).toBe('/tickets');
    expect(toApiRelativePath('/api/v1')).toBe('/');
    expect(featureForPath('/tickets?status=open')).toBe('psa');
  });
});
