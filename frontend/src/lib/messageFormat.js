// ======================================================
// messageFormat — Nachrichten-Text in Render-Segmente zerlegen
// ======================================================
// Unterstützte Syntax (Discord-Subset, v1):
//   ```code```            Code-Block (multiline, kein weiteres Parsing)
//   `code`                Inline-Code (kein weiteres Parsing)
//   **bold**              Bold (rekursiv: kann italic/code/link enthalten)
//   *italic* / _italic_   Italic (rekursiv)
//   https?://…            Autolink
//   alles andere          Plain-Text
//
// Designprinzipien:
//  - KEIN HTML-String wird je gebaut → XSS strukturell unmöglich.
//    Der Renderer baut nur Text-/Container-Knoten via Svelte-Snippet.
//  - URL-Erkennung restriktiv: ausschließlich https?:// mit Schema.
//    Bare "example.com" wird NICHT erkannt.
//  - Code-Inhalte sind LITERAL — kein weiteres Parsing, keine Autolinks.
//    Schützt vor "klick auf scheinbar harmlose Codeschnipsel".
//  - Trailing-Punctuation/Balanced-Parens bei Autolinks (Discord-Style).
//
// Segment-Tree:
//   { type: 'text',      value: string }
//   { type: 'link',      href: string, text: string }
//   { type: 'code',      value: string }                  // inline, kein children
//   { type: 'codeblock', value: string, lang: string|null }
//   { type: 'bold',      children: Segment[] }
//   { type: 'italic',    children: Segment[] }
// ======================================================

// ── Autolink-Regex ──────────────────────────────────────
// Stop-Chars: whitespace, HTML-Brackets, Quotes, Backtick (Code-Marker),
// und `*` (Bold/Italic-Marker). `_` ist BEWUSST erlaubt — Wikipedia &
// viele andere URLs enthalten Underscores. _italic_-Detection greift
// nur an Word-Boundaries, also vor URL → kein Konflikt.
const URL_REGEX = /https?:\/\/[^\s<>"`*]+/gi;
const TRAILING_PUNCT = /[.,;:!?]+$/;

function stripUnbalancedClosers(url) {
  let changed = true;
  while (changed) {
    changed = false;
    const afterPunct = url.replace(TRAILING_PUNCT, '');
    if (afterPunct !== url) { url = afterPunct; changed = true; }

    const last = url[url.length - 1];
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      const opens = (url.match(new RegExp('\\' + open, 'g')) || []).length;
      const closes = (url.match(new RegExp('\\' + last, 'g')) || []).length;
      if (closes > opens) {
        url = url.slice(0, -1);
        changed = true;
      }
    }
  }
  return url;
}

function isSafeHref(href) {
  return /^https?:\/\//i.test(href);
}

/**
 * Autolinker — operiert auf Klartext-Strings (innerhalb von bold/italic
 * oder am Top-Level).
 *
 * @param {string} text
 * @returns {Array<{type:'text',value:string}|{type:'link',href:string,text:string}>}
 */
function autolinkText(text) {
  if (!text) return [];
  const segments = [];
  let lastIndex = 0;
  URL_REGEX.lastIndex = 0;
  let match;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const rawUrl = match[0];
    const cleanUrl = stripUnbalancedClosers(rawUrl);
    if (!cleanUrl || !isSafeHref(cleanUrl)) continue;

    const urlStart = match.index;
    const urlEnd = urlStart + cleanUrl.length;

    if (urlStart > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, urlStart) });
    }
    segments.push({ type: 'link', href: cleanUrl, text: cleanUrl });

    lastIndex = urlEnd;
    if (cleanUrl.length < rawUrl.length) {
      URL_REGEX.lastIndex = urlEnd;
    }
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

// ── Inline-Markdown-Parser (bold/italic) ────────────────
//
// Rekursiver Descent. Pro Position:
//   1. Versuche **bold** (greedy bis nächstes **)
//   2. Versuche *italic*  (nicht-greedy)
//   3. Versuche _italic_  (Word-Boundary)
//   4. Akkumuliere Plain-Text bis zur nächsten potenziellen Markdown-Stelle
//      → Autolink-Pass auf dem akkumulierten Text.

/**
 * Findet die schließende Position für einen einfachen `*`-Italic.
 * Das öffnende `*` ist an Position `start-1`. Wir suchen ein `*`, das
 * nicht Teil eines `**` ist und nicht von einem `*` umgeben.
 */
