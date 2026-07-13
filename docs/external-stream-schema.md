# External Data Stream — JSON Schema (v1)

FT8web pushes events to a local WebSocket as newline-delimited JSON text frames.
Every message shares a common envelope; the payload fields are merged at the top
level (no nested `payload` key).

## Envelope

```json
{
  "src": "FT8web",
  "ver": 1,
  "type": "<message type>",
  "utc": "2026-07-05T14:30:00.123Z",
  ...payload fields
}
```

| Field | Type | Description |
|-------|------|-------------|
| `src` | string | Always `"FT8web"`. Lets consumers multiplexing several sources tell them apart. |
| `ver` | number | Schema version. Currently `1`. Will increment on breaking changes. |
| `type` | string | `"decode"`, `"status"`, or `"qso_logged"`. |
| `utc` | string | ISO-8601 timestamp (millisecond precision, UTC) of when the message was sent. |

---

## Message types

### `decode`

Sent once per decode period, after all messages in that period have been
decoded. Not sent when the period produces zero decodes.

```json
{
  "src": "FT8web",
  "ver": 1,
  "type": "decode",
  "utc": "2026-07-05T14:30:00.123Z",
  "dialFreqHz": 14074000,
  "mode": "FT8",
  "decodes": [
    { "time": "143000", "snr": -10, "freq": 1234, "message": "CQ DX OK1CDJ JN79" },
    { "time": "143000", "snr":  -3, "freq":  890, "message": "W1AW OK1CDJ -07"   }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `dialFreqHz` | number | Transceiver dial (VFO) frequency in Hz. |
| `mode` | string | `"FT8"` or `"FT4"`. |
| `decodes` | array | All decoded messages in this T/R period. |
| `decodes[].time` | string | UTC time of the decode period as `HHMMSS`. |
| `decodes[].snr` | number | Signal-to-noise ratio in dB (typically −30 to +20). |
| `decodes[].freq` | number | Audio offset within the SSB passband in Hz (0–3000). |
| `decodes[].message` | string | Decoded text, e.g. `"CQ DX OK1CDJ JN79"`. |

---

### `status`

Sent whenever rig or operator state changes (VFO frequency, mode, callsign,
grid, TX settings, active target). Also replayed immediately on (re)connect so
a consumer that starts late receives the current state without waiting for the
next change.

```json
{
  "src": "FT8web",
  "ver": 1,
  "type": "status",
  "utc": "2026-07-05T14:30:01.456Z",
  "dialFreqHz": 14074000,
  "mode": "FT8",
  "myCall": "OK1CDJ",
  "myGrid": "JN79",
  "txFreqHz": 1500,
  "txEnabled": true,
  "transmitting": false,
  "dxCall": "W1AW"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `dialFreqHz` | number | Transceiver dial (VFO) frequency in Hz. |
| `mode` | string | `"FT8"` or `"FT4"`. |
| `myCall` | string | Operator callsign as entered in Settings. |
| `myGrid` | string | Operator Maidenhead grid locator (4 or 6 characters). |
| `txFreqHz` | number | TX audio offset within the SSB passband in Hz (0–3000). |
| `txEnabled` | boolean | Whether the TX enable button is active. |
| `transmitting` | boolean | `true` while audio is actively being transmitted. |
| `dxCall` | string | Callsign currently targeted by the FSM. Empty string when idle. |

---

### `qso_logged`

Sent once when the FSM completes a QSO and writes it to the logbook.

```json
{
  "src": "FT8web",
  "ver": 1,
  "type": "qso_logged",
  "utc": "2026-07-05T14:32:45.789Z",
  "call": "W1AW",
  "grid": "FN31",
  "rstSent": "-10",
  "rstRcvd": "-07",
  "dialFreqHz": 14074000,
  "mode": "FT8",
  "band": "20m"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `call` | string | DX station callsign. |
| `grid` | string | DX station Maidenhead grid locator. |
| `rstSent` | string | RST sent (FT8/FT4 signal reports are numeric dB strings, e.g. `"-10"`). |
| `rstRcvd` | string | RST received. |
| `dialFreqHz` | number | Transceiver dial (VFO) frequency in Hz at the time of logging. |
| `mode` | string | `"FT8"` or `"FT4"`. |
| `band` | string | Band designator, e.g. `"20m"`, `"40m"`. |

---

## Known limitations

- **`dt` (delta time) not available.** The WSJT-X Decode packet carries a sub-second timing offset (`dt`) for each decode. FT8web does not expose this value at the decode hook point, so the UDP bridge emits `0.0`. If `@e04/ft8ts` exposes `dt` in a future release it can be added to the `decodes[]` array without a schema version bump.
- **UDP bridge `rxFreq` mapped to `txFreqHz`.** The WSJT-X Status packet has separate RX DF and TX DF fields. FT8web's status message only carries `txFreqHz`; the bridge uses it for both. Tools that act on split RX/TX audio offsets will see the TX offset in both positions.
- **GridTracker / JTAlert Heartbeat handshake.** Some versions of these tools require a valid Heartbeat UDP datagram before they accept Status or Decode packets. The bridge sends Heartbeats every 15 s, but compatibility has not been verified against all versions — testers welcome.

## Versioning

The `ver` field will be incremented when a breaking change is made (field
removed or type changed). New optional fields may be added to an existing
version without a version bump. Consumers should ignore unknown fields.

## Python UDP bridge

For WSJT-X ecosystem tools that speak the binary UDP protocol, see
[`examples/udp-bridge/ft8web_udp_bridge.py`](../examples/udp-bridge/ft8web_udp_bridge.py).
It translates this JSON stream into WSJT-X Heartbeat, Status, Decode, and
QSO Logged UDP datagrams so tools like GridTracker and JTAlert work without
modification.
