#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  RENEX Manifesto — static-site build pipeline
//
//  Renders docs/MANIFESTO.md → frontend/public/manifesto/index.html (EN)
//  and  docs/MANIFESTO_DE.md → frontend/public/manifest-de/index.html (DE)
//
//  Architecture: Option 2 — Markdown → HTML via `marked`, wrapped in the
//  shared Direction-B "Statement" template (scripts/manifesto/template.js).
//  Run automatically by deploy.sh before `vite build` (Vite copies
//  frontend/public/ into dist/). Idempotent — safe to run repeatedly.
//
//  A token-walking renderer (rather than marked's default HTML output)
//  gives precise control over the brand-specific layouts:
//   - the brand triple + H1 + meta block feed the hero, not the body
//   - "5 principles" → responsive card grid (5/2/1 col)
//   - tables → desktop table / mobile stacked cards (data-label)
//   - bold-led / ALL-CAPS paragraphs → cyan pull-quotes
//   - Skeptic-FAQ questions → native <details> accordion (no JS)
//   - relative *.md links → GitHub blob URLs, manifesto links → routes
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { renderPage } from './manifesto/template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_DOCS = 'https://github.com/bruno-renex/renex/blob/main/docs/';

const TARGETS = [
  {
    lang: 'en',
    src: resolve(ROOT, 'docs/MANIFESTO.md'),
    out: resolve(ROOT, 'frontend/public/manifesto/index.html'),
    principlesHeading: 'The 5 principles',
    faqHeading: 'Appendix A: Skeptic FAQ',
  },
  {
    lang: 'de',
    src: resolve(ROOT, 'docs/MANIFESTO_DE.md'),
    out: resolve(ROOT, 'frontend/public/manifest-de/index.html'),
    principlesHeading: 'Die 5 Prinzipien',
    faqHeading: 'Anhang A: Skeptiker-FAQ',
  },
];

const marked = new Marked({ gfm: true, breaks: false });

