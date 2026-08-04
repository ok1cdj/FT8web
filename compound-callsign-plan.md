# Compound / non-standard callsign support — design note

> **Correction (superseded below):** The first implementation assumed a compound
> QSO is degraded and cannot exchange signal reports (Type 4 only). That is
> **wrong**. When exactly one call is non-standard, reports and grids ARE
> exchanged by carrying the compound call as its **hash `<DL/OK1CDJ>`** inside a
> normal **Type 1** message; the full compound call travels only in the `CQ`
> (Type 4), which seeds the hash on all receivers. The FSM now renders any
> compound call as its hash in every non-CQ message (`renderCall()` in
> `src/FT8FSM.ts`) and runs the full report handshake. Only QSOs where BOTH calls
> are non-standard remain unsupported (v1). See the follow-up plan
> `~/.claude/plans/we-have-still-problems-floating-lemur.md`. The sections below
> describe the original (partly superseded) analysis.

## Problem

QSOs cannot be completed when the user's callsign (or the target's) is a
compound / non-standard call such as `OE/OK1CDJ`, `PJ4/K1ABC`, or a base call
with an add-on prefix. The sequence stalls during the report exchange.

### Root cause

The FSM builds standard-format messages (with a 4-char grid and numeric signal
reports) and assumes every call can be packed as a standard Type-1 call. That
assumption breaks for non-standard calls at the **encoder**, not in the app
logic:

- `pack_jt77.ts` `tryPackType1()` requires *both* calls to be standard
  (`parseCallsign().isStandard`). `OE/OK1CDJ` fails (area-digit position > 2),
  so Type 1 returns `null`.
- `tryPackType4()` — the message type that *does* support non-standard calls —
  can only carry `CQ`, `RRR`, `RR73`, `73`, or nothing (`decodeRpt`,
  `pack_jt77.ts:527`). **It cannot carry a grid or a numeric signal report.**
  It also only matches if the message is `CQ <call>`, `<HASH> CALL`, or
  `CALL <HASH>` — i.e. one call must be explicitly wrapped in `<...>`.
- When both fail, `pack77` silently falls back to 13-char **free text**, which
  the far end decodes as gibberish rather than a QSO exchange.

What the FSM currently emits with `myCall = OE/OK1CDJ`:

| State | FSM builds (`FT8FSM.ts`) | Result |
|-------|--------------------------|--------|
| `CQ_SENDING` (:156) | `CQ OE/OK1CDJ JO70` | grid present → free text, truncated |
| `REPLY_SENDING` (:163/167) | `OK1ABC OE/OK1CDJ -12` | numeric report, no `<...>` → free text |
| `SENDING_REPORT` (:172) | `OK1ABC OE/OK1CDJ -12` | free text |
| `SENDING_R_REPORT` (:177) | `OK1ABC OE/OK1CDJ R-12` | free text |
| `SENDING_RR73` (:183) | `OK1ABC OE/OK1CDJ RR73` | *could* be Type 4 but no `<...>` → free text |

The only compound-aware code today is `isNonStandardCompound()`
(`FT8FSM.ts:84`), used once to drop the grid on TX1 — it still sends a numeric
report and never adds brackets, so the message is still unencodable.

### Secondary issue — receive matching

Incoming matching uses substring (`line.includes(this.myCall)`, `:249`) and
exact string equality after stripping brackets (`addressee === this.myCall`,
`:267`). If the far end's decoder hasn't yet learned our hash, the decode shows
`<...>` and the match fails. Substring matching is also fragile (`OK1CDJ`
matches inside `OK1CDJX`).

## Background — how WSJT-X actually runs a non-standard-call QSO

FT8 exchanges non-standard calls via hashing. One call rides in the 58-bit
field in full; the *other* is sent as a 12/22-bit hash (shown as `<CALL>` once
learned, `<...>` until then). Because Type 4 has no room for grid/report, the
exchange is **degraded**:

1. `CQ OE/OK1CDJ`  (no grid)
2. `<OK1CDJ_caller> OE/OK1CDJ`  or  `OE/OK1CDJ <caller>` — no report
3. Signal reports are exchanged **only when at least one side is standard**; with
   two non-standard calls the reports are effectively skipped and the QSO
   completes on `RR73` / `73`.

Key constraint to encode into the FSM: **when a non-standard call is involved,
the message may carry only `CQ` / `RRR` / `RR73` / `73`, and the standard call
in the pair must be wrapped in `<...>`.**

## Proposed changes

### 1. Central helper: classify a call
Add to `FT8FSM.ts` (replacing the ad-hoc `isNonStandardCompound`):

```ts
// standard = packable in Type 1 (mirror parseCallsign's isStandard rule)
private isStandardCall(call: string): boolean
private isCompound(call: string): boolean   // has '/' that isn't /P or /R? -> nonstandard
```

