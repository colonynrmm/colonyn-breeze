import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
vi.mock('../../db', () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

import { entitlementDenial, technicianLimitDenial } from './guard';
import { __test, getEntitlements, hasFeature, parseEntitlementRow, UNRESTRICTED } from './store';
import { colonynPlanInfo } from './planInfo';

/** Answers the SQL the store issues, by recognising the table it reads. */
function database(opts: {
  entitlements?: Record<string, unknown> | null | Error;
  technicians?: number;
  seatHolders?: string[];
}) {
  execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
    const text = JSON.stringify(query?.queryChunks ?? query);
    if (text.includes('colonyn_bridge.entitlements')) {
      if (opts.entitlements instanceof Error) throw opts.entitlements;
      return opts.entitlements ? [opts.entitlements] : [];
    }
    if (text.includes('count(DISTINCT')) return [{ n: opts.technicians ?? 0 }];
    if (text.includes('lower(u.email)')) {
      const email = (query.queryChunks ?? []).find((c) => typeof c === 'string' && c.includes('@'));
      return opts.seatHolders?.includes(String(email)) ? [{ '?column?': 1 }] : [];
    }
    if (text.includes('FROM organizations')) return [{ partner_id: 'p-org' }];
    return [];
  });
}

beforeEach(() => {
  process.env.COLONYN_ENTITLEMENTS = 'on';
  execute.mockReset();
  __test.reset();
  delete process.env.COLONYN_UPGRADE_URL;
});

describe('parseEntitlementRow', () => {
  it('treats a missing row as unrestricted', () => {
    expect(parseEntitlementRow(undefined)).toEqual(UNRESTRICTED);
  });
  it('reads arrays and postgres array literals, dropping unknown keys', () => {
    expect([...parseEntitlementRow({ features: ['psa', 'bogus'], max_technicians: 3 }).features!]).toEqual(['psa']);
    expect([...parseEntitlementRow({ features: '{ai,backup}', max_technicians: null }).features!]).toEqual(['ai', 'backup']);
    expect(parseEntitlementRow({ features: [], max_technicians: null }).features!.size).toBe(0);
  });
  it('ignores non-positive technician limits', () => {
    expect(parseEntitlementRow({ features: [], max_technicians: 0 }).maxTechnicians).toBeNull();
    expect(parseEntitlementRow({ features: [], max_technicians: 5 }).maxTechnicians).toBe(5);
  });
});

