import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../../services/billingProfileService', () => ({ ensureDefaultProfile: vi.fn() }));
vi.mock('../../services/orgCurrencyService', () => ({ changeOrgCurrency: vi.fn(), getOrgCurrencyImpact: vi.fn() }));

import { formatBackfillReport, manualReason } from './currencyBackfill';
import { loadBridgeConfig } from './config';
import type { OrgCurrencyImpact } from '../../services/orgCurrencyService';

function impact(over: Partial<OrgCurrencyImpact> = {}, warnings: Partial<OrgCurrencyImpact['configurationWarnings']> = {}): OrgCurrencyImpact {
  return {
    orgId: 'o1', currentCurrencyCode: 'USD', targetCurrencyCode: 'IDR', changeRequired: true, impactsByCurrency: [],
    configurationWarnings: {
      assignedBillingProfile: { id: null, currencyCode: null, currencyMismatch: false },
      orgCatalogOverridesSkipped: 0,
      ...warnings,
    },
    ...over,
  } as OrgCurrencyImpact;
}

describe('manualReason', () => {
  it('moves an organization with nothing stamped in another currency', () => {
    expect(manualReason(impact())).toBeNull();
  });
  it('leaves organizations with old-currency documents to the partner', () => {
    expect(manualReason(impact({ impactsByCurrency: [{ currencyCode: 'USD' } as never] }))).toMatch(/USD/);
  });
  it('leaves organizations whose assigned rate profile or price overrides would be skipped', () => {
    expect(manualReason(impact({}, { assignedBillingProfile: { id: 'b', currencyCode: 'USD', currencyMismatch: true } }))).toMatch(/rate profile/);
    expect(manualReason(impact({}, { orgCatalogOverridesSkipped: 2 }))).toMatch(/2 catalog/);
  });
});

describe('formatBackfillReport', () => {
  it('says a preview wrote nothing', () => {
    const text = formatBackfillReport({ currency: 'IDR', applied: false, partners: [{ id: 'p', name: 'Acme', from: 'USD' }], orgsChanged: [], orgsManual: [] });
    expect(text).toContain('preview, nothing written');
    expect(text).toContain('Acme (USD -> IDR)');
    expect(text).toContain('--apply');
  });
});

describe('bridge default currency', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  const base = () => {
    process.env.COLONYN_BRIDGE_TOKEN = 'a'.repeat(32);
    process.env.COLONYN_BRIDGE_HMAC_SECRET = 'b'.repeat(32);
    process.env.DATABASE_URL = 'postgres://x';
  };
  it('defaults to IDR', () => {
    base();
    delete process.env.COLONYN_DEFAULT_CURRENCY;
    expect(loadBridgeConfig().defaultCurrency).toBe('IDR');
  });
  it('accepts another known currency and rejects unknown codes', () => {
    base();
    process.env.COLONYN_DEFAULT_CURRENCY = 'sgd';
    expect(loadBridgeConfig().defaultCurrency).toBe('SGD');
    process.env.COLONYN_DEFAULT_CURRENCY = 'XYZ';
    expect(() => loadBridgeConfig()).toThrow(/not a supported currency/);
  });
});
