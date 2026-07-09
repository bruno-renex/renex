// ======================================================
// Unit-Tests: attachmentCrypto Envelope (P3.2-B Reply/Attachment über v4)
// ======================================================
// Das verallgemeinerte Klartext-Envelope trägt Caption + optional Attachment-
// Meta UND/ODER Reply-Vorschau — verschlüsselt vom Double-Ratchet als Body,
// ohne separate Wire-/Server-Felder. Garantien: Round-Trip, Rückwärts-Kompat
// (bare Text bleibt prefix-frei), Legacy-wrapAttachmentPlaintext unverändert.
// ======================================================
import { describe, it, expect } from 'vitest';
import {
  wrapEnvelope, wrapAttachmentPlaintext, unwrapAttachmentPlaintext,
} from '../frontend/src/lib/attachmentCrypto.js';

const photo = { type: 'photo', r2Key: 'files/abc', fileKey: 'fk', iv: 'iv0', fileName: 'a.jpg', mimeType: 'image/jpeg', fileSize: 123 };
const gif = { type: 'gif', gifUrl: 'https://media.giphy.com/x.gif', gifPreview: 'p', gifId: 'g1' };
const reply = { id: 'msg-42', from: 'alice', preview: 'zitierter Text' };

describe('wrapEnvelope / unwrap: bare Text (Rückwärts-Kompat)', () => {
  it('ohne attachment+reply → nackte Caption, KEIN Prefix', () => {
    expect(wrapEnvelope('hallo welt', {})).toBe('hallo welt');
    expect(wrapEnvelope('', {})).toBe('');
    expect(wrapEnvelope(null, {})).toBe('');
  });
  it('bare String unwrappt als Text (alte Nachrichten)', () => {
    const u = unwrapAttachmentPlaintext('einfach text 🔐');
    expect(u.caption).toBe('einfach text 🔐');
    expect(u.attachmentMeta).toBeNull();
    expect(u.reply).toBeNull();
  });
});

describe('Attachment-only', () => {
  it('Photo round-trip', () => {
    const u = unwrapAttachmentPlaintext(wrapEnvelope('caption', { attachment: photo }));
    expect(u.caption).toBe('caption');
    expect(u.attachmentMeta).toEqual(photo);
    expect(u.reply).toBeNull();
  });
  it('GIF round-trip', () => {
    const u = unwrapAttachmentPlaintext(wrapEnvelope('', { attachment: gif }));
    expect(u.attachmentMeta.gifUrl).toBe(gif.gifUrl);
  });
  it('Legacy wrapAttachmentPlaintext unverändert', () => {
    const u = unwrapAttachmentPlaintext(wrapAttachmentPlaintext('c', photo));
    expect(u.caption).toBe('c');
    expect(u.attachmentMeta).toEqual(photo);
  });
});

describe('Reply-only (v4-Envelope)', () => {
  it('Reply round-trip ohne Attachment', () => {
    const u = unwrapAttachmentPlaintext(wrapEnvelope('meine antwort', { reply }));
    expect(u.caption).toBe('meine antwort');
    expect(u.attachmentMeta).toBeNull();
    expect(u.reply).toEqual(reply);
  });
  it('Reply ohne preview → ignoriert (kein Prefix, bare Text)', () => {
    expect(wrapEnvelope('x', { reply: { id: 'a', from: 'b' } })).toBe('x');
  });
});

describe('Attachment + Reply kombiniert', () => {
  it('beide round-trip', () => {
    const u = unwrapAttachmentPlaintext(wrapEnvelope('cap', { attachment: photo, reply }));
    expect(u.caption).toBe('cap');
    expect(u.attachmentMeta).toEqual(photo);
    expect(u.reply).toEqual(reply);
  });
});

describe('Robustheit', () => {
  it('Envelope-Prefix mit kaputtem JSON → Fallback bare Text', () => {
    const u = unwrapAttachmentPlaintext('__rx_a1__\n{nicht json');
    expect(u.attachmentMeta).toBeNull();
    expect(u.reply).toBeNull();
  });
  it('Envelope mit ungültiger Attachment-Meta aber gültiger Reply → nur Reply', () => {
    const bad = wrapEnvelope('c', { attachment: { type: 'photo' } /* fehlt fileKey/iv/r2Key */, reply });
    const u = unwrapAttachmentPlaintext(bad);
    expect(u.attachmentMeta).toBeNull();
    expect(u.reply).toEqual(reply);
    expect(u.caption).toBe('c');
  });
  it('nicht-String → leeres Ergebnis', () => {
    const u = unwrapAttachmentPlaintext(null);
    expect(u.caption).toBe('');
    expect(u.attachmentMeta).toBeNull();
    expect(u.reply).toBeNull();
  });
});
