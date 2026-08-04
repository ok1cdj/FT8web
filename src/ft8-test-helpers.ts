/**
 * Shared helpers for the FT8FSM test suites. Not a test file itself (does not
 * match the `*.test.ts` glob), so vitest does not run it directly.
 */
import { encodeFT8, decodeFT8, HashCallBook } from '@e04/ft8ts';
import FT8FSM, { type FT8DecodedMessage } from './FT8FSM.ts';

/** A HashCallBook pre-seeded with the given callsigns. */
export function primedBook(calls: string[]): HashCallBook {
  const book = new HashCallBook();
  for (const c of calls) book.save(c);
  return book;
}

/** Normalize a message to a comparable token set (brackets stripped, upper, sorted). */
export function tokenKey(msg: string): string {
  return msg.trim().replace(/[<>]/g, '').toUpperCase().split(/\s+/).sort().join(' ');
}

/**
 * Encode a message and decode it back through the real FT8 codec. Returns the
 * decoded text, or '' if nothing decoded. A message that packs as a genuine
 * Type-1/Type-4 frame round-trips; one that falls back to free text is truncated
 * to 13 chars and will not match the input token set.
 */
export function roundTrip(msg: string, book: HashCallBook): string {
  const samples = encodeFT8(msg, { sampleRate: 12000, baseFrequency: 1500 });
  const results = decodeFT8(samples, {
    sampleRate: 12000,
    hashCallBook: book,
    freqLow: 200,
    freqHigh: 3000,
  });
  if (!results || results.length === 0) return '';
  results.sort((a: any, b: any) => Math.abs(a.freq - 1500) - Math.abs(b.freq - 1500));
  return results[0].msg;
}

/** True when `msg` packs as a real message (round-trips), not garbled free text. */
export function isRealMessage(msg: string, book: HashCallBook): boolean {
  return tokenKey(roundTrip(msg, book)) === tokenKey(msg);
}

/** Build a decoded-message object for feeding onPeriodDecodeReady. */
export function decoded(message: string, snr = -8, freq = 1500): FT8DecodedMessage {
  return { time: '', snr, freq, message };
}

/** Create an FSM with capture arrays for transmitted messages and logged QSOs. */
export function makeFSM(overrides: Record<string, unknown>) {
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
