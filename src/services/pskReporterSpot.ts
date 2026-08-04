/**
 * pskReporterSpot — pure, testable decode-message classification for spotting.
 *
 * PSKReporter (and WSJT-X's own upload rule) only wants decodes that carry a
 * transmitter callsign AND a Maidenhead grid: "I heard station X at grid G".
 * `parseReportableSpot` implements exactly that filter and extracts the
 * (sender callsign, sender grid) pair, or returns null when a message doesn't
 * qualify (signal reports, RR73/73/RRR, hashed/non-standard calls, etc.).
 *
 * This module also owns `extractTransmitterCallsign`, the shared callsign
 * normalization used by App.tsx, so both paths stay consistent.
 */

/** Valid 4- or 6-character Maidenhead locator. Note: RR73 also matches this
 *  shape, so callers must exclude it explicitly (it's a QSO closer, not a grid). */
const GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;

/** Standard amateur callsign, optional prefix/ and /suffix (e.g. W1AW, 2E0AAA,
 *  PJ4/K1ABC, K1ABC/P, OK1CDJ). Rejects grids, reports and other tokens. */
const CALL_RE = /^([A-Z0-9]{1,3}\/)?[A-Z0-9]{1,3}[0-9][A-Z]{0,3}(\/[A-Z0-9]{1,4})?$/i;

export interface ReportableSpot {
  senderCallsign: string;
  senderLocator: string;
}

/**
 * Extract the transmitter (sender) callsign from a decoded FT8/FT4 message.
 * For CQ/QRZ, this is the calling station; for a standard "TO FROM ..." QSO
 * message, it's the second token (the station we heard).
 */
export function extractTransmitterCallsign(message: string): string | null {
  if (!message) return null;
  // Strip any prepended arrow indicators like "<- " or "-> "
  const cleanMsg = message.replace(/^<-?\s+/, '').replace(/^->\s+/, '').trim();
  const parts = cleanMsg.split(/\s+/).map(p => p.replace(/[<>]/g, ''));

  if (parts.length === 0) return null;

  const first = parts[0].toUpperCase();
  if (first === 'CQ' || first === 'QRZ') {
    if (parts.length >= 3) {
      const hasDigit1 = /\d/.test(parts[1]);
      const hasDigit2 = /\d/.test(parts[2]);
      if (!hasDigit1 && hasDigit2) {
        return parts[2];
      }
    }
    if (parts.length >= 2) {
      return parts[1];
    }
    return null;
  }

  // For standard QSOs: ADDRESSEE TRANSMITTER [REPORT/MSG]
  // The transmitter whom we hear is the second token
  if (parts.length >= 2) {
    return parts[1];
  }

  return parts[0] || null;
}

/** True if a bare token is a valid Maidenhead grid (and not the RR73 closer). */
export function isValidGrid(token: string): boolean {
  return GRID_RE.test(token) && token.toUpperCase() !== 'RR73';
}

/** True if a bare token is a valid standard (non-hashed) callsign. */
export function isValidCallsign(token: string): boolean {
  return CALL_RE.test(token);
}

/**
 * Classify a decoded message for PSKReporter. Returns the spot to report
 * (sender callsign + grid), or null if the message isn't reportable.
 *
 * A message qualifies only when its LAST token is a valid grid and the
 * transmitter callsign is a real, non-hashed standard call — mirroring
 * WSJT-X's upload rule.
 */
export function parseReportableSpot(message: string): ReportableSpot | null {
  if (!message) return null;

  const cleanMsg = message.replace(/^<-?\s+/, '').replace(/^->\s+/, '').trim();
  const parts = cleanMsg.split(/\s+/);
  if (parts.length < 2) return null;

  // Reject any message containing a hashed/non-standard call, e.g. "<...>".
  if (parts.some(p => p.includes('<') || p.includes('>'))) return null;

  // The grid, if present, is always the last token.
  const senderLocator = parts[parts.length - 1];
  if (!isValidGrid(senderLocator)) return null;

  const senderCallsign = extractTransmitterCallsign(cleanMsg);
  if (!senderCallsign || !isValidCallsign(senderCallsign)) return null;

  return {
    senderCallsign: senderCallsign.toUpperCase(),
    senderLocator,
  };
}
