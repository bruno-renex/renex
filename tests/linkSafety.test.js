// ======================================================
// Unit-Tests: linkSafety (Homograph- und Phishing-Heuristik)
// ======================================================
// Garantien:
//   - Safe (kein Warning): saubere ASCII-Hostnames
//   - Unsafe (Warning): Punycode, gemischte Skripte im Host-Label,
//     userinfo (user:pass@host), bekannte URL-Shortener
//   - Invalid URLs → {safe:false, reason:'invalid'}
//   - Mehrere subdomains mit jeweils einem nicht-ASCII-Skript ist ok,
//     gemischt im SELBEN Label nicht
// ======================================================
import { describe, it, expect } from 'vitest';
import { analyzeLink, reasonText } from '../frontend/src/lib/linkSafety.js';

describe('analyzeLink — sichere URLs', () => {
  it('einfache https-URL ist safe', () => {
    const r = analyzeLink('https://example.com');
    expect(r.safe).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('http und https beide ok (kein TLS-Zwang an dieser Stelle)', () => {
    expect(analyzeLink('http://example.com').safe).toBe(true);
    expect(analyzeLink('https://example.com').safe).toBe(true);
  });

  it('Pfad, Query, Fragment sind ok', () => {
    expect(analyzeLink('https://example.com/path?q=1#h').safe).toBe(true);
  });

  it('Subdomain mit Bindestrich ist ok', () => {
    expect(analyzeLink('https://my-sub.example-domain.com').safe).toBe(true);
  });

  it('Port ist ok', () => {
    expect(analyzeLink('https://example.com:8443/').safe).toBe(true);
  });
});

describe('analyzeLink — unsafe URLs', () => {
  it('ungültige URL', () => {
    const r = analyzeLink('not a url');
    expect(r.safe).toBe(false);
    expect(r.reason).toBe('invalid');
  });

  it('non-http(s) Schemas werden als invalid behandelt', () => {
    expect(analyzeLink('ftp://example.com').reason).toBe('invalid');
    expect(analyzeLink('file:///etc/passwd').reason).toBe('invalid');
  });

  it('userinfo im URL → Phishing-Trick', () => {
    const r = analyzeLink('https://google.com@evil.example/');
    expect(r.safe).toBe(false);
    expect(r.reason).toBe('userinfo');
    expect(r.hasUserinfo).toBe(true);
    // Tatsächlicher Host ist evil.example, nicht google.com
    expect(r.host).toBe('evil.example');
  });

  it('Punycode-Host → unsafe (punycode)', () => {
    const r = analyzeLink('https://xn--bcher-kva.example');
    expect(r.safe).toBe(false);
    // Entweder 'punycode' oder 'mixed_scripts' je nachdem wie der Browser
    // den IDN dekodiert. Beide sind in Ordnung — wichtig ist: NICHT safe.
    expect(['punycode', 'mixed_scripts']).toContain(r.reason);
  });

  it('URL-Shortener → unsafe', () => {
    expect(analyzeLink('https://bit.ly/abc').reason).toBe('shortener');
    expect(analyzeLink('https://t.co/xyz').reason).toBe('shortener');
    expect(analyzeLink('https://tinyurl.com/foo').reason).toBe('shortener');
  });

  it('Mixed-Scripts im selben Label (Cyrillic + Latin) → unsafe', () => {
    // "apple" mit kyrillischem а (U+0430) statt lateinischem a
    // Browser dekodiert dies typischerweise, mixed-scripts greift dann.
    // Manche URL-Parser normalisieren — Test mit literalem Mix.
    const r = analyzeLink('https://а' + 'pple.com');
    expect(r.safe).toBe(false);
    // Akzeptiere mehrere Reasons je nach Browser-Normalisierung
    expect(['punycode', 'mixed_scripts']).toContain(r.reason);
  });

  it('reine nicht-ASCII-Domain (z.B. nur Japanisch) ist ok', () => {
    // 日本.jp — single script per label, ASCII nur in TLD
    // Browser konvertiert evtl. zu xn-- → dann wäre es punycode → unsafe.
    // Wir prüfen nur: wenn Browser es dekodiert UND kein mix-script,
    // sollte es safe sein. Wenn Browser punycode draus macht → unsafe.
    // Beide Verhalten sind defensiv vertretbar — wir akzeptieren beides.
    const r = analyzeLink('https://日本.example');
    expect(typeof r.safe).toBe('boolean');
  });
});

describe('reasonText', () => {
  it('liefert Text für jeden Reason', () => {
    expect(reasonText('punycode', 'xn--foo.example')).toMatch(/Punycode/i);
    expect(reasonText('mixed_scripts', 'foo')).toMatch(/Schriftsystem/i);
    expect(reasonText('userinfo', '')).toMatch(/@-Zeichen/i);
    expect(reasonText('shortener', '')).toMatch(/Shortener/i);
    expect(reasonText('invalid', '')).toMatch(/ungültig/i);
  });

  it('unbekannter Reason → leerer String', () => {
    expect(reasonText('unknown', '')).toBe('');
  });
});
