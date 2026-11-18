#!/usr/bin/env node
/**
 * Colonyn docs site, generated from the Breeze docs (apps/docs) of the same release.
 *
 *   node colonyn/docs/build-docs.mjs               # transform + build -> colonyn/docs/dist
 *   node colonyn/docs/build-docs.mjs --no-build    # transform only (also refreshes the AI docs index)
 *
 * What it does:
 *  1. Copies apps/docs into colonyn/docs/.work.
 *  2. Keeps the customer-facing sections (Agent onward). Pages about running the
 *     server (install, deploy, upgrades, infrastructure monitoring, server backups,
 *     secrets, source builds) are removed; their URLs redirect to /managed-by-colonyn/.
 *  3. Rebrands the text: "Breeze" -> "Colonyn", except names of the software that
 *     really ships under the Breeze name (agent, viewer, helper, assist, watchdog,
 *     mobile app) and technical identifiers (breeze-agent, BREEZE_*, X-Breeze-*).
 *  4. Writes a Colonyn Starlight config (logo, colours, sidebar, redirects).
 *  5. Builds the static site with the Astro/Starlight versions pinned by Breeze.
 *  6. Rewrites apps/api/src/data/docsIndex.json from the Colonyn pages, so the AI
 *     assistant's documentation search only returns pages that exist on docs.colonyn.com.
 *
 * Fails (exit 2) when an upstream change breaks an assumption, so a Breeze upgrade
 * never ships a half-rebranded docs site.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const upstream = join(root, 'apps', 'docs');
const work = join(here, '.work');
const dist = join(here, 'dist');
const content = join(work, 'src', 'content', 'docs');
const noBuild = process.argv.includes('--no-build');

const SITE = (process.env.COLONYN_DOCS_URL?.trim() || 'https://docs.colonyn.com').replace(/\/$/, '');
const APP_HOST = process.env.COLONYN_APP_HOST?.trim() || 'my.colonyn.com';
const WEBSITE = (process.env.COLONYN_SITE_URL?.trim() || 'https://www.colonyn.com').replace(/\/$/, '');
const SUPPORT_EMAIL = process.env.COLONYN_SUPPORT_EMAIL?.trim() || 'support@colonyn.com';
const SOURCE_REPO = 'https://github.com/colonynrmm/colonyn-breeze';
const MANAGED = '/managed-by-colonyn/';

const problems = [];
const fail = () => {
  if (!problems.length) return;
  console.error('[docs] Upstream docs changed; update colonyn/docs/build-docs.mjs:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
};

// ---------------------------------------------------------------- 1. copy
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const item of ['src', 'public', 'tsconfig.json']) cpSync(join(upstream, item), join(work, item), { recursive: true });

// ---------------------------------------------------------------- 2. scope
// Whole sections about running the server, and single server/operator pages.
const REMOVED_DIRS = ['getting-started', 'deploy', 'contributing', 'monitoring'];
const REMOVED_FILES = [
  'agents/building.mdx', // compiling the agent from source
  'agents/self-host-migration.mdx', // only for self-hosted servers
  'security/backup.mdx', // server database backups
  'security/hardening.mdx', // server hardening checklist
  'security/error-tracking.mdx', // server Sentry configuration
  'security/secrets.mdx', // server secret rotation
  'security/mtls.mdx', // Cloudflare mTLS for the server
  'reference/schema.mdx', // server database schema
  'reference/troubleshooting.mdx', // server deployment issues
  'features/extensions.mdx', // server build flags
];
// Customer-relevant pages from removed sections, kept at their URL and shown under Agent.
const KEPT_FROM_REMOVED = ['deploy/antivirus-exceptions.mdx'];

const routeOf = (rel) => `/${rel.replace(/\.mdx?$/, '').replace(/\/index$/, '')}/`;
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const redirects = {};
const keptCopies = KEPT_FROM_REMOVED.map((rel) => {
  const full = join(content, rel);
  if (!existsSync(full)) problems.push(`${rel}: page to keep not found`);
  return [rel, existsSync(full) ? readFileSync(full, 'utf8') : null];
});
for (const dir of REMOVED_DIRS) {
  const full = join(content, dir);
  if (!existsSync(full)) {
    problems.push(`${dir}/: section not found`);
    continue;
  }
  for (const file of walk(full)) {
    const rel = relative(content, file);
    redirects[routeOf(rel)] = dir === 'getting-started' ? '/' : MANAGED;
  }
  redirects[`/${dir}/`] = dir === 'getting-started' ? '/' : MANAGED;
  rmSync(full, { recursive: true, force: true });
}
for (const rel of REMOVED_FILES) {
  const full = join(content, rel);
  if (!existsSync(full)) problems.push(`${rel}: page to remove not found`);
  rmSync(full, { force: true });
  redirects[routeOf(rel)] = MANAGED;
}
for (const [rel, text] of keptCopies) {
  if (text === null) continue;
  mkdirSync(dirname(join(content, rel)), { recursive: true });
  writeFileSync(join(content, rel), text);
  delete redirects[routeOf(rel)];
}

// Colonyn pages.
cpSync(join(here, 'overrides', 'index.mdx'), join(content, 'index.mdx'));
cpSync(join(here, 'overrides', 'managed-by-colonyn.mdx'), join(content, 'managed-by-colonyn.mdx'));
cpSync(join(here, 'overrides', 'custom.css'), join(work, 'src', 'styles', 'custom.css'));
cpSync(join(here, 'assets', 'logo-light.svg'), join(work, 'src', 'assets', 'logo-light.svg'));
cpSync(join(here, 'assets', 'logo-dark.svg'), join(work, 'src', 'assets', 'logo-dark.svg'));
cpSync(join(here, 'assets', 'favicon.svg'), join(work, 'public', 'favicon.svg'));
rmSync(join(work, 'src', 'components', 'DocsCTABanner.astro'), { force: true }); // "Try Breeze Cloud" banner
rmSync(join(work, 'src', 'assets', 'logo.svg'), { force: true });
rmSync(join(work, 'public', '_headers'), { force: true }); // Cloudflare headers for breezermm.com; Caddy sets ours

// ---------------------------------------------------------------- 3. text
// Names that stay "Breeze": software installed on devices or phones under that name,
// and statements about who signs those binaries.
const KEEP = [
  'Breeze Agent', 'Breeze agent', 'Breeze Viewer', 'Breeze viewer', 'Breeze Helper', 'Breeze helper',
  'Breeze Assist', 'Breeze Watchdog', 'Breeze watchdog', 'Breeze desktop helper', 'Breeze backup agent',
  'Breeze RMM from the App Store', 'Breeze RMM on Google Play', 'Breeze RMM app', 'Breeze mobile app',
  'signed by Breeze', 'notarized by Breeze', 'Breeze Authenticator',
  'every Breeze binary', 'official Breeze releases', 'the Breeze binary',
];
const SECTION_DROP = /^(#{2,4})\s+.*\b(self[- ]host(ed|ing)?|Breeze Cloud)\b.*$/i; // operator-only sub-sections

function dropSections(text) {
  const lines = text.split('\n');
  const out = [];
  let dropLevel = 0;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^(#{1,6})\s/.exec(line);
    if (dropLevel && heading && heading[1].length <= dropLevel) dropLevel = 0;
    if (!dropLevel && !fence) {
      const m = SECTION_DROP.exec(line);
      if (m) {
        dropLevel = m[1].length;
        continue;
      }
    }
    if (!dropLevel) out.push(line);
  }
  return out.join('\n');
}

function rebrand(text) {
  let t = text;
  // Screenshots of the upstream UI carry the Breeze logo.
  t = t.replace(/^import \w+(Screenshot|) from '[^']*assets\/screenshots\/[^']+';\r?\n/gm, '');
  t = t.replace(/^<Image src=\{\w*[Ss]creenshot\}[^>]*\/>\r?\n?/gm, '');
  // Links and addresses.
  t = t.replace(/\[#(\d+)\]\(https:\/\/github\.com\/LanternOps\/breeze\/(?:issues|pull)\/\d+\)/g, 'upstream issue #$1');
  t = t.replace(/https:\/\/github\.com\/LanternOps\/breeze\/(?:issues|pull)\/(\d+)/g, 'upstream issue #$1');
  t = t.replace(/\[([^\]]*)\]\(https:\/\/github\.com\/LanternOps\/breeze[^)]*\)/g, `[Colonyn source code](${SOURCE_REPO})`);
  t = t.replace(/https:\/\/github\.com\/LanternOps\/breeze(?:\/[^\s)`'"]*)?/g, SOURCE_REPO);
  t = t.replace(/https:\/\/docs\.breezermm\.com/g, SITE);
  t = t.replace(/security@breezermm\.com|support@breezermm\.com/g, SUPPORT_EMAIL);
  t = t.replace(/https?:\/\/(?:www\.)?breezermm\.com\/?[^\s)`'"]*/g, WEBSITE);
  t = t.replace(/(?:breeze|rmm)\.(?:yourdomain|example|yourcompany)\.com/g, APP_HOST);
  t = t.replace(/nothing sent to LanternOps unless you opt in/g, 'nothing sent anywhere else');
  // Product name.
  KEEP.forEach((phrase, i) => {
    t = t.split(phrase).join(`\u0000${i}\u0000`);
  });
  t = t.replace(/\bBreeze RMM\b/g, 'Colonyn RMM');
  t = t.replace(/\bBreeze\b/g, 'Colonyn');
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => KEEP[Number(i)]);
  return t;
}

