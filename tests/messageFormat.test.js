// ======================================================
// Unit-Tests: messageFormat (Autolinks + Markdown-Subset)
// ======================================================
// Garantien:
//   AUTOLINKS:
//   - Nur https?:// wird als Link erkannt (kein bare "example.com",
//     kein javascript:, kein data:)
//   - Trailing-Punctuation/unbalanced-Closer werden korrekt gestrippt
//   - Balanced Parens (Wikipedia-Pattern) bleiben Teil der URL
//   MARKDOWN:
//   - `code` (inline) und ```code``` (block) — Inhalt LITERAL
//   - **bold**, *italic*, _italic_ — rekursiv schachtelbar
//   - Code-Inhalt wird NICHT weiter geparst (Sicherheits-Eigenschaft)
//   - snake_case darf nicht als italic interpretiert werden
//   STRIPPING:
//   - stripFormatting entfernt Marker, behält Klartext
// ======================================================
import { describe, it, expect } from 'vitest';
import { formatMessage, stripFormatting } from '../frontend/src/lib/messageFormat.js';

// ── Helper für Tree-Vergleich ───────────────────────────
function plain(value) { return { type: 'text', value }; }
function link(href)   { return { type: 'link', href, text: href }; }
function code(value)  { return { type: 'code', value }; }
function block(value, lang = null) { return { type: 'codeblock', value, lang }; }
function bold(...children)   { return { type: 'bold', children }; }
function italic(...children) { return { type: 'italic', children }; }

describe('formatMessage — Autolinks', () => {
  it('returnt [] für leeren oder ungültigen Input', () => {
    expect(formatMessage('')).toEqual([]);
    expect(formatMessage(null)).toEqual([]);
    expect(formatMessage(undefined)).toEqual([]);
    expect(formatMessage(123)).toEqual([]);
  });

  it('Text ohne URL bleibt ein einzelnes Text-Segment', () => {
    expect(formatMessage('Hallo Welt')).toEqual([plain('Hallo Welt')]);
  });

  it('erkennt einfache https-URL', () => {
    expect(formatMessage('Schau https://example.com an')).toEqual([
      plain('Schau '),
      link('https://example.com'),
      plain(' an'),
    ]);
  });

  it('erkennt KEINE bare Domain ohne Schema', () => {
    expect(formatMessage('Geh auf example.com bitte'))
      .toEqual([plain('Geh auf example.com bitte')]);
  });

  it('erkennt KEINE javascript:- und data:-URLs', () => {
    expect(formatMessage('javascript:alert(1)')).toEqual([plain('javascript:alert(1)')]);
    expect(formatMessage('data:text/html,foo')).toEqual([plain('data:text/html,foo')]);
  });

  it('strippt Trailing-Punctuation, behält Query-String', () => {
    expect(formatMessage('Siehe https://example.com.')).toEqual([
      plain('Siehe '), link('https://example.com'), plain('.'),
    ]);
    expect(formatMessage('https://x.com/p?q=1#h')).toEqual([
      link('https://x.com/p?q=1#h'),
    ]);
  });

  it('balanced Parens bleiben, unbalanced Closer werden gestrippt', () => {
    expect(formatMessage('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      link('https://en.wikipedia.org/wiki/Foo_(bar)'),
    ]);
    expect(formatMessage('(siehe https://x.com)')).toEqual([
      plain('(siehe '), link('https://x.com'), plain(')'),
    ]);
  });
});

describe('formatMessage — Inline-Code', () => {
  it('erkennt `code` zwischen Backticks', () => {
    expect(formatMessage('use `npm install` now')).toEqual([
      plain('use '), code('npm install'), plain(' now'),
    ]);
  });

  it('Inhalt von `code` wird NICHT weiter geparst (XSS-/Phishing-Schutz)', () => {
    // **bold** und https://… innerhalb von `code` bleiben literal
    expect(formatMessage('`**not bold** https://x.com`')).toEqual([
      code('**not bold** https://x.com'),
    ]);
  });

  it('mehrzeilige `code`-Spans werden ignoriert (nur single-line)', () => {
    expect(formatMessage('`mit\nnewline`')).toEqual([
      plain('`mit\nnewline`'),
    ]);
  });
});

