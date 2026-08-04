/**
 * Combination matrix for compound / standard callsign QSOs.
 *
 * Two FSMs (opposite TX slots) are wired together — each station's transmission is
 * fed to the other — to exercise a real bidirectional QSO for every combination of
 * {standard, compound} × {standard, compound} × {who initiates}. For each run we
 * assert the QSO completes on BOTH sides and that every transmitted string packs as
 * a genuine FT8 frame (round-trips through the real encoder/decoder), never garbled
 * free text.
 */
import { describe, it, expect } from 'vitest';
import { makeFSM, decoded, primedBook, isRealMessage, tokenKey, roundTrip } from './ft8-test-helpers.ts';

const STD_A = 'OK1CDJ';
const CMP_A = 'DL/OK1CDJ';
const STD_B = 'SV2FNT';
const CMP_B = 'OE/OK5XX';

const isCompound = (c: string) => c.includes('/');
const hasReport = (m: string) => /R?[+-]\d\d/.test(m);

/**
 * Run a full QSO between two stations on opposite slots. `aInitiates` decides who
 * calls CQ; the other answers when it hears the CQ (simulating the operator).
 * Returns both stations and the flat list of every transmitted message.
 */
function runQso(callA: string, callB: string, aInitiates: boolean) {
  const A = makeFSM({ myCall: callA, myGrid: 'JN88', myPeriod: 0, currentState: aInitiates ? 'CQ_SENDING' : 'IDLE' });
  const B = makeFSM({ myCall: callB, myGrid: 'JO70', myPeriod: 1, currentState: aInitiates ? 'IDLE' : 'CQ_SENDING' });
  const allTx: string[] = [];

  for (let p = 0; p < 16; p++) {
    const tx = p % 2 === 0 ? A : B;
    const rx = p % 2 === 0 ? B : A;
    const before = tx.txLog.length;
    tx.fsm.onPeriodStart(p);
    for (const m of tx.txLog.slice(before)) {
      allTx.push(m);
      if (rx.logged.length > 0) continue; // recipient already finished — stop feeding it
      rx.fsm.onPeriodDecodeReady([decoded(m)], p % 2);
      // Answer a heard CQ: nudge the idle station into the QSO, as the UI would.
      // The caller is the first token after CQ that carries a digit (skips CQ/DX/…).
      if (/^CQ\s/.test(m) && rx.fsm.currentState === 'IDLE') {
        const caller = m.replace(/^CQ\s+/, '').split(/\s+/).find((t) => /\d/.test(t) && !/^[A-R]{2}\d\d$/i.test(t));
        if (caller) {
          rx.fsm.currentState = 'REPLY_SENDING';
          rx.fsm.targetCall = caller.replace(/[<>]/g, '');
        }
      }
    }
    if (A.logged.length > 0 && B.logged.length > 0) break;
  }
  return { A, B, allTx };
}

describe('QSO completes for every combination with at least one standard call', () => {
  const combos: [string, string, string][] = [
    ['standard × standard', STD_A, STD_B],
    ['compound × standard', CMP_A, STD_B],
    ['standard × compound', STD_A, CMP_B],
  ];

  for (const [label, callA, callB] of combos) {
    for (const aInitiates of [true, false]) {
      const role = aInitiates ? 'A calls CQ' : 'B calls CQ';
      it(`${label} — ${role}`, () => {
        const { A, B, allTx } = runQso(callA, callB, aInitiates);

        // Both sides logged the other station.
        expect(A.logged.map((q) => q.call.replace(/[<>]/g, ''))).toContain(callB.replace(/[<>]/g, ''));
        expect(B.logged.map((q) => q.call.replace(/[<>]/g, ''))).toContain(callA.replace(/[<>]/g, ''));

        // Reports were actually exchanged (regression: compound QSOs must not skip them).
        expect(allTx.some(hasReport)).toBe(true);
        if (isCompound(callA) || isCompound(callB)) {
          // The report rides in a message that also carries a hashed compound call.
          expect(allTx.some((m) => m.includes('<') && hasReport(m))).toBe(true);
        }

        // Every transmitted string is a real, decodable frame — not free-text garbage.
        const book = primedBook([callA, callB]);
        for (const m of [...new Set(allTx)]) {
          expect(isRealMessage(m, book), `"${m}" should round-trip`).toBe(true);
        }
      });
    }
  }
});

describe('both-compound is unsupported (v1)', () => {
  it('does not complete and never emits a report frame', () => {
    const { A, B, allTx } = runQso(CMP_A, CMP_B, true);
    expect(A.logged).toHaveLength(0);
    expect(B.logged).toHaveLength(0);
    // Only CQs go out; no report/grid exchange is attempted.
    expect(allTx.every((m) => m.startsWith('CQ'))).toBe(true);
  });
});

describe('encodability table — compound call must be hashed, never sent in full mid-QSO', () => {
  const book = primedBook(['DL/OK1CDJ', 'SV2FNT']);
  const real = [
    'CQ DL/OK1CDJ',
    '<DL/OK1CDJ> SV2FNT -08',
    '<DL/OK1CDJ> SV2FNT R-08',
    'SV2FNT <DL/OK1CDJ> -08',
    'SV2FNT <DL/OK1CDJ> R-08',
    'SV2FNT <DL/OK1CDJ> RR73',
    '<DL/OK1CDJ> SV2FNT 73',
    '<DL/OK1CDJ> SV2FNT JO70',
    'SV2FNT <DL/OK1CDJ> JN88',
  ];
  it.each(real)('packs as a real frame: "%s"', (m) => {
    expect(isRealMessage(m, book)).toBe(true);
  });

  const garbled = [
    'SV2FNT DL/OK1CDJ -08',   // compound in full — cannot pack, becomes free text
    'SV2FNT DL/OK1CDJ R-08',
    'DL/OK1CDJ SV2FNT JO70',
  ];
  it.each(garbled)('falls back to free text: "%s"', (m) => {
    expect(tokenKey(roundTrip(m, book))).not.toBe(tokenKey(m));
  });
});
