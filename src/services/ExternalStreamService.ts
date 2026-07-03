/**
 * ExternalStreamService — one-way JSON event stream over a local WebSocket.
 *
 * Lets desktop companion tools (loggers, propagation analyzers, band-activity
 * maps — e.g. GridTracker, QSO Predictor, JTAlert via a small UDP bridge)
 * consume FT8web's decodes, rig status and logged QSOs, the same way those
 * tools consume the WSJT-X UDP protocol today.
 *
 * Browsers cannot send UDP, so the app pushes JSON to a WebSocket endpoint
 * on localhost instead; a consumer either speaks this schema natively or a
 * tiny bridge re-emits WSJT-X-format UDP datagrams (see examples/udp-bridge).
 * Pages served over https are allowed to open ws:// connections to localhost
 * (exempt from mixed-content blocking), so this works from the hosted app.
 *
 * Design constraints:
 * - Off by default; enabled + endpoint URL configured in Settings.
 * - Strictly one-way (nothing received on the socket is acted upon).
 * - Fire-and-forget: never throws into app code, never blocks decode/TX
 *   paths, silently drops messages while disconnected.
 * - Reconnects with exponential backoff; replays the latest status snapshot
 *   on reconnect so a consumer starting late gets current rig state.
 *
 * Message envelope (schema v1):
 *   { "src": "FT8web", "ver": 1, "type": "decode" | "status" | "qso_logged",
 *     "utc": "<ISO-8601>", ...payload }
 */

export interface StreamDecode {
  /** HHMMSS UTC of the decode period */
  time: string;
  snr: number;
  /** audio offset within the passband, Hz */
  freq: number;
  message: string;
}

export interface StreamStatus {
  dialFreqHz: number;
  mode: string;
  myCall: string;
  myGrid: string;
  /** TX audio offset within the passband, Hz */
  txFreqHz: number;
  txEnabled: boolean;
  transmitting: boolean;
  /** callsign currently targeted by the FSM, '' if none */
  dxCall: string;
}

export interface StreamQsoLogged {
  call: string;
  grid: string;
  rstSent: string;
  rstRcvd: string;
  dialFreqHz: number;
  mode: string;
  band: string;
}

const SCHEMA_VERSION = 1;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class ExternalStreamService {
  private ws: WebSocket | null = null;
  private enabled = false;
  private url = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private lastStatus: StreamStatus | null = null;

  /** UI hook for a connected/disconnected indicator in Settings. */
  public onStateChange: (connected: boolean) => void = () => {};

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Called whenever the settings change; tears down / (re)connects as needed. */
  configure(enabled: boolean, url: string): void {
    if (enabled === this.enabled && url === this.url) return;
    this.enabled = enabled;
    this.url = url;
    this.teardown();
    if (this.enabled && this.url) {
      this.backoffMs = RECONNECT_MIN_MS;
      this.connect();
    }
  }

  sendDecodes(decodes: StreamDecode[], dialFreqHz: number, mode: string): void {
    if (decodes.length === 0) return;
    this.send('decode', {
      dialFreqHz,
      mode,
      decodes: decodes.map(d => ({
        time: d.time, snr: d.snr, freq: d.freq, message: d.message,
      })),
    });
  }

  sendStatus(status: StreamStatus): void {
    this.lastStatus = status;
    this.send('status', status);
  }

  sendQsoLogged(qso: StreamQsoLogged): void {
    this.send('qso_logged', qso);
  }

  private connect(): void {
    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        if (ws !== this.ws) return; // superseded by a reconfigure
        this.backoffMs = RECONNECT_MIN_MS;
        this.onStateChange(true);
        // Late-starting consumers get current rig state immediately.
        if (this.lastStatus) this.send('status', this.lastStatus);
      };
      ws.onclose = () => {
        if (ws !== this.ws) return;
        this.ws = null;
        this.onStateChange(false);
        this.scheduleReconnect();
      };
      ws.onerror = () => { /* onclose follows; nothing to do */ };
      // One-way stream: ignore anything the consumer sends back.
      ws.onmessage = () => {};
    } catch {
      this.ws = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.enabled) this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(); } catch { /* already closed */ }
      this.onStateChange(false);
    }
  }

  private send(type: string, payload: object): void {
    if (!this.connected || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({
        src: 'FT8web',
        ver: SCHEMA_VERSION,
        type,
        utc: new Date().toISOString(),
        ...payload,
      }));
    } catch {
      /* never propagate into decode/TX paths */
    }
  }
}

export const externalStream = new ExternalStreamService();
