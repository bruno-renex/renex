// ======================================================
// Pulse Store — Reactive Presence-State (Svelte 5 Runes)
// ======================================================
// Spec: docs/PULSE.md §4 (Datenmodell), §7.3 (Receiver-Smoothing),
//       §8.1 (Privacy: kein Persist, Wipe bei Logout), §9.1 (Per-Chat-Opt-in)
//
// Hält pro aktiver 1:1-Konversation:
//   - eigenen Pulse (self) — was wir senden
//   - Peer-Pulse — was wir empfangen, receiver-seitig geglättet
//
// Privacy-Hardrules:
//   - KEINE Persistenz von Energy-Werten (nur transient im RAM)
//   - localStorage NUR für das Opt-in-Flag (peer:<handle>:pulse_optin)
//   - wipe() bei Logout löscht Opt-in-Flags + RAM-State
//   - NIEMALS last-known Pulse cachen (Cold-Start startet bei 0)
// ======================================================

import { MODES, modeFromEnergy } from '../lib/pulse/engine.js';
import { get, set } from '../lib/storage.js';

const OPTIN = (peer) => `peer:${String(peer).toLowerCase()}:pulse_optin`;
const STALE_MS = 2000;        // >2s kein Frame → Peer-Pulse ausfaden (§7.3)
const STALE_DECAY = 0.1;      // Energie-Einheiten/s beim Ausfaden
const RECV_LERP = 0.18;       // Receiver-Side Smoothing-Faktor

// ── Reaktiver State ──
let _activePeer = $state(null);     // Handle des offenen, pulse-aktiven Chats
let _enabled = $state(false);       // Pulse für den aktiven Chat eingeschaltet?
let _selfEnergy = $state(0.05);
let _selfMode = $state(MODES.CALM);
let _peerEnergy = $state(0);        // geglättet (für Render)
let _peerMode = $state(MODES.CALM);
let _peerActive = $state(false);    // kürzlich ein Frame empfangen?
let _motionGranted = $state(false); // DeviceMotion-Permission erteilt (Session)

// ── Nicht-reaktiver Receiver-State ──
let _peerTarget = 0;                // zuletzt empfangener Zielwert
let _peerLastTs = 0;                // ts des letzten Frames (monoton, ms)

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
}

function resetPeer() {
  _peerTarget = 0;
  _peerLastTs = 0;
  _peerEnergy = 0;
  _peerMode = MODES.CALM;
  _peerActive = false;
}

export const pulseStore = {
  get activePeer() { return _activePeer; },
  get enabled()    { return _enabled; },
  get selfEnergy() { return _selfEnergy; },
  get selfMode()   { return _selfMode; },
  get peerEnergy() { return _peerEnergy; },
  get peerMode()   { return _peerMode; },
  get peerActive() { return _peerActive; },
  get motionGranted() { return _motionGranted; },
  setMotionGranted(on) { _motionGranted = !!on; },

  // ── Per-Chat-Opt-in (localStorage) ──
  isEnabledFor(peer) {
    return get(OPTIN(peer)) === 'true';
  },
  setEnabledFor(peer, on) {
    set(OPTIN(peer), on ? 'true' : 'false');
    if (peer && _activePeer && String(peer).toLowerCase() === _activePeer) {
      _enabled = !!on;
      if (!on) resetPeer();
    }
  },

  // ── Aktivierung beim Öffnen/Schließen eines 1:1-Chats ──
  activate(peer) {
    const norm = peer ? String(peer).toLowerCase() : null;
    // IDEMPOTENT: schon aktiv für diesen Peer → höchstens Opt-in refreshen, kein
    // unbedingtes Schreiben. Verhindert effect_update_depth (Svelte 5: ein Effect
    // darf nicht bei jedem Flush State schreiben, den die Reaktiv-Kette liest).
    if (norm === _activePeer) {
      const en = norm ? this.isEnabledFor(norm) : false;
      if (en !== _enabled) _enabled = en;
      return;
    }
    _activePeer = norm;
    _enabled = norm ? this.isEnabledFor(norm) : false;
    resetPeer();
    // Cold-Start: eigener Pulse startet ruhig (Lebenszeichen), nie gecacht.
    _selfEnergy = 0.05;
    _selfMode = MODES.CALM;
  },
  deactivate() {
    if (_activePeer === null && _enabled === false && !_peerActive) return; // no-op
    _activePeer = null;
    _enabled = false;
    resetPeer();
  },

  // ── Eigener Pulse (von der Engine/Inputs getrieben) ──
  setSelf(energy, mode) {
    _selfEnergy = energy;
    _selfMode = mode || modeFromEnergy(energy);
  },

  // ── Eingehender Peer-Frame (nach Decrypt). `from` muss der offene Chat sein. ──
  onPeerFrame(from, energy, mode, ts) {
    if (!_activePeer || String(from).toLowerCase() !== _activePeer) return;
    _peerTarget = Math.max(0, Math.min(1, Number(energy) || 0));
    _peerMode = mode || modeFromEnergy(_peerTarget);
    _peerLastTs = ts || nowMs();
    _peerActive = true;
  },

  // ── Pro Frame aus der Canvas-rAF-Loop aufrufen (monotoner `now`) ──
  tickPeer(now) {
    // Stale-Stream → Ziel ausfaden (Decay), Drop-Resilienz (§7.3)
    if (_peerActive && now - _peerLastTs > STALE_MS) {
      _peerTarget = Math.max(0, _peerTarget - STALE_DECAY / 60);
      if (_peerTarget <= 0.001) { _peerTarget = 0; _peerActive = false; }
    }
    // Receiver-Side Smoothing (lerp gegen Ziel)
    _peerEnergy = _peerEnergy + (_peerTarget - _peerEnergy) * RECV_LERP;
    if (!_peerActive && _peerEnergy < 0.002) {
      _peerEnergy = 0;
      _peerMode = MODES.CALM;
    }
    return { energy: _peerEnergy, mode: _peerMode, active: _peerActive };
  },

  // ── Logout: Opt-in-Flags + RAM wipen (Privacy-Hardrule §8.1) ──
  wipe() {
    this.deactivate();
    _selfEnergy = 0.05;
    _selfMode = MODES.CALM;
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        // storage.js prefixt mit "renex_"
        if (key && key.startsWith('renex_peer:') && key.endsWith(':pulse_optin')) {
          toRemove.push(key);
        }
      }
      for (const key of toRemove) localStorage.removeItem(key);
    } catch { /* Private-Mode / Quota */ }
  },
};
