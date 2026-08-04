/**
 * End-to-end QSO tests over a SIMULATED REAL CHANNEL.
 *
 * Unlike FT8FSM.combinations.test.ts (which passes resolved text straight between
 * the two FSMs), here every transmission is actually encoded and then decoded with
 * the RECEIVER's own HashCallBook, which starts knowing only its own call and
 * learns others over time — exactly as a real station does. This exposes the case
 * a compound station must seed its full call before using its hash: a premature
 * hashed reference decodes as "<...>" and the QSO stalls.
 */
import { describe, it, expect } from 'vitest';
import { makeFSM, decoded, primedBook, roundTrip } from './ft8-test-helpers.ts';

function runRealQso(callA: string, callB: string, aInitiates: boolean) {
  const A = makeFSM({ myCall: callA, myGrid: 'JN88', myPeriod: 0, currentState: aInitiates ? 'CQ_SENDING' : 'IDLE' });
  const B = makeFSM({ myCall: callB, myGrid: 'JO21', myPeriod: 1, currentState: aInitiates ? 'IDLE' : 'CQ_SENDING' });
  // Each decoder knows only its own call at first (as the app primes it), and
  // learns other calls as it decodes them.
  const bookA = primedBook([callA]);
  const bookB = primedBook([callB]);
  const decodes: string[] = []; // everything each station actually decoded

  for (let p = 0; p < 18; p++) {
    const tx = p % 2 === 0 ? A : B;
    const rx = p % 2 === 0 ? B : A;
    const rxBook = p % 2 === 0 ? bookB : bookA;
    const before = tx.txLog.length;
    tx.fsm.onPeriodStart(p);
    for (const m of tx.txLog.slice(before)) {
      if (rx.logged.length > 0) continue;
      const heard = roundTrip(m, rxBook); // encode -> decode through the receiver's learning book
      decodes.push(heard);
      rx.fsm.onPeriodDecodeReady([decoded(heard)], p % 2);
      if (/^CQ\s/.test(heard) && rx.fsm.currentState === 'IDLE') {
        const caller = heard.replace(/^CQ\s+/, '').split(/\s+/).find((t) => /\d/.test(t) && !/^[A-R]{2}\d\d$/i.test(t));
        if (caller) {
          rx.fsm.currentState = 'REPLY_SENDING';
          rx.fsm.targetCall = caller.replace(/[<>]/g, '');
        }
      }
    }
    if (A.logged.length > 0 && B.logged.length > 0) break;
  }
  return { A, B, decodes };
}

const strip = (c: string) => c.replace(/[<>]/g, '');

describe('QSO over a real (encode/decode) channel with hash learning', () => {
  const combos: [string, string, string][] = [
    ['compound answers a standard CQ', 'DL/OK1CDJ', 'SV2FNT'], // A compound, B standard
    ['standard answers a compound CQ', 'OK1CDJ', 'OE/OK5XX'],  // A standard, B compound
  ];

  for (const [label, callA, callB] of combos) {
    for (const aInitiates of [true, false]) {
      it(`${label} — ${aInitiates ? 'A' : 'B'} calls CQ`, () => {
        const { A, B, decodes } = runRealQso(callA, callB, aInitiates);

        // Both sides complete the QSO — impossible if the caller decoded as "<...>".
        expect(A.logged.map((q) => strip(q.call))).toContain(strip(callB));
        expect(B.logged.map((q) => strip(q.call))).toContain(strip(callA));

        // A compound call must have been seeded in full before any hashed reference,
        // so no station ever decodes an unresolvable "<...>".
        expect(decodes.some((d) => d.includes('<...>'))).toBe(false);
      });
    }
  }
});
