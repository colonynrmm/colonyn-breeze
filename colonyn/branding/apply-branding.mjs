#!/usr/bin/env node
/**
 * Colonyn white-label patch for Breeze: the web app (apps/web) plus the
 * user-facing strings the API sends out (authenticator issuer, passkey name,
 * account emails, test notifications, API docs page).
 *
 *   node colonyn/branding/apply-branding.mjs            # apply
 *   node colonyn/branding/apply-branding.mjs --check    # report only, exit 1 if not applied
 *
 * Idempotent: running it twice changes nothing the second time. Every rule
 * must find either the original Breeze text or its Colonyn replacement; if
 * neither is there (upstream changed the file), the script stops with an error
 * so a Breeze upgrade never silently ships half-branded.
 *
 * Optional assets (put your own files here before building):
 *   colonyn/branding/logo.svg     -> replaces the Breeze wave icon everywhere
 *   colonyn/branding/favicon.svg  -> browser tab icon
 *   colonyn/branding/logo-on-brand.svg -> logo on the blue login panel (light version)
 *
 * Environment overrides: BRAND_NAME (default "Colonyn"), BRAND_PRODUCT ("Colonyn RMM").
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const web = join(root, 'apps', 'web');
const checkOnly = process.argv.includes('--check');

const BRAND = process.env.BRAND_NAME?.trim() || 'Colonyn';
const PRODUCT = process.env.BRAND_PRODUCT?.trim() || `${BRAND} RMM`;

let changed = 0;
let pending = 0;
const problems = [];

function patchFile(rel, rules, base = web) {
  const file = join(base, rel);
  if (!existsSync(file)) {
    problems.push(`${rel}: file not found`);
    return;
  }
  const before = readFileSync(file, 'utf8');
  let text = before;
  for (const [from, to] of rules) {
    if (text.includes(from)) {
      text = text.split(from).join(to);
    } else if (!text.includes(to)) {
      problems.push(`${rel}: expected text not found: ${JSON.stringify(from)}`);
    }
  }
  if (text !== before) {
    if (checkOnly) pending++;
    else {
      writeFileSync(file, text);
      changed++;
    }
  }
}

// 1. Titles, headings and fallbacks (exact strings from Breeze v0.123.0).
const TITLE = [`| Breeze RMM</title>`, `| ${PRODUCT}</title>`];
patchFile('src/layouts/Layout.astro', [TITLE]);
patchFile('src/layouts/AuthShellBranded.astro', [TITLE]);
// Logo text: "colony" + a coloured "n" (Number) for the Colonyn brand, plain name otherwise.
const wordmark = (attr, cls) => (BRAND === 'Colonyn'
  ? `" aria-label="${BRAND}">colony<span ${attr}="${cls}">n</span>`
  : `">${BRAND}`);
patchFile('src/layouts/AuthLayout.astro', [TITLE, [`tracking-tight">Breeze</h1>`, `tracking-tight${wordmark('class', 'text-primary')}</h1>`]]);
patchFile('src/layouts/SetupLayout.astro', [TITLE, [`tracking-tight">Breeze</h1>`, `tracking-tight${wordmark('class', 'text-primary')}</h1>`]]);
patchFile('src/layouts/ErrorLayout.astro', [TITLE, [`text-foreground">Breeze</span>`, `text-foreground${wordmark('class', 'text-primary')}</span>`]]);
patchFile('src/components/auth/AuthPanelBranding.tsx', [
  // white text on the blue panel: the "n" takes the navy of the symbol's core
  [`tracking-tight">Breeze</span>`, `tracking-tight${wordmark('className', 'text-[#0E1A33]')}</span>`],
  [`{branding ? '' : 'Breeze RMM'}`, `{branding ? '' : '${PRODUCT}'}`],
]);
patchFile('src/components/layout/BrandHeader.tsx', [[`name?.trim() || 'Breeze'`, `name?.trim() || '${BRAND}'`]]);
patchFile('src/lib/i18n/index.ts', [['} | Breeze RMM`', `} | ${PRODUCT}\``]]);
patchFile('src/components/auth/RecoveryCodes.tsx', [[`'Breeze RMM Recovery Codes`, `'${PRODUCT} Recovery Codes`]]);

// 2. Locale strings: only VALUES are rewritten; keys (which embed "Breeze") stay.
//    Line-based so the files keep their exact formatting (one entry per line).
const KEYED_LINE = /^(\s*"(?:[^"\\]|\\.)*"\s*:\s*)(.*)$/;
function rewriteValue(text) {
  return text.replace(/\bBreeze RMM\b/g, PRODUCT).replace(/\bBreeze\b/g, BRAND);
}
const localesDir = join(web, 'src', 'locales');
for (const lang of readdirSync(localesDir)) {
  const dir = join(localesDir, lang);
  if (!statSync(dir).isDirectory()) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    const before = readFileSync(file, 'utf8');
    const after = before
      .split('\n')
      .map((line) => {
        const keyed = KEYED_LINE.exec(line);
        return keyed ? keyed[1] + rewriteValue(keyed[2]) : rewriteValue(line);
      })
      .join('\n');
    JSON.parse(after); // never write a broken file
    if (after !== before) {
      if (checkOnly) pending++;
      else {
        writeFileSync(file, after);
        changed++;
      }
    }
  }
}

// 3. API: strings users see outside the web app. Paths are relative to the repo root.
const api = (rel, rules) => patchFile(rel, rules, root);
api('apps/api/src/services/mfa.ts', [[`issuer: 'Breeze RMM'`, `issuer: '${PRODUCT}'`]]); // authenticator app label
api('apps/api/src/services/passkeys.ts', [[`DEFAULT_RP_NAME = 'Breeze RMM'`, `DEFAULT_RP_NAME = '${PRODUCT}'`]]);
api('apps/api/src/services/emailLayout.ts', [[`brandName ?? 'Breeze RMM'`, `brandName ?? '${PRODUCT}'`]]);
api('apps/api/src/services/sso.ts', [
  [`orgName = 'Breeze RMM'`, `orgName = '${PRODUCT}'`],
  [`orgDisplayName = 'Breeze RMM'`, `orgDisplayName = '${PRODUCT}'`],
]);
api('apps/api/src/routes/alerts/channels.ts', [
  [`'Test Alert from Breeze RMM'`, `'Test Alert from ${PRODUCT}'`],
  [`orgName: 'Breeze'`, `orgName: '${BRAND}'`],
]);
api('apps/api/src/routes/webhooks.ts', [[`'Test webhook from Breeze RMM'`, `'Test webhook from ${PRODUCT}'`]]);
api('apps/api/src/services/notificationSenders/webhookSender.ts', [
  [`'This is a test notification from Breeze RMM'`, `'This is a test notification from ${PRODUCT}'`],
]);
api('apps/api/src/routes/docs.ts', [
  [`<title>Breeze RMM API Documentation</title>`, `<title>${PRODUCT} API Documentation</title>`],
  [`<h1>Breeze RMM API</h1>`, `<h1>${PRODUCT} API</h1>`],
]);
api('packages/shared/src/utils/emailTemplates.ts', [
  [`invited you to {{org_name}} on Breeze'`, `invited you to {{org_name}} on ${BRAND}'`],
  [`invited you to {{org_name}} on Breeze.</p>`, `invited you to {{org_name}} on ${BRAND}.</p>`],
]);

// Account emails (password reset, verification, lockout, email change, invite
// fallback): every code line, never comments or header names like X-Breeze-*.
function patchCodeLines(rel) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    problems.push(`${rel}: file not found`);
    return;
  }
  const before = readFileSync(file, 'utf8');
  const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);
  const after = before
    .split('\n')
    .map((line) => (isComment(line) || line.includes('X-Breeze') ? line : rewriteValue(line)))
    .join('\n');
  if (after === before && !before.includes(BRAND)) problems.push(`${rel}: no Breeze strings found`);
  if (after !== before) {
    if (checkOnly) pending++;
    else {
      writeFileSync(file, after);
      changed++;
    }
  }
}
patchCodeLines('apps/api/src/services/email.ts');
patchCodeLines('apps/api/src/services/emailTemplates/defaults.ts');

// 4. Logo and favicon (only when the files are provided).
const WAVE_SIGNATURE = 'M12 22C12 22 20 22 28 22';
const logo = join(here, 'logo.svg');
const logoOnBrand = join(here, 'logo-on-brand.svg'); // optional: variant for the blue login panel
if (existsSync(logo)) {
  if (!checkOnly) {
    copyFileSync(logo, join(web, 'public', 'brand-logo.svg'));
    if (existsSync(logoOnBrand)) copyFileSync(logoOnBrand, join(web, 'public', 'brand-logo-on-brand.svg'));
  }
  const svgBlock = /<svg\b[^>]*viewBox="0 0 64 64"[^>]*>[\s\S]*?<\/svg>/g;
  // An <img> this script wrote on an earlier run, so a re-run can upgrade it.
  const ourImg = /<img src="\/brand-logo(?:-on-brand)?\.svg"[^>]*\/>/g;
  const targets = {
    'src/layouts/AuthLayout.astro': {},
    'src/layouts/SetupLayout.astro': {},
    'src/layouts/ErrorLayout.astro': {},
    // white-on-blue panel: the colour logo would vanish there
    'src/components/auth/AuthPanelBranding.tsx': {
      src: existsSync(logoOnBrand) ? '/brand-logo-on-brand.svg' : '/brand-logo.svg',
      size: 'className="h-8 w-8 object-contain"',
    },
    'src/components/layout/BrandHeader.tsx': {},
  };
  for (const [rel, opt] of Object.entries(targets)) {
    const file = join(web, rel);
    const before = readFileSync(file, 'utf8');
    const cls = rel.endsWith('.tsx') ? 'className' : 'class';
    const img = (size) => `<img src="${opt.src ?? '/brand-logo.svg'}" ${opt.size ?? size} alt="${BRAND}" ${opt.size ? '' : `${cls}="object-contain" `}/>`;
    let after = before.replace(svgBlock, (block) => {
      if (!block.includes(WAVE_SIGNATURE)) return block;
      const w = /\bwidth="(\d+)"/.exec(block)?.[1] ?? '18';
      const h = /\bheight="(\d+)"/.exec(block)?.[1] ?? w;
      return img(`width="${w}" height="${h}"`);
    });
    if (opt.size || opt.src) after = after.replace(ourImg, () => img(''));
    if (after !== before) {
      if (checkOnly) pending++;
      else {
        writeFileSync(file, after);
        changed++;
      }
    }
  }
}
const favicon = join(here, 'favicon.svg');
if (existsSync(favicon) && !checkOnly) copyFileSync(favicon, join(web, 'public', 'favicon.svg'));

// 5. Links: nothing a user can open may point at breezermm.com. Docs go to the
// Colonyn docs site (colonyn/docs), legal and contact pages to the Colonyn
// website. Applies to every non-test source file of the web app, the API and the
// shared package, then verifies that no breezermm.com reference is left.
const DOCS_ORIGIN = (process.env.COLONYN_DOCS_URL?.trim() || 'https://docs.colonyn.com').replace(/\/$/, '');
const SITE = (process.env.COLONYN_SITE_URL?.trim() || 'https://www.colonyn.com').replace(/\/$/, '');
const LINK_RULES = [
  // "What's new" entries describe upstream Breeze releases; drop the link rather than send users there.
  [/^[ \t]*learnMoreUrl: 'https:\/\/breezermm\.com\/release-notes',\r?\n/gm, ''],
  [/https:\/\/docs\.breezermm\.com/g, DOCS_ORIGIN],
  [/https:\/\/breezermm\.com\/legal\/privacy-policy/g, `${SITE}/privacy`],
  [/https:\/\/breezermm\.com\/legal\/terms-of-service/g, `${SITE}/terms-conditions`],
  [/https:\/\/breezermm\.com\/contact/g, `${SITE}/contactus`],
  [/https:\/\/breezermm\.com\/license/g, 'https://github.com/colonynrmm/colonyn-breeze/blob/colonyn/LICENSE'],
  [/https:\/\/breezermm\.com\/deploy\//g, `${DOCS_ORIGIN}/deploy/`],
  [/support@breezermm\.com/g, 'support@colonyn.com'],
  // Org branding editor shows "<slug>.<domain>" when PUBLIC_API_URL is empty (our build).
  [/return 'breezermm\.com';/g, "return 'my.colonyn.com';"],
  // Help panel may embed the docs site when the app runs on a Colonyn host.
  [/(const ALLOWED_HTTPS_HOSTS = new Set\(\[\n)(?!  'colonyn\.com',)/, "$1  'colonyn.com',\n"],
  [/(const ALLOWED_HTTPS_SUFFIXES = \[\n)(?!  '\.colonyn\.com',)/, "$1  '.colonyn.com',\n"],
  // Comments that merely name the upstream host.
  [/docs\.breezermm\.com/g, DOCS_ORIGIN.replace(/^https?:\/\//, '')],
];
const isTestFile = (rel) => /(\.test\.|\.spec\.|__tests__|__fixtures__|\/test\/|\/tests\/)/.test(rel);
function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'locales') continue;
      yield* sourceFiles(full);
    } else if (/\.(ts|tsx|astro|mjs|js)$/.test(name)) {
      yield full;
    }
  }
}
const leftovers = [];
// Allowed: a protocol namespace URI (an identifier, never opened), lookalike-host examples in security
// comments, and security allowlists that only *recognise* upstream hosts (never rendered as links).
const allowedLeftover = (line) =>
  /breezermm\.com\/protocol\/|breezermm\.com(\.evil|@evil|evil)|PLATFORM_OWNED_DOMAINS|notbreezermm|^\s*'\.?breezermm\.com',$/.test(line);
// Tests follow the same docs origin so the suite keeps describing what ships.
const TEST_LINK_RULES = [
  // Regex literals in tests that match the docs host (e.g. middleware.test.ts reads astro.config.mjs).
  [/docs\\\.breezermm\\\.com/g, DOCS_ORIGIN.replace(/^https?:\/\//, '').replace(/\./g, '\\.')],
  [/https:\/\/docs\.breezermm\.com/g, DOCS_ORIGIN],
  [/docs\.breezermm\.com/g, DOCS_ORIGIN.replace(/^https?:\/\//, '')],
];
// Build-time config next to src/ (e.g. apps/web/astro.config.mjs sets the production frame-src CSP).
function* configFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isFile() && /\.config\.(ts|mjs|js|cjs)$/.test(name)) yield full;
  }
}
function* scannedFiles() {
  for (const dir of ['apps/web/src', 'apps/api/src', 'packages/shared/src']) yield* sourceFiles(join(root, dir));
  for (const dir of ['apps/web', 'apps/api', 'packages/shared']) yield* configFiles(join(root, dir));
}
{
  for (const full of scannedFiles()) {
    const rel = relative(root, full);
    if (isTestFile(rel)) {
      const before = readFileSync(full, 'utf8');
      if (!/docs\\?\.breezermm/.test(before)) continue;
      let after = before;
      for (const [pattern, to] of TEST_LINK_RULES) after = after.replace(pattern, to);
      if (after !== before) {
        if (checkOnly) pending++;
        else {
          writeFileSync(full, after);
          changed++;
        }
      }
      continue;
    }
    const before = readFileSync(full, 'utf8');
    if (!before.includes('breezermm.com')) continue;
    let after = before;
    for (const [pattern, to] of LINK_RULES) after = after.replace(pattern, to);
    if (after !== before) {
      if (checkOnly) pending++;
      else {
        writeFileSync(full, after);
        changed++;
      }
    }
    after.split('\n').forEach((line, i) => {
      if (line.includes('breezermm.com') && !allowedLeftover(line)) leftovers.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
}
// The allowlists are always patched (they may hold no breezermm.com literal after a rebase).
{
  const rel = 'apps/web/src/lib/docsEmbed.ts';
  const full = join(root, rel);
  const before = readFileSync(full, 'utf8');
  let after = before;
  for (const [pattern, to] of LINK_RULES.slice(-3, -1)) after = after.replace(pattern, to);
  if (!after.includes("'.colonyn.com'")) problems.push(`${rel}: docs embed allowlist not found`);
  if (after !== before && !checkOnly) writeFileSync(full, after);
}
if (!checkOnly && leftovers.length) {
  problems.push(...leftovers.map((l) => `link to breezermm.com left: ${l}`));
}

if (problems.length) {
  console.error('[branding] Upstream files changed; update the rules before building:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(2);
}

if (checkOnly) {
  console.log(pending ? `[branding] ${pending} file(s) still carry Breeze branding` : '[branding] already applied');
  process.exit(pending ? 1 : 0);
}
console.log(`[branding] ${changed} file(s) updated -> brand "${BRAND}", product "${PRODUCT}" (${relative(process.cwd(), web) || '.'})`);
