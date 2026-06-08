#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  RENEX Press Kit — static-site build pipeline
//
//  Renders docs/PRESS_KIT.md → frontend/public/press/index.html and
//  assembles a downloadable ZIP (frontend/public/press/renex-press-kit.zip)
//  from the current media assets + a stripped boilerplate copy.
//
//  Mirrors scripts/build-manifesto.js (marked → token-walk → self-contained
//  HTML, inlined CSS, system-ui fonts, CSP-safe). Run by deploy.sh before
//  `vite build` (Vite copies frontend/public/ into dist/). Idempotent.
//
//  Internal-only content (DRAFT banner, maintainer note, TODOs) lives between
//  <!-- internal:start --> / <!-- internal:end --> markers in the source and is
//  stripped from BOTH the public page and the ZIP boilerplate.
//
//  NOTE: not yet wired into deploy.sh and not linked from any footer — the
//  public /press route ships only after Bruno's copy review (gated). Until
//  then this just generates the page locally for preview.
// ─────────────────────────────────────────────────────────────

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync,
} from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO = 'https://github.com/bruno-renex/renex';
const REPO_DOCS = REPO + '/blob/main/docs/';

const SRC = resolve(ROOT, 'docs/PRESS_KIT.md');
const OUT_DIR = resolve(ROOT, 'frontend/public/press');
const OUT_HTML = resolve(OUT_DIR, 'index.html');
const OUT_ZIP = resolve(OUT_DIR, 'renex-press-kit.zip');

// Media bundled into the ZIP (skipped silently if not yet present, e.g. logos).
const ZIP_ASSETS = [
  'frontend/public/landing-pulse.mp4',
  'frontend/public/app-preview-pulse.png',
  'frontend/public/install-ios.mp4',
  'frontend/public/install-ios-poster.png',
  // TODO: logo exports (renex-logo.svg → press PNG variants), founder photo
];

const marked = new Marked({ gfm: true, breaks: false });
const INTERNAL_RE = /<!--\s*internal:start\s*-->[\s\S]*?<!--\s*internal:end\s*-->/g;

// ── Helpers (ported from build-manifesto.js) ──────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[äàâ]/g, 'a').replace(/[öô]/g, 'o').replace(/[üû]/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const plain = (text) => text.replace(/[`*_]/g, '').trim();

function rewriteHref(href) {
  if (/^\.\/[A-Za-z0-9_]+\.md$/.test(href)) return REPO_DOCS + href.slice(2);   // ./PULSE.md → GitHub docs
  if (href.startsWith('../')) return REPO + '/blob/main/' + href.slice(3);       // ../SECURITY.md, ../assets → repo
  return href;                                                                    // site routes + absolute URLs untouched
}
function rewriteLinks(tokens) {
  for (const t of tokens) {
    if (t.type === 'link' && typeof t.href === 'string') t.href = rewriteHref(t.href);
    if (t.tokens) rewriteLinks(t.tokens);
    if (t.items) t.items.forEach((it) => it.tokens && rewriteLinks(it.tokens));
    if (t.header) t.header.forEach((c) => c.tokens && rewriteLinks(c.tokens));
    if (t.rows) t.rows.forEach((r) => r.forEach((c) => c.tokens && rewriteLinks(c.tokens)));
  }
}

// Responsive table → desktop table / mobile stacked cards (data-label).
function renderTable(tok) {
  const headTexts = tok.header.map((c) => plain(c.text));
  const thead = '<thead><tr>' +
    tok.header.map((c) => `<th>${marked.parseInline(c.text)}</th>`).join('') + '</tr></thead>';
  const tbody = '<tbody>' +
    tok.rows.map((row) => '<tr>' +
      row.map((cell, i) =>
        `<td data-label="${escapeAttr(headTexts[i] || '')}">${marked.parseInline(cell.text)}</td>`
      ).join('') + '</tr>').join('') + '</tbody>';
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function renderBody(tokens) {
  let out = '';
  for (const tok of tokens) {
    if (tok.type === 'hr' || tok.type === 'space') continue;
    if (tok.type === 'table') { out += renderTable(tok); continue; }
    if (tok.type === 'heading') {
      const lvl = Math.min(tok.depth, 4);
      out += `<h${lvl} id="${slugify(plain(tok.text))}">${marked.parseInline(tok.text)}</h${lvl}>`;
      continue;
    }
    out += marked.parser([tok]);
  }
  return out;
}

// ── Page template (self-contained, CSP-safe, no external requests) ──
const META = {
  docTitle: 'RENEX — Press Kit',
  description:
    'RENEX press kit: passkey-native, bot-resistant, human-first communication. Boilerplate, fact sheet, brand assets, and media — EN & DE.',
  canonical: 'https://renex.id/press',
  ogImage: 'https://renex.id/og/og-manifesto.png',
};

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07070A;--panel:#0D0D11;--text:#E6E6EB;--text-2:#9A9AA3;--muted:#71717A;
  --cyan:#38BDF8;--glow:rgba(56,189,248,0.35);--border:#27272A;
  --font:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}