let pages = 0;
for (const file of walk(content)) {
  if (!/\.mdx?$/.test(file)) continue;
  const rel = relative(content, file);
  if (rel === 'index.mdx' || rel === 'managed-by-colonyn.mdx') continue;
  const before = readFileSync(file, 'utf8');
  const after = rebrand(dropSections(before));
  if (after !== before) writeFileSync(file, after);
  pages++;
}

// Anything left that still points users to the upstream product.
for (const file of walk(content)) {
  if (!/\.mdx?$/.test(file)) continue;
  const rel = relative(content, file);
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/breezermm\.com|Breeze Cloud|github\.com\/LanternOps/.test(line)) problems.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
  });
}

// ---------------------------------------------------------------- 4. config
const upstreamConfig = readFileSync(join(upstream, 'astro.config.mjs'), 'utf8');
const sidebarMatch = /sidebar:\s*(\[[\s\S]*\]),\s*\}\),\s*\],\s*\}\);\s*$/.exec(upstreamConfig);
if (!sidebarMatch) problems.push('astro.config.mjs: sidebar block not found');
const redirectMatch = /redirects:\s*(\{[\s\S]*?\n  \}),/.exec(upstreamConfig);
if (!redirectMatch) problems.push('astro.config.mjs: redirects block not found');
fail();

