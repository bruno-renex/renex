// ======================================================
// Unit-Tests: voiceTimers Helper
// ======================================================
// Garantien:
//   - startVoiceTimer schedule callback nach exakt ms
//   - cancelVoiceTimer verhindert Callback-Aufruf
//   - Doppel-Start mit gleichem Key resettet Delay (Idempotenz)
//   - clearAllVoiceTimers killt alle laufenden Timer
//   - Callback-Fehler crashen das Modul nicht
// ======================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startVoiceTimer,
  cancelVoiceTimer,
  isVoiceTimerActive,
  clearAllVoiceTimers,
} from '../frontend/src/lib/voiceTimers.js';

beforeEach(() => {
  clearAllVoiceTimers();
  vi.useFakeTimers();
});

describe('startVoiceTimer / cancelVoiceTimer', () => {
  it('Callback wird nach ms aufgerufen', () => {
    const cb = vi.fn();
    startVoiceTimer('test', 100, cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('cancel verhindert Callback-Aufruf', () => {
    const cb = vi.fn();
    startVoiceTimer('test', 100, cb);
    cancelVoiceTimer('test');
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
  });

  it('Doppel-Start mit gleichem Key resettet Timer (Idempotenz)', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    startVoiceTimer('test', 100, cb1);
    vi.advanceTimersByTime(50);
    // Re-Start vor Ablauf — alter cb darf NICHT mehr feuern
    startVoiceTimer('test', 100, cb2);
    vi.advanceTimersByTime(50);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('cancel ohne aktiven Timer = no-op (kein Crash)', () => {
    expect(() => cancelVoiceTimer('nonexistent')).not.toThrow();
  });

  it('Verschiedene Keys → unabhängige Timer', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    startVoiceTimer('a', 100, cbA);
    startVoiceTimer('b', 200, cbB);

    vi.advanceTimersByTime(100);
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(cbB).toHaveBeenCalledTimes(1);
  });

  it('Cancel von Key A beeinflusst Key B nicht', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    startVoiceTimer('a', 100, cbA);
    startVoiceTimer('b', 100, cbB);
    cancelVoiceTimer('a');
    vi.advanceTimersByTime(100);
    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).toHaveBeenCalledTimes(1);
  });
});

describe('isVoiceTimerActive', () => {
  it('false vor Start', () => {
    expect(isVoiceTimerActive('test')).toBe(false);
  });

  it('true zwischen Start und Fire', () => {
    startVoiceTimer('test', 100, () => {});
    expect(isVoiceTimerActive('test')).toBe(true);
  });

  it('false nach Cancel', () => {
    startVoiceTimer('test', 100, () => {});
    cancelVoiceTimer('test');
    expect(isVoiceTimerActive('test')).toBe(false);
  });

  it('false nach Auto-Fire (Timer abgelaufen)', () => {
    startVoiceTimer('test', 100, () => {});
    vi.advanceTimersByTime(100);
    expect(isVoiceTimerActive('test')).toBe(false);
  });
});

describe('clearAllVoiceTimers', () => {
  it('Killt alle aktiven Timer auf einmal', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    const cbC = vi.fn();
    startVoiceTimer('a', 100, cbA);
    startVoiceTimer('b', 200, cbB);
    startVoiceTimer('c', 300, cbC);

    clearAllVoiceTimers();
    vi.advanceTimersByTime(500);

    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).not.toHaveBeenCalled();
    expect(cbC).not.toHaveBeenCalled();
    expect(isVoiceTimerActive('a')).toBe(false);
  });
});