Prefer to reuse the library's `parseCallsign` if it is exported from
`@e04/ft8ts`; otherwise mirror its rule (area-digit position 1–2). This keeps
"is it standard" in one place and consistent with the encoder.

### 2. Message generation — make every TX string encodable
In `onPeriodStart` (`FT8FSM.ts:152-190`), branch on whether the QSO involves a
non-standard call. Let `nonStd = !isStandardCall(myCall) || !isStandardCall(targetCall)`.

- **CQ** (`:156`): if `!isStandardCall(myCall)` → `CQ ${myCall}` (drop grid).
- **Reply / report states**: if `nonStd`, wrap the standard call of the pair in
  `<...>` and drop grid + numeric report. The exchange collapses to:
  - `REPLY_SENDING`/`SENDING_REPORT` → send `<std> nonstd` (bare, no report) to
    establish contact, then advance directly toward closure.
  - `SENDING_RR73` / `SENDING_RRR` / `SENDING_73` → `<std> nonstd RR73|RRR|73`.
  - Whichever call is the standard one gets the brackets; if *both* are
    non-standard, one still must be bracketed (encoder hashes the bracketed one)
    — pick the target as bracketed by convention.
- Guard: after building `txString` for a non-standard QSO, if it still contains
  a grid or numeric report token, strip it. Optionally call `pack77` (or a thin
  `canEncode(msg)` wrapper) and log/skip if it would fall back to free text,
  rather than transmitting garbage.

Because reports can't be sent, the report-bearing states
(`SENDING_REPORT`/`SENDING_R_REPORT`) should, for non-standard QSOs, transition
straight to the closure states after the initial contact rather than looping on
a report they can never deliver.

### 3. Receive matching — hash-aware and boundary-safe
In `onPeriodDecodeReady`:

- Replace substring `involvesMe`/`involvesTarget` (`:249-250`) with
  whole-token matching (split, compare tokens with brackets stripped).
- Make the address/sender comparison (`:267-268`) hash-aware: treat a decoded
  `<...>` (unresolved) addressed in our current QSO slot as "for me" when we are
  mid-QSO with a non-standard target, and match `OE/OK1CDJ` against both the raw
  token and the bracket-stripped token. A small `callsMatch(a, b)` helper that
  normalizes brackets/case and compares.

### 4. HashCallBook persistence (quality-of-life, optional but recommended)
`ft8-worker.ts:4` creates a fresh `HashCallBook` per session; learned hashes are
lost on reload, so a just-started session shows `<...>` until the far end
re-primes the hash. Persist the book to `localStorage`/IndexedDB and reload it
on worker start so compound calls resolve immediately. Not required for the core
fix but greatly improves reliability.

### 5. Callsign input validation (minor)
`App.tsx:2211` only uppercases `myCall`. Add light validation (reuse `CALL_RE`
from `services/pskReporterSpot.ts:20`, which already matches compound calls) to
warn on obviously invalid input. Cosmetic; not on the critical path.

## Files touched

- `src/FT8FSM.ts` — call classification, TX generation branch, hash-aware match. (core)
- `src/ft8-worker.ts` — persist/restore `HashCallBook`. (optional)
- `src/App.tsx` — mirror match logic in `incomingQsoMessages` filter
  (:1005-1024); optional callsign validation. (secondary)
- Tests — see below.

## Testing

- Unit-test the new `canEncode` / TX-string builder against the `@e04/ft8ts`
  packer: assert that every generated string for a compound-call QSO packs as
  Type 4 (not free text). Reuse the pattern in `services/pskReporterSpot`'s tests.
- Simulated QSO: feed `onPeriodDecodeReady` a scripted decode sequence with
  `myCall = OE/OK1CDJ` working a standard call, and assert the FSM reaches
  `[QSO COMPLETE]` via `CQ → contact → RR73 → 73`.
- Reverse: standard `myCall` working a compound target.
- Edge: both calls non-standard (report skipped, closes on RR73/73).
- Regression: standard-vs-standard QSO still exchanges grid + numeric reports
  unchanged.

## Decisions (locked)

1. **Scope:** implement core FSM fix **items 1–4** (call classifier, encodable
   TX generation, hash-aware matching, and HashCallBook persistence). Item 5
   (input validation) is deferred.
2. **Report handling:** degraded sequence accepted (matches WSJT-X). Reports are
   skipped for non-standard QSOs; log with synthetic/blank RST. Revisit later if
   needed.
3. **Both-non-standard:** out of scope for v1. Only QSOs where **at least one
   side is a standard call** are supported. If both calls are non-standard, do
   not attempt the QSO (log and skip rather than emit free-text garbage).