body{font-family:var(--font);background:var(--bg);color:var(--text);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;line-height:1.6;overflow-x:hidden}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.skip-link{position:absolute;left:-9999px;top:0;background:var(--cyan);color:var(--bg);
  padding:10px 16px;border-radius:0 0 8px 0;font-weight:700;z-index:200}.skip-link:focus{left:0}

.hero{position:relative;display:flex;flex-direction:column;justify-content:center;
  padding:96px clamp(24px,6vw,96px) 72px;overflow:hidden;
  background:radial-gradient(ellipse 80% 60% at 50% 30%,rgba(56,189,248,0.10),transparent 70%)}
.hero-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:clamp(40px,7vw,72px)}
.brand{font-size:clamp(22px,3vw,30px);font-weight:800;letter-spacing:0.04em;color:var(--text)}
.brand .x{color:var(--cyan)}
.hero-top .gh{color:var(--text-2);font-size:15px;font-weight:600}
.hero-inner{max-width:900px;margin:0 auto;width:100%}
.kicker{font-size:clamp(13px,2vw,15px);text-transform:uppercase;letter-spacing:0.18em;
  color:var(--cyan);font-weight:700;margin-bottom:16px;text-shadow:0 0 24px var(--glow)}
.hero h1{font-weight:800;letter-spacing:-0.02em;line-height:1.05;
  font-size:clamp(44px,8vw,84px);color:var(--text);margin:0}
.hero-sub{margin-top:20px;font-size:clamp(16px,2.2vw,20px);color:var(--text-2);max-width:620px;line-height:1.5}
.dl-btn{display:inline-flex;align-items:center;gap:10px;margin-top:32px;min-height:52px;
  padding:0 26px;border-radius:999px;background:var(--cyan);color:#07070A;
  font-size:16px;font-weight:700;box-shadow:0 6px 24px rgba(56,189,248,0.4)}
