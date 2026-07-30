/**
 * PSKReporterService — opt-in reception-report uploader for the PSKReporter
 * spotting network.
 *
 * PSKReporter needs a persistent UDP/IPFIX session, which a serverless PWA
 * can't hold, so a companion relay daemon (`psk-relay`) owns all the hard parts
 * (per-operator batching, the 5-minute rate limit, IPFIX encoding, template
 * retransmission). This service's only job is: watch the decode stream,
 * filter → shape → fire-and-forget POST to the relay.
 *
 * Design constraints (mirror ExternalStreamService):
 * - Off by default; enabled in Settings.
 * - Fire-and-forget: never throws into app code, never blocks decode/TX,
 *   silently drops on failure.
 * - A single module-level singleton, `configure(enabled)` on settings change.
 * - Sends ONE POST per decode cycle carrying { reports: [...] } so the per-IP
 *   request rate stays ~4/min even during a band opening.
 */

import type { FT8DecodedMessage } from '../App';
import { parseReportableSpot, isValidGrid } from './pskReporterSpot';

const RELAY_URL =
  import.meta.env.VITE_PSK_RELAY_URL ?? 'https://pskreporter.ok1cdj.com/report';

/** Placeholder identity shipped as the default — must never be reported. */
const PLACEHOLDER_CALL = 'N0TMP';

interface RelayReport {
  reporterCallsign: string;
  reporterLocator: string;
  senderCallsign: string;
  senderLocator: string;
  frequencyHz: number;
  mode: string;   // 'FT8' | 'FT4'
  snr: number;
  timestamp: number; // epoch seconds
}

/** Guard: only upload with a real operator identity, never the default. */
function isValidReporter(myCall: string, myGrid: string): boolean {
  if (!myCall) return false;
  if (myCall.toUpperCase() === PLACEHOLDER_CALL) return false;
  return isValidGrid(myGrid);
}

class PSKReporterService {
  private enabled = false;
  private spotsSent = 0;

  /** UI hook for a "spots sent this session" counter in Settings. */
  public onReport: (spotsSent: number) => void = () => {};

  /** True if the current operator identity is allowed to report. */
  static canReport(myCall: string, myGrid: string): boolean {
    return isValidReporter(myCall, myGrid);
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
  }

  reportDecodes(
    payload: FT8DecodedMessage[],
    dialFreqHz: number,
    mode: string,
    op: { myCall: string; myGrid: string },
  ): void {
    if (!this.enabled) return;
    if (!isValidReporter(op.myCall, op.myGrid)) return; // guard bad/default identity

    const nowSec = Math.floor(Date.now() / 1000);
    const reports: RelayReport[] = [];
    for (const msg of payload) {
      if (msg.isDivider || msg.isTx) continue;          // skip UI rows & our own TX
      const spot = parseReportableSpot(msg.message);
      if (!spot) continue;
      reports.push({
        reporterCallsign: op.myCall.toUpperCase(),
        reporterLocator: op.myGrid,
        senderCallsign: spot.senderCallsign,
        senderLocator: spot.senderLocator,
        frequencyHz: dialFreqHz + msg.freq,             // absolute Hz
        mode,
        snr: msg.snr,
        timestamp: nowSec,
      });
    }
    if (reports.length === 0) return;
    this.post(reports); // fire-and-forget
    this.spotsSent += reports.length;
    this.onReport(this.spotsSent);
  }

  private post(reports: RelayReport[]): void {
    // ONE request per decode cycle carrying all qualifying spots.
    void fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reports }),
      keepalive: true,      // survive a tab/period transition
    }).catch(() => { /* never propagate into decode path */ });
  }
}

export const pskReporter = new PSKReporterService();
export { PSKReporterService };