describe('Robustness', () => {
  it('Callback wirft Exception → andere Timer laufen weiter', () => {
    const cbA = vi.fn(() => { throw new Error('boom'); });
    const cbB = vi.fn();
    startVoiceTimer('a', 100, cbA);
    startVoiceTimer('b', 200, cbB);

    vi.advanceTimersByTime(100);
    expect(cbA).toHaveBeenCalledTimes(1);
    // Trotz Exception in cbA muss cbB normal feuern
    vi.advanceTimersByTime(100);
    expect(cbB).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────
// No-Answer-Timeout-Pattern: 30s mit State-Guard
// Simuliert das Verhalten von voice.svelte.js _startNoAnswerTimer
// ohne den Voice-Store direkt zu importieren (der hat Svelte-5-Rune-Deps).
// ────────────────────────────────────────────────────────
describe('No-Answer-Timeout Pattern (Voice-Store Behavior)', () => {
  const RING_TIMEOUT_MS = 30_000;

  it('Caller: nach 30s im RINGING → endCall fired', () => {
    let state = 'ringing';
    const endCall = vi.fn();
    const declineCall = vi.fn();

    startVoiceTimer('no-answer', RING_TIMEOUT_MS, () => {
      if (state !== 'ringing') return;
      endCall();  // role=caller
    });

    vi.advanceTimersByTime(30_000);
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(declineCall).not.toHaveBeenCalled();
  });

  it('Callee: nach 30s im RINGING → declineCall fired', () => {
    let state = 'ringing';
    const declineCall = vi.fn();

    startVoiceTimer('no-answer', RING_TIMEOUT_MS, () => {
      if (state !== 'ringing') return;
      declineCall();  // role=callee
    });

    vi.advanceTimersByTime(30_000);
    expect(declineCall).toHaveBeenCalledTimes(1);
  });

  it('State-Guard: wenn state nicht mehr RINGING, kein endCall (User cancelled bereits)', () => {
    let state = 'ringing';
    const endCall = vi.fn();
    startVoiceTimer('no-answer', RING_TIMEOUT_MS, () => {
      if (state !== 'ringing') return;  // ← Guard
      endCall();
    });
    state = 'ended';  // User hat manuell cancelled vor Timeout
    vi.advanceTimersByTime(30_000);
    expect(endCall).not.toHaveBeenCalled();
  });

  it('Cancel bei Answer (peer hat angenommen) → kein automatic-cancel', () => {
    const endCall = vi.fn();
    startVoiceTimer('no-answer', RING_TIMEOUT_MS, () => endCall());
    // Peer antwortet nach 5s
    vi.advanceTimersByTime(5_000);
    cancelVoiceTimer('no-answer');
    // Restliche 25s ablaufen lassen
    vi.advanceTimersByTime(25_000);
    expect(endCall).not.toHaveBeenCalled();
  });

  it('29.9s ist NICHT genug — Timer fired erst bei 30s', () => {
    const endCall = vi.fn();
    startVoiceTimer('no-answer', RING_TIMEOUT_MS, () => endCall());
    vi.advanceTimersByTime(29_900);
    expect(endCall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(endCall).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────
// ICE-Reconnect-Pattern (B17)
// Simuliert das onIceConnectionStateChange-Verhalten: nach 5s in
// 'disconnected' triggern wir pc.restartIce(). Bei Recovery vor Timeout:
// Timer cancelled (banner verschwindet).
// ────────────────────────────────────────────────────────
describe('ICE-Reconnect Pattern (Voice-Store Behavior)', () => {
  const RESTART_ICE_DELAY_MS = 5_000;

  it('disconnected → 5s warten → pc.restartIce() fired', () => {
    const fakePc = { iceConnectionState: 'disconnected', restartIce: vi.fn() };
    let state = 'active';

    startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => {
      if (state !== 'active') return;
      if (fakePc.iceConnectionState !== 'disconnected') return;
      fakePc.restartIce();
    });

    vi.advanceTimersByTime(4_999);
    expect(fakePc.restartIce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fakePc.restartIce).toHaveBeenCalledTimes(1);
  });

  it('Recovery vor Timeout: ICE state wechselt zu connected → restartIce skip', () => {
    const fakePc = { iceConnectionState: 'disconnected', restartIce: vi.fn() };
    let state = 'active';

    startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => {
      if (state !== 'active') return;
      if (fakePc.iceConnectionState !== 'disconnected') return;
      fakePc.restartIce();
    });

    // Browser-self-recovery nach 3s
    vi.advanceTimersByTime(3_000);
    fakePc.iceConnectionState = 'connected';

    vi.advanceTimersByTime(2_500);
    // Timer feuert zwar — aber state-guard skip-t
    expect(fakePc.restartIce).not.toHaveBeenCalled();
  });

  it('Cancel bei Recovery (z.B. ics=connected event) → kein restartIce', () => {
    const fakePc = { iceConnectionState: 'disconnected', restartIce: vi.fn() };
    startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => fakePc.restartIce());
    vi.advanceTimersByTime(2_000);

    // Simuliert "ics=connected" handler clears the timer
    cancelVoiceTimer('restart-ice');

    vi.advanceTimersByTime(5_000);
    expect(fakePc.restartIce).not.toHaveBeenCalled();
  });

  it('State wechselt von ACTIVE zu ENDED während Wait → restartIce skip', () => {
    const fakePc = { iceConnectionState: 'disconnected', restartIce: vi.fn() };
    let state = 'active';

    startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => {
      if (state !== 'active') return;
      fakePc.restartIce();
    });

    vi.advanceTimersByTime(2_000);
    state = 'ended';  // User hat aufgelegt
    vi.advanceTimersByTime(5_000);
    expect(fakePc.restartIce).not.toHaveBeenCalled();
  });

  it('restartIce() wirft Exception → Timer-Pattern fängt es ab (kein Crash)', () => {
    const fakePc = {
      iceConnectionState: 'disconnected',
      restartIce: vi.fn(() => { throw new Error('webrtc internal'); }),
    };

    expect(() => {
      startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => {
        if (fakePc.iceConnectionState === 'disconnected') {
          try { fakePc.restartIce(); } catch (e) { /* swallow */ }
        }
      });
      vi.advanceTimersByTime(5_000);
    }).not.toThrow();

    expect(fakePc.restartIce).toHaveBeenCalledTimes(1);
  });

  it('Doppel-disconnect (rapid flapping) → nur EIN Timer aktiv (nicht 2)', () => {
    const fakePc = { iceConnectionState: 'disconnected', restartIce: vi.fn() };

    startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => {
      if (fakePc.iceConnectionState === 'disconnected') fakePc.restartIce();
    });

    // Zweiter disconnect-event (Browser flapped) → re-start, alter timer wird canceled
    vi.advanceTimersByTime(2_000);
    startVoiceTimer('restart-ice', RESTART_ICE_DELAY_MS, () => {
      if (fakePc.iceConnectionState === 'disconnected') fakePc.restartIce();
    });

    // Erste Timer hätte bei 5s gefeuert (3s nach re-start) → er ist gecanceled
    vi.advanceTimersByTime(3_000);
    expect(fakePc.restartIce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);  // 5s nach re-start
    expect(fakePc.restartIce).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────
// Multi-Timer-Coexistence
// No-Answer + Restart-ICE können theoretisch parallel laufen
// (No-Answer ist im RINGING, Restart-ICE im ACTIVE — getrennte Phasen)
// aber clearAllVoiceTimers muss beide killen.
// ────────────────────────────────────────────────────────
describe('Multi-Timer-Coexistence', () => {
  it('No-Answer und Restart-ICE Timer sind unabhängig', () => {
    const noAnswerCb = vi.fn();
    const iceCb = vi.fn();

    startVoiceTimer('no-answer', 30_000, noAnswerCb);
    startVoiceTimer('restart-ice', 5_000, iceCb);

    expect(isVoiceTimerActive('no-answer')).toBe(true);
    expect(isVoiceTimerActive('restart-ice')).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(iceCb).toHaveBeenCalledTimes(1);
    expect(noAnswerCb).not.toHaveBeenCalled();
    expect(isVoiceTimerActive('no-answer')).toBe(true);

    vi.advanceTimersByTime(25_000);
    expect(noAnswerCb).toHaveBeenCalledTimes(1);
  });

  it('clearAllVoiceTimers killt beide auf einmal (z.B. _hardReset)', () => {
    const noAnswerCb = vi.fn();
    const iceCb = vi.fn();

    startVoiceTimer('no-answer', 30_000, noAnswerCb);
    startVoiceTimer('restart-ice', 5_000, iceCb);
    clearAllVoiceTimers();

    vi.advanceTimersByTime(60_000);
    expect(noAnswerCb).not.toHaveBeenCalled();
    expect(iceCb).not.toHaveBeenCalled();
  });
});