// ── Helpers ───────────────────────────────────────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[äàâ]/g, 'a')
    .replace(/[öô]/g, 'o')
    .replace(/[üû]/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeAttr(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Rewrite relative markdown links in-place across the whole token tree.
function rewriteLinks(tokens) {
  for (const t of tokens) {
    if (t.type === 'link' && typeof t.href === 'string') {
      t.href = rewriteHref(t.href);
    }
    if (t.tokens) rewriteLinks(t.tokens);
    if (t.items) t.items.forEach((it) => it.tokens && rewriteLinks(it.tokens));
    if (t.header) t.header.forEach((c) => c.tokens && rewriteLinks(c.tokens));
    if (t.rows)
      t.rows.forEach((r) => r.forEach((c) => c.tokens && rewriteLinks(c.tokens)));
  }
}

function rewriteHref(href) {
  if (href === './MANIFESTO.md') return '/manifesto';
  if (href === './MANIFESTO_DE.md') return '/manifest-de';
  const m = href.match(/^\.\/([A-Za-z0-9_]+\.md)$/);
  if (m) return REPO_DOCS + m[1];
  return href;
}

const plain = (text) => text.replace(/[`*_]/g, '').trim();

// Is this inline-token a strong run whose visible text is ALL-CAPS?
function isUpperStrong(tok) {
  if (tok.type !== 'strong') return false;
  const letters = (tok.text || '').replace(/[^\p{L}]/gu, '');
  return (
    letters.length >= 4 &&
    letters === letters.toUpperCase() &&
    letters !== letters.toLowerCase()
  );
}

function soleStrong(paraToken) {
  const kids = (paraToken.tokens || []).filter(
    (t) => !(t.type === 'text' && !t.text.trim())
  );
  return kids.length === 1 && kids[0].type === 'strong';
}

// A bold paragraph ending in ":" is a label introducing a list — not a
// pull-quote (e.g. "At the gate (account creation):").
function isLabel(paraToken) {
  return soleStrong(paraToken) && plain(paraToken.text).endsWith(':');
}

// A paragraph is a pull-quote if it is entirely one bold statement, or it
// contains an ALL-CAPS bold run (e.g. "YOU ARE THE KEY").
function isPullQuote(paraToken) {
  if (isLabel(paraToken)) return false;
  if (soleStrong(paraToken)) return true;
  const kids = (paraToken.tokens || []).filter(
    (t) => !(t.type === 'text' && !t.text.trim())
  );
  return kids.some(isUpperStrong);
}

// ── Block renderers ───────────────────────────────────────────
function renderParagraph(tok) {
  if (isLabel(tok)) {
    return `<p class="label">${marked.parseInline(tok.text)}</p>`;
  }
  if (isPullQuote(tok)) {
    return `<p class="pullquote">${marked.parseInline(tok.text)}</p>`;
  }
  return marked.parser([tok]);
}

function renderTable(tok) {
  const headTexts = tok.header.map((c) => plain(c.text));
  const thead =
    '<thead><tr>' +
    tok.header.map((c) => `<th>${marked.parseInline(c.text)}</th>`).join('') +
    '</tr></thead>';
  const tbody =
    '<tbody>' +
    tok.rows
      .map(
        (row) =>
          '<tr>' +
          row
            .map(
              (cell, i) =>
                `<td data-label="${escapeAttr(headTexts[i] || '')}">${marked.parseInline(
                  cell.text
                )}</td>`
            )
            .join('') +
          '</tr>'
      )
      .join('') +
    '</tbody>';
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function renderBlockquote(tok) {
  // A blockquote that is just a bold line is a pull-quote; otherwise a note.
  const html = marked.parser([tok]);
  return html.replace('<blockquote>', '<blockquote class="note">');
}

// Default rendering of a section's body tokens (handles tables,
// pull-quotes, blockquotes; everything else via marked).
function renderBody(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'hr':
      case 'space':
        break;
      case 'table':
        out += renderTable(tok);
        break;
      case 'paragraph':
        out += renderParagraph(tok);
        break;
      case 'blockquote':
        out += renderBlockquote(tok);
        break;
      case 'heading': {
        const lvl = Math.min(tok.depth, 4);
        out += `<h${lvl}>${marked.parseInline(tok.text)}</h${lvl}>`;
        break;
      }
      default:
        out += marked.parser([tok]);
    }
  }
  return out;
}

// Group a token list into [{heading, tokens}] chunks split on h3.
function groupByH3(tokens) {
  const lead = [];
  const groups = [];
  let cur = null;
  for (const tok of tokens) {
    if (tok.type === 'heading' && tok.depth === 3) {
      cur = { heading: tok, tokens: [] };
      groups.push(cur);
    } else if (!cur) {
      lead.push(tok);
    } else {
      cur.tokens.push(tok);
    }
  }
  return { lead, groups };
}

// "5 principles" → responsive card grid (full-bleed on wide screens).
function renderPrinciples(tokens) {
  const { groups } = groupByH3(tokens);
  const cards = groups
    .map(
      (g) =>
        '<div class="principle-card"><h3>' +
        marked.parseInline(g.heading.text) +
        '</h3>' +
        renderBody(g.tokens) +
        '</div>'
    )
    .join('');
  return `<div class="breakout"><div class="principles-grid">${cards}</div></div>`;
}

// Skeptic-FAQ → native <details> accordion.
function renderFaq(tokens) {
  const { lead, groups } = groupByH3(tokens);

  // The closing "living document" blockquote trails the last question —
  // lift it out so it renders after the accordion, not inside Q10.
  let trailing = '';
  if (groups.length) {
    const last = groups[groups.length - 1].tokens;
    while (last.length && last[last.length - 1].type === 'hr') last.pop();
    if (last.length && last[last.length - 1].type === 'blockquote') {
      trailing = renderBlockquote(last.pop());
    }
  }

  const intro = lead.length
    ? `<div class="faq-intro">${renderBody(lead)}</div>`
    : '';
  const items = groups
    .map(
      (g) =>
        '<details class="faq"><summary>' +
        marked.parseInline(g.heading.text) +
        '</summary><div class="faq-body">' +
        renderBody(g.tokens) +
        '</div></details>'
    )
    .join('');
  return intro + items + (trailing ? `<div class="faq-intro">${trailing}</div>` : '');
}

// ── Per-document build ────────────────────────────────────────
function buildDoc(target) {
  const md = readFileSync(target.src, 'utf8');
  const tokens = marked.lexer(md);
  rewriteLinks(tokens);

  let metaHtml = '';
  const sections = [];
  let cur = null;

  for (const tok of tokens) {
    if (tok.type === 'heading' && tok.depth === 1) continue; // title → hero
    if (tok.type === 'heading' && tok.depth === 2) {
      const title = plain(tok.text);
      cur = { title, id: slugify(title), tokens: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      // Pre-section: capture the Version/License meta block, drop the
      // brand-triple blockquote + horizontal rules (hero handles them).
      if (tok.type === 'paragraph' && /^\*\*(Version|Versionen)/i.test(tok.text.trim())) {
        const lines = tok.text
          .split('\n')
          .filter((l) => !/^\*\*(Translations|Übersetzungen)/i.test(l.trim()))
          .map((l) => marked.parseInline(l).trim())
          .filter(Boolean);
        metaHtml = `<div class="meta-line">${lines.join(' · ')}</div>`;
      }
      continue;
    }
    cur.tokens.push(tok);
  }

  const toc = sections.map((s) => ({ id: s.id, title: s.title }));

  const body = sections
    .map((s) => {
      let inner;
      if (s.title === target.principlesHeading) inner = renderPrinciples(s.tokens);
      else if (s.title === target.faqHeading) inner = renderFaq(s.tokens);
      else inner = renderBody(s.tokens);
      return `<section class="ms" id="${s.id}"><h2>${marked.parseInline(
        s.title
      )}</h2>${inner}</section>`;
    })
    .join('\n');

  const contentHtml = metaHtml + '\n' + body;
  const dateModified = new Date().toISOString().slice(0, 10);

  const html = renderPage({
    lang: target.lang,
    contentHtml,
    toc,
    dateModified,
  });

  mkdirSync(dirname(target.out), { recursive: true });
  writeFileSync(target.out, html);
  return { sections: sections.length, bytes: Buffer.byteLength(html) };
}

// ── Run ───────────────────────────────────────────────────────
let ok = true;
for (const target of TARGETS) {
  try {
    const r = buildDoc(target);
    const rel = target.out.replace(ROOT + '/', '');
    console.log(
      `✓ ${target.lang}  ${rel}  (${r.sections} sections, ${(r.bytes / 1024).toFixed(1)} kb)`
    );
  } catch (err) {
    ok = false;
    console.error(`✗ ${target.lang} build failed:`, err.message);
    console.error(err.stack);
  }
}
if (!ok) process.exit(1);
console.log('Manifesto build complete.');