// eslint-disable-next-line no-new-func
const sidebar = Function(`return ${sidebarMatch[1]};`)();
const upstreamRedirects = Function(`return ${redirectMatch[1]};`)();
const DROPPED_GROUPS = new Set(['Getting Started', 'Deployment', 'Contributing', 'Monitoring', 'Migrating to Breeze']);
const existingSlugs = new Set(
  [...walk(content)].filter((f) => /\.mdx?$/.test(f)).map((f) => relative(content, f).replace(/\.mdx?$/, '')),
);
function prune(items) {
  return items
    .map((item) => {
      if (item.slug) return existingSlugs.has(item.slug) ? item : null;
      if (item.items) {
        const kept = prune(item.items);
        return kept.length ? { ...item, items: kept } : null;
      }
      return item; // autogenerate entries
    })
    .filter(Boolean);
}
const colonynSidebar = prune(sidebar.filter((group) => !DROPPED_GROUPS.has(group.label))).map((group) => {
  if (group.label === 'Agent') return { ...group, items: [...group.items, { slug: 'deploy/antivirus-exceptions' }] };
  if (group.label === 'Migration') return { ...group, label: 'Migrating to Colonyn' };
  return group;
});
if (!colonynSidebar.some((g) => g.label === 'Agent')) problems.push('sidebar: Agent group not found');
// Sidebar items that point at removed pages silently vanish; warn so new upstream pages are reviewed.
const sidebarSlugs = JSON.stringify(sidebar).match(/"slug":"[^"]+"/g) ?? [];
for (const s of sidebarSlugs) {
  const slug = s.slice(8, -1);
  if (!existingSlugs.has(slug) && !REMOVED_FILES.includes(`${slug}.mdx`) && !REMOVED_DIRS.some((d) => slug.startsWith(`${d}/`))) {
    problems.push(`sidebar slug without a page: ${slug}`);
  }
}
fail();

