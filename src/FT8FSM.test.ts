/**
 * Standalone test for compound / non-standard callsign QSO handling in FT8FSM.
 * No test framework. Run with:  npx tsx src/FT8FSM.test.ts
 * Exits non-zero on any failure.
 *
 * Two things are verified:
 *  1. The FSM drives a complete QSO (CQ -> contact -> RR73/73 -> logged) when one
 *     side is a compound call, using the degraded no-report handshake.
 *  2. Every TX string the FSM produces actually packs as a real FT8 message
 *     (Type 4) rather than silently falling back to garbled 13-char free text —
 *     proved by an encode -> decode round-trip through @e04/ft8ts.
 */

import { encodeFT8, decodeFT8, HashCallBook } from '@e04/ft8ts';
import FT8FSM from './FT8FSM.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Normalize a message to a comparable token set (brackets stripped, upper). */
function tokenKey(msg: string): string {
  return msg.trim().replace(/[<>]/g, '').toUpperCase().split(/\s+/).sort().join(' ');
}

/** Encode a message and decode it back; returns the decoded text or ''. */
function roundTrip(msg: string, book: HashCallBook): string {
  const samples = encodeFT8(msg, { sampleRate: 12000, baseFrequency: 1500 });
  const results = decodeFT8(samples, {
    sampleRate: 12000,
    hashCallBook: book,
    freqLow: 200,
    freqHigh: 3000,
  });
  if (!results || results.length === 0) return '';
  // Pick the decode closest to our injected 1500 Hz tone.
  results.sort((a: any, b: any) => Math.abs(a.freq - 1500) - Math.abs(b.freq - 1500));
  return results[0].msg;
}

function makeFSM(overrides: Record<string, unknown>) {
  const txLog: string[] = [];
  const logged: any[] = [];
  const fsm = new FT8FSM({
    myGrid: 'JN88',
    myPeriod: 0,
    finalMessageMode: 'RR73',
    isTxEnabled: true,
    ...overrides,
  });
  fsm.onTransmit = (m) => txLog.push(m);
  fsm.onLogQSO = (q) => logged.push(q);
  return { fsm, txLog, logged };
}

// ---------------------------------------------------------------------------
// Scenario A: my call is compound; I call CQ and a standard station answers.
// ---------------------------------------------------------------------------
{
  const { fsm, txLog, logged } = makeFSM({ myCall: 'OE/OK1CDJ', currentState: 'CQ_SENDING' });

  fsm.onPeriodStart(0); // my slot -> CQ
  ok('A: CQ has no grid (Type-4 CQ)', txLog[0] === 'CQ OE/OK1CDJ', `got "${txLog[0]}"`);

  // W1AW answers our non-standard CQ (their TX carries our full call + their hash).
  fsm.onPeriodDecodeReady([{ time: '', snr: -5, freq: 1500, message: 'OE/OK1CDJ <W1AW>' }], 1);
  ok('A: picked up caller', fsm.targetCall === 'W1AW', `target=${fsm.targetCall}`);
  ok('A: jumped straight to closure', fsm.currentState === 'SENDING_RR73', `state=${fsm.currentState}`);

  fsm.onPeriodStart(2); // my slot -> RR73 (standard call wrapped in <...>)
  ok('A: RR73 wraps standard call, sends compound in full',
    txLog[1] === '<W1AW> OE/OK1CDJ RR73', `got "${txLog[1]}"`);
  ok('A: QSO logged', logged.length === 1 && logged[0].call === 'W1AW',
    JSON.stringify(logged));
}

// ---------------------------------------------------------------------------
// Scenario B: my call is standard; I answer a compound station's CQ.
// ---------------------------------------------------------------------------
{
  const { fsm, txLog, logged } = makeFSM({
    myCall: 'W1AW', currentState: 'REPLY_SENDING', targetCall: 'OE/OK1CDJ',
  });

  fsm.onPeriodStart(0); // bare contact, no grid/report
  ok('B: contact wraps my standard call', txLog[0] === 'OE/OK1CDJ <W1AW>', `got "${txLog[0]}"`);

  // Their reply is addressed to an UNRESOLVED hash of our call — must still match.
  fsm.onPeriodDecodeReady([{ time: '', snr: -3, freq: 1500, message: '<...> OE/OK1CDJ RR73' }], 1);
  ok('B: matched via unresolved hash', fsm.currentState === 'SENDING_73', `state=${fsm.currentState}`);

  fsm.onPeriodStart(2); // -> 73
  ok('B: sends 73', txLog[1] === 'OE/OK1CDJ <W1AW> 73', `got "${txLog[1]}"`);
  ok('B: QSO logged with compound call', logged.length === 1 && logged[0].call === 'OE/OK1CDJ',
    JSON.stringify(logged));
}

// ---------------------------------------------------------------------------
// Encodability: every generated string round-trips as a real message.
// ---------------------------------------------------------------------------
{
  const book = new HashCallBook();
  book.save('W1AW');
  book.save('OE/OK1CDJ');

  const encodable = [
    'CQ OE/OK1CDJ',
    '<W1AW> OE/OK1CDJ RR73',
    'OE/OK1CDJ <W1AW>',
    'OE/OK1CDJ <W1AW> 73',
  ];
  for (const msg of encodable) {
    const decoded = roundTrip(msg, book);
    ok(`encode/decode round-trips: "${msg}"`, tokenKey(decoded) === tokenKey(msg),
      `decoded "${decoded}"`);
  }

  // Control: the OLD (buggy) form with a report cannot pack with a compound call,
  // so it falls back to free text and does NOT round-trip — this is the bug.
  const buggy = 'W1AW OE/OK1CDJ R-12';
  const decodedBuggy = roundTrip(buggy, book);
  ok('control: report-bearing compound message does NOT round-trip (proves fallback)',
    tokenKey(decodedBuggy) !== tokenKey(buggy), `decoded "${decodedBuggy}"`);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