.dl-btn:hover{text-decoration:none;background:#0ea5e9}
.dl-note{margin-top:12px;font-size:13px;color:var(--muted)}

.content{max-width:1224px;margin:0 auto;padding:clamp(48px,7vw,96px) clamp(16px,4vw,32px);
  display:grid;grid-template-columns:1fr;gap:48px}
.toc{display:none}
main{max-width:760px;width:100%;min-width:0}
.lead{margin-bottom:clamp(40px,6vw,64px);padding-bottom:28px;border-bottom:1px solid var(--border)}
.lead p{font-size:19px;color:var(--text-2);margin:0 0 8px}
.lead strong{color:var(--text)}

section.ms{margin-bottom:clamp(56px,8vw,96px);scroll-margin-top:24px}
section.ms:last-child{margin-bottom:0}
section.ms h2{font-size:clamp(28px,4.5vw,42px);font-weight:800;letter-spacing:-0.015em;
  line-height:1.14;margin-bottom:24px;color:var(--text)}
section.ms h3{font-size:clamp(18px,2.6vw,22px);font-weight:700;margin:32px 0 12px;color:var(--cyan)}
section.ms h4{font-size:16px;font-weight:700;margin:24px 0 8px;color:var(--text)}
main p{font-size:17px;line-height:1.65;color:var(--text);margin:0 0 18px}
main ul,main ol{margin:0 0 18px;padding-left:22px}
main li{font-size:17px;line-height:1.6;color:var(--text);margin-bottom:8px}
main li::marker{color:var(--cyan)}
main strong{color:var(--text);font-weight:700}
main code{background:var(--panel);border:1px solid var(--border);border-radius:6px;
  padding:1px 6px;font-size:0.88em;color:var(--cyan)}
main blockquote{border-left:3px solid var(--border);padding:4px 0 4px 20px;margin:24px 0;
  color:var(--text-2);font-style:italic}
main hr{display:none}

.table-wrap{margin:20px 0;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:15px}
thead th{text-align:left;color:var(--cyan);font-weight:700;padding:11px 14px;
  border-bottom:2px solid var(--border);font-size:13px;text-transform:uppercase;letter-spacing:0.04em}
tbody td{padding:12px 14px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top;line-height:1.5}
tbody tr:hover{background:rgba(56,189,248,0.03)}
@media (max-width:767px){
  table,thead,tbody,tr,td{display:block;width:100%}
  thead{position:absolute;left:-9999px}
  tbody tr{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:8px 14px;margin-bottom:14px}
  tbody td{border-bottom:1px solid var(--border);padding:10px 0;display:flex;flex-direction:column;gap:4px}
  tbody td:last-child{border-bottom:none}
  tbody td::before{content:attr(data-label);font-size:12px;text-transform:uppercase;
    letter-spacing:0.05em;color:var(--cyan);font-weight:700}
}

.ms-footer{border-top:1px solid var(--border);padding:56px 24px 72px;text-align:center}
.ms-footer .tagline{font-size:clamp(17px,3vw,22px);font-weight:700;color:var(--text);
  text-shadow:0 0 30px var(--glow);margin-bottom:20px}
.ms-footer .links{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:center;margin-bottom:20px}
.ms-footer .links a{color:var(--text-2);font-size:15px}.ms-footer .links a:hover{color:var(--cyan)}
.ms-footer .back{font-size:14px;color:var(--muted)}

@media (min-width:1024px){
  .content{grid-template-columns:230px minmax(0,760px);gap:56px;justify-content:center;align-items:start}
  .toc{display:block;position:sticky;top:32px;align-self:start}
  .toc-title{font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:14px;font-weight:700}
  .toc ol{list-style:none;border-left:1px solid var(--border);padding:0}
  .toc a{display:block;padding:7px 0 7px 16px;margin-left:-1px;font-size:14px;line-height:1.4;
    color:var(--text-2);border-left:2px solid transparent}
  .toc a:hover{color:var(--text);text-decoration:none}
}
`;

function jsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: META.docTitle,
    description: META.description,
    inLanguage: 'en',
    publisher: { '@type': 'Organization', name: 'RENEX', url: 'https://renex.id' },
    author: { '@type': 'Person', name: 'Bruno Hochstrasser' },
    image: META.ogImage,
    mainEntityOfPage: { '@type': 'WebPage', '@id': META.canonical },
  });
}

function tocList(toc) {
  return toc.map((t) => '<li><a href="#' + t.id + '">' + escapeAttr(t.title) + '</a></li>').join('');
}

function renderPage({ contentHtml, toc, hasZip }) {
  const dlBtn = hasZip
    ? `<a class="dl-btn" href="/press/renex-press-kit.zip" download>↓ Download press kit (ZIP)</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#07070A">
<title>${META.docTitle}</title>
<meta name="description" content="${escapeAttr(META.description)}">
<meta name="robots" content="index, follow">
<meta name="author" content="Bruno Hochstrasser">
<link rel="canonical" href="${META.canonical}">
<meta property="og:title" content="${META.docTitle}">
<meta property="og:description" content="${escapeAttr(META.description)}">
<meta property="og:image" content="${META.ogImage}">
<meta property="og:url" content="${META.canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="RENEX">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:creator" content="@renex_app">
<meta name="twitter:title" content="${META.docTitle}">
<meta name="twitter:description" content="${escapeAttr(META.description)}">
<meta name="twitter:image" content="${META.ogImage}">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<script type="application/ld+json">${jsonLd()}</script>
<style>${CSS}</style>
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>

<header class="hero">
  <div class="hero-top">
    <a class="brand" href="/" aria-label="RENEX home">RENE<span class="x">X</span></a>
    <a class="gh" href="${REPO}">GitHub ↗</a>
  </div>
  <div class="hero-inner">
    <p class="kicker">Press Kit</p>
    <h1>YOU ARE THE KEY.</h1>
    <p class="hero-sub">Passkey-native, bot-resistant, human-first communication. Press &amp; media resources — EN &amp; DE.</p>
    ${dlBtn}
    ${hasZip ? '<div class="dl-note">Logos, screenshots, loop videos &amp; boilerplate. SVG/PNG logo exports pending.</div>' : ''}
  </div>
</header>

<div class="content">
  <aside class="toc" aria-label="Sections">
    <div class="toc-title">Sections</div>
    <ol>${tocList(toc)}</ol>
  </aside>
  <main id="content">
${contentHtml}
  </main>
</div>

<footer class="ms-footer">
  <div class="tagline">Made in Switzerland. Made for humans. Made to last.</div>
  <nav class="links" aria-label="Footer">
    <a href="/manifesto">Manifesto</a>
    <a href="${REPO}/blob/main/docs/PROTOCOL.md">Protocol</a>
    <a href="${REPO}">GitHub</a>
  </nav>
  <div class="back"><a href="/">← Back to renex.id</a></div>
</footer>
</body>
</html>
`;
}

// ── ZIP assembly (best-effort: page still builds if `zip` is missing) ──
function buildZip() {
  const staging = resolve(OUT_DIR, '_staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const included = [];
  const missing = [];
  for (const rel of ZIP_ASSETS) {
    const p = resolve(ROOT, rel);
    if (existsSync(p)) { copyFileSync(p, resolve(staging, basename(p))); included.push(basename(p)); }
    else missing.push(rel);
  }

  // Stripped public boilerplate + a short README.
  const publicMd = readFileSync(SRC, 'utf8').replace(INTERNAL_RE, '').trim();
  writeFileSync(resolve(staging, 'press-kit.md'), publicMd);
  const readme =
    'RENEX — Press Kit\n=================\n\n' +
    'Tagline: YOU ARE THE KEY.\n' +
    'Web: https://renex.id  ·  Source: ' + REPO + '\n\n' +
    'Contents:\n' +
    '- press-kit.md       Boilerplate (EN/DE), fact sheet, key messages\n' +
    included.map((f) => '- ' + f).join('\n') + '\n\n' +
    'Pending: SVG/PNG logo exports, founder photo. Manifesto quotable under CC BY 4.0.\n';
  writeFileSync(resolve(staging, 'README.txt'), readme);

  const files = ['press-kit.md', 'README.txt', ...included].map((f) => resolve(staging, f));
  try {
    rmSync(OUT_ZIP, { force: true });
    execFileSync('zip', ['-j', '-q', OUT_ZIP, ...files], { stdio: 'pipe' });
    rmSync(staging, { recursive: true, force: true });
    return { ok: true, included, missing, bytes: readFileSync(OUT_ZIP).length };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    console.warn('⚠ ZIP step skipped (`zip` unavailable?):', err.message);
    return { ok: false, included, missing, bytes: 0 };
  }
}

// ── Run ───────────────────────────────────────────────────────
function build() {
  let md = readFileSync(SRC, 'utf8').replace(INTERNAL_RE, '').trim();
  const tokens = marked.lexer(md);
  rewriteLinks(tokens);

  const lead = [];
  const sections = [];
  let cur = null;
  for (const tok of tokens) {
    if (tok.type === 'heading' && tok.depth === 1) continue;          // title → hero
    if (tok.type === 'heading' && tok.depth === 2) {
      cur = { title: plain(tok.text), id: slugify(plain(tok.text)), tokens: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) { lead.push(tok); continue; }                            // tagline / one-liner
    cur.tokens.push(tok);
  }

  const toc = sections.map((s) => ({ id: s.id, title: s.title }));
  const zip = buildZip();
  const leadHtml = lead.length ? `<div class="lead">${renderBody(lead)}</div>` : '';
  const body = sections
    .map((s) => `<section class="ms" id="${s.id}"><h2>${marked.parseInline(s.title)}</h2>${renderBody(s.tokens)}</section>`)
    .join('\n');

  const html = renderPage({ contentHtml: leadHtml + '\n' + body, toc, hasZip: zip.ok });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_HTML, html);

  const rel = OUT_HTML.replace(ROOT + '/', '');
  console.log(`✓ press  ${rel}  (${sections.length} sections, ${(Buffer.byteLength(html) / 1024).toFixed(1)} kb)`);
  if (zip.ok) {
    console.log(`✓ zip    frontend/public/press/renex-press-kit.zip  (${zip.included.length} assets, ${(zip.bytes / 1024).toFixed(1)} kb)`);
  }
  if (zip.missing.length) console.log(`  pending assets (skipped): ${zip.missing.map((m) => basename(m)).join(', ')}`);
  console.log('Press-kit build complete.');
}

try {
  build();
} catch (err) {
  console.error('✗ press-kit build failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}