const config = `// Generated by colonyn/docs/build-docs.mjs. Do not edit; change the generator instead.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: ${JSON.stringify(SITE)},
  // No raster images are processed (upstream screenshots are dropped), so no sharp build is needed.
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  redirects: ${JSON.stringify({ ...upstreamRedirects, ...redirects }, null, 2).replace(/\n/g, '\n  ')},
  integrations: [
    starlight({
      title: 'Colonyn RMM',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        alt: 'Colonyn',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap' } },
      ],
      customCss: ['./src/styles/custom.css'],
      social: [
        { icon: 'external', label: 'my.colonyn.com', href: 'https://${APP_HOST}' },
      ],
      lastUpdated: false,
      sidebar: ${JSON.stringify(colonynSidebar, null, 2).replace(/\n/g, '\n      ')},
    }),
  ],
});
`;
writeFileSync(join(work, 'astro.config.mjs'), config);

// Same Astro / Starlight / sharp versions Breeze resolves in pnpm-lock.yaml.
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
const pin = (name) => {
  const m = new RegExp(`^  '?${name.replace('/', '\\/')}@(\\d+\\.\\d+\\.\\d+)'?:`, 'm').exec(lock);
  if (!m) problems.push(`pnpm-lock.yaml: ${name} version not found`);
  return m?.[1];
};
const pkg = {
  name: 'colonyn-docs',
  private: true,
  type: 'module',
  scripts: { build: 'astro build' },
  dependencies: { '@astrojs/starlight': pin('@astrojs/starlight'), astro: pin('astro') },
};
fail();
writeFileSync(join(work, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

// ---------------------------------------------------------------- 6. AI docs index
// Same shape as scripts/build-docs-index.ts, from the Colonyn pages.
const INDEX_SECTIONS = new Set(['agents', 'security', 'features', 'backup', 'reference', 'deploy']);
const index = [];
for (const file of walk(content)) {
  if (!file.endsWith('.mdx')) continue;
  const rel = relative(content, file).split('\\').join('/');
  const section = rel.split('/')[0];
  if (!INDEX_SECTIONS.has(section)) continue;
  const raw = readFileSync(file, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  const meta = {};
  for (const line of (fm?.[1] ?? '').split(/\r?\n/)) {
    if (!line || /^\s/.test(line)) continue;
    const c = line.indexOf(':');
    if (c > 0) meta[line.slice(0, c).trim()] = line.slice(c + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const headings = [];
  let fence = false;
  for (const line of (fm?.[2] ?? raw).split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      fence = !fence;
      continue;
    }
    const h = !fence && /^###?\s+(.+?)\s*$/.exec(line);
    if (h) headings.push(h[1].replace(/\s+#+\s*$/, '').trim());
  }
  index.push({ path: routeOf(rel), title: meta.title ?? '', description: meta.description ?? '', headings, section });
}
index.sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(join(root, 'apps', 'api', 'src', 'data', 'docsIndex.json'), `${JSON.stringify(index, null, 2)}\n`);

console.log(`[docs] ${pages} pages rebranded, ${Object.keys(redirects).length} server pages redirected to ${MANAGED}, ${index.length} pages in the AI docs index`);

// ---------------------------------------------------------------- 5. build
if (noBuild) process.exit(0);
const run = (cmd) => execSync(cmd, { cwd: work, stdio: 'inherit', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
run('npm install --no-audit --no-fund --loglevel=error');
run('npx astro build');
rmSync(dist, { recursive: true, force: true });
cpSync(join(work, 'dist'), dist, { recursive: true });
console.log(`[docs] site built -> ${relative(process.cwd(), dist) || dist}`);