describe('getEntitlements', () => {
  it('caches per partner for 30 seconds', async () => {
    database({ entitlements: { features: ['psa'], max_technicians: null } });
    await getEntitlements('p1', 1_000);
    await getEntitlements('p1', 20_000);
    expect(execute).toHaveBeenCalledTimes(1);
    await getEntitlements('p1', 40_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('is unrestricted while the Bridge has not created the table', async () => {
    database({ entitlements: Object.assign(new Error('relation does not exist'), { code: '42P01' }) });
    expect(await getEntitlements('p1')).toEqual(UNRESTRICTED);
    expect(await hasFeature('p1', 'ai')).toBe(true);
  });
  it('throws other database errors', async () => {
    database({ entitlements: Object.assign(new Error('connection reset'), { code: '08006' }) });
    await expect(getEntitlements('p1')).rejects.toThrow('connection reset');
  });
});

describe('entitlementDenial', () => {
  it('lets core paths, platform admins and partner-less requests through without a lookup', async () => {
    database({ entitlements: { features: [], max_technicians: null } });
    expect(await entitlementDenial({ path: '/api/v1/devices', partnerId: 'p1' })).toBeNull();
    expect(await entitlementDenial({ path: '/api/v1/tickets', partnerId: 'p1', bypass: true })).toBeNull();
    expect(await entitlementDenial({ path: '/api/v1/tickets', partnerId: null })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows partners without a Colonyn row', async () => {
    database({ entitlements: null });
    expect(await entitlementDenial({ path: '/api/v1/tickets', partnerId: 'p1' })).toBeNull();
  });

  it('allows modules in the plan and denies the others with an upgrade link', async () => {
    process.env.COLONYN_UPGRADE_URL = 'https://www.colonyn.com/my/rmm';
    database({ entitlements: { features: ['psa'], max_technicians: null } });
    expect(await entitlementDenial({ path: '/api/v1/tickets/1', partnerId: 'p1' })).toBeNull();
    const denial = await entitlementDenial({ path: '/api/v1/ai/sessions', partnerId: 'p1' });
    expect(denial?.status).toBe(403);
    expect(denial?.body).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', feature: 'ai', upgradeUrl: 'https://www.colonyn.com/my/rmm' });
  });

  it('fails closed with 503 when the plan cannot be read', async () => {
    database({ entitlements: Object.assign(new Error('timeout'), { code: '57014' }) });
    const denial = await entitlementDenial({ path: '/api/v1/backup/configs', partnerId: 'p1' });
    expect(denial?.status).toBe(503);
    expect(denial?.body.code).toBe('ENTITLEMENT_UNAVAILABLE');
  });
});

describe('technicianLimitDenial', () => {
  it('passes without a limit', async () => {
    database({ entitlements: { features: [], max_technicians: null }, technicians: 99 });
    expect(await technicianLimitDenial({ partnerId: 'p1', email: 'new@x.id' })).toBeNull();
  });
  it('passes below the limit and for existing members', async () => {
    database({ entitlements: { features: [], max_technicians: 2 }, technicians: 1 });
    expect(await technicianLimitDenial({ partnerId: 'p1', email: 'new@x.id' })).toBeNull();
    __test.reset();
    database({ entitlements: { features: [], max_technicians: 2 }, technicians: 2, seatHolders: ['old@x.id'] });
    expect(await technicianLimitDenial({ partnerId: 'p1', email: 'old@x.id' })).toBeNull();
  });
  it('denies a new seat at the limit', async () => {
    database({ entitlements: { features: [], max_technicians: 2 }, technicians: 2 });
    const denial = await technicianLimitDenial({ partnerId: 'p1', email: 'new@x.id' });
    expect(denial?.status).toBe(403);
    expect(denial?.body).toMatchObject({ code: 'TECHNICIAN_LIMIT', limit: 2, used: 2 });
  });
  it('is bypassed for platform admins', async () => {
    database({ entitlements: { features: [], max_technicians: 1 }, technicians: 5 });
    expect(await technicianLimitDenial({ partnerId: 'p1', email: 'a@x.id', bypass: true })).toBeNull();
  });
});

describe('kill switch', () => {
  it('COLONYN_ENTITLEMENTS=off lets everything through without touching the database', async () => {
    process.env.COLONYN_ENTITLEMENTS = 'off';
    database({ entitlements: { features: [], max_technicians: 1 }, technicians: 9 });
    expect(await entitlementDenial({ path: '/api/v1/tickets', partnerId: 'p1' })).toBeNull();
    expect(await technicianLimitDenial({ partnerId: 'p1', email: 'n@x.id' })).toBeNull();
    expect(await hasFeature('p1', 'psa')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('colonynPlanInfo', () => {
  it('lists modules in a stable order with seat usage', async () => {
    database({ entitlements: { features: ['backup', 'psa'], max_technicians: 3 }, technicians: 2 });
    expect(await colonynPlanInfo('p1')).toEqual({ features: ['psa', 'backup'], maxTechnicians: 3, technicians: 2, upgradeUrl: null });
  });
  it('reports unrestricted partners and swallows errors', async () => {
    database({ entitlements: null });
    expect((await colonynPlanInfo('p1'))?.features).toBeNull();
    __test.reset();
    database({ entitlements: new Error('boom') });
    expect(await colonynPlanInfo('p1')).toBeNull();
  });
});