describe('formatMessage — Code-Block', () => {
  it('erkennt ```...``` über mehrere Zeilen', () => {
    expect(formatMessage('Test:\n```\nlet x = 1;\n```\nfertig')).toEqual([
      plain('Test:\n'),
      block('let x = 1;'),
      plain('\nfertig'),
    ]);
  });

  it('erkennt Sprach-Tag', () => {
    expect(formatMessage('```js\nlet x;\n```')).toEqual([
      block('let x;', 'js'),
    ]);
  });

  it('Code-Block-Inhalt wird NICHT weiter geparst', () => {
    expect(formatMessage('```\n**not bold** https://x.com\n```')).toEqual([
      block('**not bold** https://x.com'),
    ]);
  });
});

describe('formatMessage — Bold/Italic', () => {
  it('**bold**', () => {
    expect(formatMessage('das ist **fett** und gut')).toEqual([
      plain('das ist '), bold(plain('fett')), plain(' und gut'),
    ]);
  });

  it('*italic*', () => {
    expect(formatMessage('das ist *kursiv* und gut')).toEqual([
      plain('das ist '), italic(plain('kursiv')), plain(' und gut'),
    ]);
  });

  it('_italic_ (underscore)', () => {
    expect(formatMessage('das ist _kursiv_ und gut')).toEqual([
      plain('das ist '), italic(plain('kursiv')), plain(' und gut'),
    ]);
  });

  it('snake_case wird NICHT als italic interpretiert', () => {
    expect(formatMessage('foo_bar_baz ist eine Variable')).toEqual([
      plain('foo_bar_baz ist eine Variable'),
    ]);
  });

  it('**bold** mit *italic* nested', () => {
    expect(formatMessage('**fett *und kursiv* zusammen**')).toEqual([
      bold(
        plain('fett '),
        italic(plain('und kursiv')),
        plain(' zusammen'),
      ),
    ]);
  });

  it('Link innerhalb von **bold**', () => {
    expect(formatMessage('**siehe https://x.com bitte**')).toEqual([
      bold(
        plain('siehe '),
        link('https://x.com'),
        plain(' bitte'),
      ),
    ]);
  });

  it('Leerer **-Block bleibt literal', () => {
    expect(formatMessage('****')).toEqual([plain('****')]);
  });

  it('Unbalanced ** bleibt literal', () => {
    expect(formatMessage('**nicht zu')).toEqual([plain('**nicht zu')]);
  });
});

describe('formatMessage — Kombiniert', () => {
  it('Text + Code + Bold + Link in einer Message', () => {
    const segs = formatMessage('Hier `code`, **fett** und https://x.com');
    expect(segs).toEqual([
      plain('Hier '),
      code('code'),
      plain(', '),
      bold(plain('fett')),
      plain(' und '),
      link('https://x.com'),
    ]);
  });

  it('Code-Block schluckt Bold-Marker (literal bleibt literal)', () => {
    const segs = formatMessage('```\n**raw**\n```');
    expect(segs).toEqual([block('**raw**')]);
  });
});

describe('stripFormatting', () => {
  it('strippt Bold/Italic-Marker, behält Inhalt', () => {
    expect(stripFormatting('**Hi** *du* da')).toBe('Hi du da');
  });

  it('strippt Inline-Code-Marker, behält Inhalt', () => {
    expect(stripFormatting('use `npm i` now')).toBe('use npm i now');
  });

  it('strippt Code-Block-Marker, behält Inhalt', () => {
    expect(stripFormatting('```\nlet x;\n```')).toBe('let x;');
  });

  it('Autolink: URL bleibt sichtbar', () => {
    expect(stripFormatting('schau https://x.com'))
      .toBe('schau https://x.com');
  });

  it('Plain-Text bleibt unverändert', () => {
    expect(stripFormatting('einfach nur text')).toBe('einfach nur text');
  });

  it('leerer/ungültiger Input → leerer String', () => {
    expect(stripFormatting('')).toBe('');
    expect(stripFormatting(null)).toBe('');
    expect(stripFormatting(undefined)).toBe('');
  });
});
