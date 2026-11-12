import type { BridgeConfig } from './config';
import { sign } from './signing';

/**
 * Push a lifecycle event to Odoo (best effort, 3 attempts with backoff).
 * Odoo verifies the same X-Colonyn-* signature scheme it uses towards the bridge.
 */
export async function notifyOdoo(
  config: BridgeConfig,
  event: string,
  payload: { subscription_ref: string | null; partner_id: string; data: Record<string, unknown> },
): Promise<boolean> {
  if (!config.odooWebhookUrl || !config.odooWebhookSecret) return false;

  const url = new URL(config.odooWebhookUrl);
  const body = JSON.stringify({ event, ...payload, sent_at: new Date().toISOString() });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(config.odooWebhookSecret, timestamp, 'POST', url.pathname + url.search, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-colonyn-timestamp': timestamp,
          'x-colonyn-signature': signature,
        },
        body,
        signal: controller.signal,
      });
      if (res.ok) return true;
      console.warn(`[colonyn-bridge] Odoo webhook ${event} attempt ${attempt} -> HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[colonyn-bridge] Odoo webhook ${event} attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  return false;
}
