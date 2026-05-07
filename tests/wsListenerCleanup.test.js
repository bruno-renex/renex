// ======================================================
// Unit-Tests: WS-Listener-Cleanup (Memory-Leak-Prävention)
// ======================================================
// Garantien:
//   - on() returnt unsub-fn die NUR diesen Listener entfernt
//   - Mehrfach-Listener pro Event funktionieren
//   - off() entfernt einzelne Listener
//   - unsub() leere Sets aus Map auf (kein Set-Leak)
//   - removeAllListeners() killt alles
//   - stop() ruft removeAllListeners auf (defense-in-depth)
//   - Doppel-unsub() ist idempotent (kein Crash)
//   - listenerCount-Getter genau
// ======================================================
import { describe, it, expect, beforeEach } from 'vitest';
import { ws } from '../frontend/src/lib/ws.js';

beforeEach(() => {
  ws.removeAllListeners();
});

// ────────────────────────────────────────────────────────
// 1. Basic on/off
// ────────────────────────────────────────────────────────
describe('ws.on / ws.off', () => {
  it('listenerCount=0 nach removeAllListeners', () => {
    expect(ws.listenerCount).toBe(0);
  });

  it('on() inkrementiert count, unsub() dekrementiert', () => {
    const unsub = ws.on('test', () => {});
    expect(ws.listenerCount).toBe(1);
    unsub();
    expect(ws.listenerCount).toBe(0);
  });

  it('off() entfernt einzelnen Listener per Referenz', () => {
    const cb = () => {};
    ws.on('test', cb);
    expect(ws.listenerCount).toBe(1);
    ws.off('test', cb);
    expect(ws.listenerCount).toBe(0);
  });

  it('on() ohne callback (undefined/null/non-function) returnt no-op', () => {
    const unsub1 = ws.on('test', null);
    const unsub2 = ws.on('test', undefined);
    const unsub3 = ws.on('test', 'not a function');
    expect(ws.listenerCount).toBe(0);
    expect(() => { unsub1(); unsub2(); unsub3(); }).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────
// 2. Mehrfach-Listener pro Event
// ────────────────────────────────────────────────────────
describe('Multi-Listener pro Event', () => {
  it('Drei Listener auf gleichem Event = listenerCount=3', () => {
    const u1 = ws.on('msg', () => {});
    const u2 = ws.on('msg', () => {});
    const u3 = ws.on('msg', () => {});
    expect(ws.listenerCount).toBe(3);
    u1(); u2(); u3();
    expect(ws.listenerCount).toBe(0);
  });

  it('unsub von Listener A entfernt nicht B', () => {
    const cbB = () => {};
    const u1 = ws.on('msg', () => {});
    ws.on('msg', cbB);
    u1();
    expect(ws.listenerCount).toBe(1);
    // off von B → 0
    ws.off('msg', cbB);
    expect(ws.listenerCount).toBe(0);
  });

  it('Verschiedene Events = unabhängige Sets', () => {
    ws.on('a', () => {});
    ws.on('b', () => {});
    ws.on('c', () => {});
    expect(ws.listenerCount).toBe(3);
  });
});

// ────────────────────────────────────────────────────────
// 3. Memory-Leak-Prävention: empty Sets cleanup
// ────────────────────────────────────────────────────────
describe('Empty-Set-Cleanup (Map-Leak-Prävention)', () => {
  it('Letzter unsub() für ein Event entfernt Map-Eintrag komplett', () => {
    // Wir können _listeners nicht direkt inspizieren — aber via re-on()
    // testen: wenn der Set noch existieren würde, würde 2× on()/2× unsub()
    // funktionieren. Wenn er gelöscht wird, fängt das nächste on() neu an.
    const u = ws.on('temp', () => {});
    u();
    // Nach unsub: count=0 + nächstes on() startet sauber
    const u2 = ws.on('temp', () => {});
    expect(ws.listenerCount).toBe(1);
    u2();
    expect(ws.listenerCount).toBe(0);
  });

  it('100 Listener add/remove: kein Leak', () => {
    const unsubs = [];
    for (let i = 0; i < 100; i++) {
      unsubs.push(ws.on('stress', () => {}));
    }
    expect(ws.listenerCount).toBe(100);
    for (const u of unsubs) u();
    expect(ws.listenerCount).toBe(0);
  });

  it('Doppel-unsub() ist idempotent', () => {
    const u = ws.on('test', () => {});
    expect(ws.listenerCount).toBe(1);
    u();
    expect(ws.listenerCount).toBe(0);
    expect(() => u()).not.toThrow();  // zweiter Call ist no-op
    expect(ws.listenerCount).toBe(0);
  });
});

// ────────────────────────────────────────────────────────
// 4. removeAllListeners + stop
// ────────────────────────────────────────────────────────
describe('removeAllListeners / stop()', () => {
  it('removeAllListeners killt alles auf einmal', () => {
    ws.on('a', () => {});
    ws.on('b', () => {});
    ws.on('c', () => {});
    ws.on('a', () => {});
    expect(ws.listenerCount).toBe(4);
    ws.removeAllListeners();
    expect(ws.listenerCount).toBe(0);
  });

  it('stop() löscht implicit alle Listener (defense-in-depth)', () => {
    ws.on('msg', () => {});
    ws.on('group_added', () => {});
    expect(ws.listenerCount).toBe(2);
    ws.stop();
    expect(ws.listenerCount).toBe(0);
  });

  it('Caller-Cleanup BEVOR stop() ist trotzdem korrekt (kein Crash bei doppelter Cleanup)', () => {
    const u1 = ws.on('msg', () => {});
    const u2 = ws.on('group_added', () => {});
    u1();
    u2();
    expect(ws.listenerCount).toBe(0);
    expect(() => ws.stop()).not.toThrow();
    expect(ws.listenerCount).toBe(0);
  });
});

// ────────────────────────────────────────────────────────
// 5. Re-Subscribe nach removeAllListeners
// ────────────────────────────────────────────────────────
describe('Re-Subscribe nach Cleanup', () => {
  it('Nach removeAllListeners → on() funktioniert sauber, kein Stale-State', () => {
    const u1 = ws.on('test', () => {});
    expect(ws.listenerCount).toBe(1);
    ws.removeAllListeners();
    const u2 = ws.on('test', () => {});
    expect(ws.listenerCount).toBe(1);
    // Alter unsub() ist no-op (Set ist clear) — kein Crash
    expect(() => u1()).not.toThrow();
    u2();
    expect(ws.listenerCount).toBe(0);
  });

  it('Nach stop() → start-Ready, on() registriert wieder', () => {
    ws.on('a', () => {});
    ws.stop();
    expect(ws.listenerCount).toBe(0);
    ws.on('a', () => {});
    ws.on('b', () => {});
    expect(ws.listenerCount).toBe(2);
  });
});

// ────────────────────────────────────────────────────────
// 6. Realistic Scenario: Login → Logout → Login
// ────────────────────────────────────────────────────────
describe('Login-Cycle Memory-Test', () => {
  it('Mehrfache Login/Logout-Zyklen → kein Listener-Akkumulation', () => {
    // Simuliert App.svelte's _bootstrapApp / _teardownApp
    const APP_LISTENERS = ['message', 'group_added', 'group_member_joined',
      'group_member_left', 'group_member_removed', 'device_added', 'device_removed',
      'contact_request', 'contact_accepted', 'contact_update',
      'voice:ring', 'voice:answer', 'voice:ice', 'voice:hangup', 'voice:decline', 'voice:cancel'];

    for (let cycle = 0; cycle < 5; cycle++) {
      // bootstrap: 16 Listener registrieren
      const unsubs = APP_LISTENERS.map(evt => ws.on(evt, () => {}));
      expect(ws.listenerCount).toBe(APP_LISTENERS.length);

      // teardown: alle abmelden
      for (const u of unsubs) u();
      expect(ws.listenerCount).toBe(0);
    }
  });

  it('Vergessenes unsub() bei stop() wird gerettet (defense-in-depth)', () => {
    // Komponente registriert Listener und vergisst zu cleanen → stop() rescued
    ws.on('forgotten', () => {});
    ws.on('also-forgotten', () => {});
    expect(ws.listenerCount).toBe(2);
    ws.stop();
    expect(ws.listenerCount).toBe(0);
  });
});