function findItalicAsteriskClose(text, start) {
  let i = start;
  while (i < text.length) {
    if (text[i] === '*' && text[i - 1] !== '*' && text[i + 1] !== '*') {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Parst Inline-Text (bold/italic + Autolinks). KEIN Code-Handling hier —
 * das passiert im äußeren parseBlocks.
 */
function parseFormatting(text) {
  if (!text) return [];
  const out = [];
  let pos = 0;
  let textBuf = '';

  const flushText = () => {
    if (textBuf) {
      out.push(...autolinkText(textBuf));
      textBuf = '';
    }
  };

  while (pos < text.length) {
    // **bold**
    if (text[pos] === '*' && text[pos + 1] === '*') {
      const close = text.indexOf('**', pos + 2);
      if (close > pos + 2) {
        const inner = text.slice(pos + 2, close);
        // Leerer oder nur-whitespace-Inhalt → literale Sterne behandeln
        if (inner.trim()) {
          flushText();
          out.push({ type: 'bold', children: parseFormatting(inner) });
          pos = close + 2;
          continue;
        }
      }
    }

    // *italic*  (nicht **)
    if (text[pos] === '*' && text[pos + 1] !== '*' && (pos === 0 || text[pos - 1] !== '*')) {
      const close = findItalicAsteriskClose(text, pos + 1);
      if (close > pos + 1) {
        const inner = text.slice(pos + 1, close);
        if (inner.trim()) {
          flushText();
          out.push({ type: 'italic', children: parseFormatting(inner) });
          pos = close + 1;
          continue;
        }
      }
    }

    // _italic_  (intra-word-_ wie in `snake_case` darf NICHT triggern)
    if (text[pos] === '_' && (pos === 0 || /[\s\W]/.test(text[pos - 1])) && text[pos + 1] !== '_') {
      const close = text.indexOf('_', pos + 1);
      if (
        close > pos + 1 &&
        (close + 1 >= text.length || /[\s\W]/.test(text[close + 1]))
      ) {
        const inner = text.slice(pos + 1, close);
        if (inner.trim()) {
          flushText();
          out.push({ type: 'italic', children: parseFormatting(inner) });
          pos = close + 1;
          continue;
        }
      }
    }

    // Plain-Text-Char
    textBuf += text[pos];
    pos++;
  }

  flushText();
  return out;
}

// ── Block-Level: Code-Blocks und Inline-Code zuerst ──────
//
// Code-Inhalte werden NIE weiter geparst — sie sind literal.
// Reihenfolge: triple-backtick zuerst (greift über mehrere Zeilen),
// dann single-backtick (eine Zeile), dann der Rest geht in parseFormatting.

const CODEBLOCK_REGEX = /```(?:([a-zA-Z0-9_+-]*)\n)?([\s\S]*?)```/g;
const INLINE_CODE_REGEX = /`([^`\n]+)`/g;

function parseInline(text) {
  if (!text) return [];
  const out = [];
  let lastIndex = 0;
  INLINE_CODE_REGEX.lastIndex = 0;
  let m;
  while ((m = INLINE_CODE_REGEX.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push(...parseFormatting(text.slice(lastIndex, m.index)));
    }
    out.push({ type: 'code', value: m[1] });
    lastIndex = INLINE_CODE_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    out.push(...parseFormatting(text.slice(lastIndex)));
  }
  return out;
}

/**
 * Top-Level-Parser: zerlegt Text in Render-Segmente.
 *
 * @param {string} text
 * @returns {Array<Object>}
 */
export function formatMessage(text) {
  if (!text || typeof text !== 'string') return [];

  const out = [];
  let lastIndex = 0;
  CODEBLOCK_REGEX.lastIndex = 0;
  let m;
  while ((m = CODEBLOCK_REGEX.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push(...parseInline(text.slice(lastIndex, m.index)));
    }
    // Trailing-Newline vor ``` wegrechnen — sonst rendert <pre> eine
    // visuelle Leerzeile am Ende des Blocks.
    out.push({
      type: 'codeblock',
      value: m[2].replace(/\n$/, ''),
      lang: m[1] || null,
    });
    lastIndex = CODEBLOCK_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    out.push(...parseInline(text.slice(lastIndex)));
  }
  return out;
}

/**
 * Plain-Text-Variante für Notifications, Reply-Preview, Inbox-Last-Message,
 * Search. Strippt Markdown-Marker, behält Klartext-Inhalt.
 *
 *   "**hi** `code` *ok*"  →  "hi code ok"
 *   "siehe https://x.com" →  "siehe https://x.com"  (URLs bleiben)
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFormatting(text) {
  if (!text || typeof text !== 'string') return '';

  // Wir nutzen den Parser und rendern alle Segmente flach als String.
  // Etwas Overhead, aber garantiert konsistent mit dem Renderer.
  const segs = formatMessage(text);
  return flattenSegments(segs).trim();
}

function flattenSegments(segs) {
  let out = '';
  for (const seg of segs) {
    if (seg.type === 'text') out += seg.value;
    else if (seg.type === 'link') out += seg.text;
    else if (seg.type === 'code') out += seg.value;
    else if (seg.type === 'codeblock') out += seg.value;
    else if (seg.children) out += flattenSegments(seg.children);
  }
  return out;
}
