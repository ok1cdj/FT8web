/**
 * Behavioural tests for compound / non-standard callsign QSO handling in FT8FSM.
 *
 * The key property: a QSO where ONE side is a compound call (e.g. DL/OK1CDJ) runs
 * the FULL report+grid handshake, with the compound call carried as its hash
 * `<DL/OK1CDJ>` in every message except the CQ. This is the regression from the
 * bug where the report exchange was skipped and the FSM jumped straight to RR73.
 *
 * Message layout is `ADDRESSEE SENDER [grid/report/closer]`, and renderCall() sends
 * a standard call in full and a compound call as its hash.
 */
import { describe, it, expect } from 'vitest';
import { makeFSM, decoded, primedBook, isRealMessage } from './ft8-test-helpers.ts';

describe('compound call — my call is compound, I call CQ (standard caller)', () => {
  it('sends a report to the caller, then closes (regression: no jump to RR73)', () => {
    const { fsm, txLog, logged } = makeFSM({ myCall: 'DL/OK1CDJ', currentState: 'CQ_SENDING' });

    fsm.onPeriodStart(0); // my slot -> CQ (full compound call, no grid)
    expect(txLog[0]).toBe('CQ DL/OK1CDJ');

    // SV2FNT answers our (resolved) hashed call with a signal report -08, as WSJT-X does.
    fsm.onPeriodDecodeReady([decoded('<DL/OK1CDJ> SV2FNT -08')], 1);
    expect(fsm.targetCall).toBe('SV2FNT');
    // Caller already sent a report -> we go to R-report, not to closure.
    expect(fsm.currentState).toBe('SENDING_R_REPORT');

    fsm.onPeriodStart(2); // -> R-report: the report the old code never sent
    expect(txLog[1]).toBe('SV2FNT <DL/OK1CDJ> R-08');

    // Their closer is addressed to an UNRESOLVED hash of our call — must still match
    // because the sender is our in-progress target.
    fsm.onPeriodDecodeReady([decoded('<...> SV2FNT RR73')], 3);
    expect(fsm.currentState).toBe('SENDING_73');

    fsm.onPeriodStart(4); // -> 73, QSO complete
    expect(txLog[2]).toBe('SV2FNT <DL/OK1CDJ> 73');
    expect(logged).toHaveLength(1);
    expect(logged[0].call).toBe('SV2FNT');
    expect(logged[0].rst_rcvd).toBe('-08');
  });
});

describe('compound call — my call is standard, I answer a compound station', () => {
  it('exchanges grid then report with the compound target hashed', () => {
    const { fsm, txLog, logged } = makeFSM({
      myCall: 'W1AW', currentState: 'REPLY_SENDING', targetCall: 'DL/OK1CDJ',
    });

    fsm.onPeriodStart(0); // TX1 grid; target (compound) hashed, my call in full
    expect(txLog[0]).toBe('<DL/OK1CDJ> W1AW JN88');

    fsm.onPeriodDecodeReady([decoded('W1AW <DL/OK1CDJ> -05', -5)], 1);
    expect(fsm.currentState).toBe('SENDING_R_REPORT');
    expect(fsm.myReceivedReport).toBe('-05');

    fsm.onPeriodStart(2);
    expect(txLog[1]).toBe('<DL/OK1CDJ> W1AW R-05');

    fsm.onPeriodDecodeReady([decoded('W1AW <DL/OK1CDJ> RR73')], 3);
    fsm.onPeriodStart(4);
    expect(txLog[2]).toBe('<DL/OK1CDJ> W1AW 73');
    expect(logged).toHaveLength(1);
    expect(logged[0].call).toBe('DL/OK1CDJ');
  });
});

describe('receive matching is whole-token, not substring', () => {
  it('does not treat a superstring or a grid as our callsign', () => {
    const { fsm } = makeFSM({ myCall: 'OK1CDJ', currentState: 'CQ_SENDING' });
    // OK1CDJX contains "OK1CDJ" as a substring but is a different station.
    fsm.onPeriodDecodeReady([decoded('OK1CDJX SV2FNT JO70')], 1);
    expect(fsm.currentState).toBe('CQ_SENDING'); // not engaged
    expect(fsm.targetCall).toBeNull();
  });
});

describe('both-compound is out of scope (v1): skip rather than transmit garbage', () => {
  it('does not transmit when both calls are non-standard', () => {
    const { fsm, txLog } = makeFSM({
      myCall: 'DL/OK1CDJ', currentState: 'SENDING_REPORT', targetCall: 'OE/OK5XX',
    });
    fsm.onPeriodStart(0);
    expect(txLog).toHaveLength(0);
    expect(fsm.currentState).toBe('IDLE');
  });
});

describe('every generated string packs as a real message (not free text)', () => {
  const book = primedBook(['DL/OK1CDJ', 'W1AW', 'SV2FNT']);
  const generated = [
    'CQ DL/OK1CDJ',
    'SV2FNT <DL/OK1CDJ> R-08',
    'SV2FNT <DL/OK1CDJ> 73',
    '<DL/OK1CDJ> W1AW JN88',
    '<DL/OK1CDJ> W1AW R-05',
  ];
  it.each(generated)('round-trips "%s"', (msg) => {
    expect(isRealMessage(msg, book)).toBe(true);
  });
});
