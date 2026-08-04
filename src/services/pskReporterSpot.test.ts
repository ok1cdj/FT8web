import { describe, it, expect } from 'vitest';
import { parseReportableSpot } from './pskReporterSpot.ts';

describe('parseReportableSpot', () => {
  const reportable: [string, unknown][] = [
    ['CQ W1AW FN31', { senderCallsign: 'W1AW', senderLocator: 'FN31' }],
    ['CQ DX W1AW FN31', { senderCallsign: 'W1AW', senderLocator: 'FN31' }],
    ['K9XYZ W1AW FN31pr', { senderCallsign: 'W1AW', senderLocator: 'FN31pr' }],
    ['CQ 2E0AAA IO91', { senderCallsign: '2E0AAA', senderLocator: 'IO91' }],
    ['CQ OK1CDJ JO70', { senderCallsign: 'OK1CDJ', senderLocator: 'JO70' }],
    ['QRZ K1ABC FN42', { senderCallsign: 'K1ABC', senderLocator: 'FN42' }],
    ['<- CQ W1AW FN31', { senderCallsign: 'W1AW', senderLocator: 'FN31' }], // arrow stripped
  ];

  it.each(reportable)('reports "%s"', (message, expected) => {
    expect(parseReportableSpot(message)).toEqual(expected);
  });

  const notReportable: string[] = [
    'K9XYZ W1AW -12',       // signal report, no grid
    'K9XYZ W1AW RR73',      // RR73 is not a grid
    'K9XYZ W1AW 73',        // 73 closer
    'K9XYZ W1AW RRR',       // RRR closer
    'K9XYZ W1AW R-09',      // R + report
    'CQ <...> FN31',        // hashed/non-standard call
    '<PJ4/K1ABC> W1AW FN31', // hashed token present
    'CQ W1AW',              // no grid
    'W1AW',                 // single token
    '',                     // empty
    'CQ W1AW ZZ99',         // malformed grid (Z out of A-R)
  ];

  it.each(notReportable)('does not report "%s"', (message) => {
    expect(parseReportableSpot(message)).toBeNull();
  });
});
