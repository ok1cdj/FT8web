/**
 * Lightweight standalone test for parseReportableSpot — no test framework.
 * Run with:  npx tsx src/services/pskReporterSpot.test.ts
 * Exits non-zero on any failure.
 */

import { parseReportableSpot } from './pskReporterSpot.ts';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function check(message: string, expected: unknown): void {
  const got = parseReportableSpot(message);
  if (eq(got, expected)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: "${message}"`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  got:      ${JSON.stringify(got)}`);
  }
}

// --- Reportable: standard messages carrying a grid --------------------------
check('CQ W1AW FN31', { senderCallsign: 'W1AW', senderLocator: 'FN31' });
check('CQ DX W1AW FN31', { senderCallsign: 'W1AW', senderLocator: 'FN31' });
check('K9XYZ W1AW FN31pr', { senderCallsign: 'W1AW', senderLocator: 'FN31pr' });
check('CQ 2E0AAA IO91', { senderCallsign: '2E0AAA', senderLocator: 'IO91' });
check('CQ OK1CDJ JO70', { senderCallsign: 'OK1CDJ', senderLocator: 'JO70' });
check('QRZ K1ABC FN42', { senderCallsign: 'K1ABC', senderLocator: 'FN42' });
// Arrow indicators stripped
check('<- CQ W1AW FN31', { senderCallsign: 'W1AW', senderLocator: 'FN31' });

// --- NOT reportable ---------------------------------------------------------
check('K9XYZ W1AW -12', null);       // signal report, no grid
check('K9XYZ W1AW RR73', null);      // RR73 is not a grid
check('K9XYZ W1AW 73', null);        // 73 closer
check('K9XYZ W1AW RRR', null);       // RRR closer
check('K9XYZ W1AW R-09', null);      // R + report
check('CQ <...> FN31', null);        // hashed/non-standard call
check('<PJ4/K1ABC> W1AW FN31', null); // hashed token present
check('CQ W1AW', null);              // no grid
check('W1AW', null);                 // single token
check('', null);                     // empty
check('CQ W1AW ZZ99', null);         // malformed grid (Z out of A-R)

// --- Summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
