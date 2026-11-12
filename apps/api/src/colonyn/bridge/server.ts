/**
 * Colonyn Bridge entry point -> dist/colonyn-bridge.cjs
 *
 * Runs from the Colonyn build of the Breeze API image with the same
 * environment as the `api` service:
 *
 *   command: ["node", "dist/colonyn-bridge.cjs"]
 *
 * It listens on COLONYN_BRIDGE_PORT (default 3010) inside the compose network
 * and is published to Odoo only through Caddy with an IP allow-list.
 */
import { serve } from '@hono/node-server';
import { loadBridgeConfig } from './config';
import { createBridgeApp } from './app';
import { ensureBridgeSchema } from './store';

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  await ensureBridgeSchema(config.adminDatabaseUrl);

  const app = createBridgeApp(config);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`[colonyn-bridge] listening on :${info.port} (dashboard ${config.appUrl})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[colonyn-bridge] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[colonyn-bridge] failed to start:', err);
  process.exit(1);
});
