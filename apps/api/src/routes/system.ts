import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import { API_VERSION } from '../version';
import { semverCompare } from '@breeze/shared';
import { getLatestVersion } from '../services/latestVersion';
import { getBinariesVersion } from '../services/binarySource';

export const systemRoutes = new Hono();

systemRoutes.use('*', authMiddleware);

systemRoutes.get('/version', async (c) => {
  const { latest: upstreamLatest, fetchedAt, source } = await getLatestVersion();
  // COLONYN: the newest upstream Breeze release is operator information. Tenants
  // would read it as "Colonyn is out of date", so only platform admins get it.
  const auth = c.get('auth');
  const seesUpstream = auth?.scope === 'system' || auth?.user?.isPlatformAdmin === true;
  const latest = seesUpstream ? upstreamLatest : null;
  const cmp = latest ? semverCompare(API_VERSION, latest) : null;
  const isStale = cmp !== null && cmp < 0;
  return c.json({
    version: API_VERSION,
    // The agent-binaries release this server serves; differs from `version`
    // only on a server-only release image.
    binariesVersion: getBinariesVersion(),
    latest,
    isStale,
    latestFetchedAt: fetchedAt.toISOString(),
    latestSource: source,
  });
});

// POST /system/setup-complete — marks the current user's setup as complete
systemRoutes.post('/setup-complete', async (c) => {
  const auth = c.get('auth');

  try {
    await db
      .update(users)
      .set({ setupCompletedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, auth.user.id));

    return c.json({ success: true });
  } catch (error) {
    console.error('[system] Failed to mark setup complete:', error);
    return c.json({ error: 'Failed to complete setup' }, 500);
  }
});
