# FT8web — Feature TODO

## Planned Features

### 1. DXCC check: ignore mode (band-only)

Add a setting in the settings panel to make DXCC worked/new status checks band-only, ignoring the current mode.

**Current behavior:** DXCC status (N/W badge) is tracked per band + mode combination (e.g. 20m FT8 and 20m FT4 are separate).

**Desired behavior (when enabled):** Treat a DXCC entity as worked on a band regardless of which mode it was worked on. Working a station on 20m FT4 would count as worked on 20m even if you previously only had it on 20m FT8.

**Implementation notes:**
- Add a boolean setting, e.g. `dxccIgnoreMode` (default: `false`)
- When enabled, the DXCC lookup key should be `primaryPrefix + band` only (drop the mode component)
- The `DxccService` cache and worked-entity storage both use this key — both need to respect the setting
- Affects the N/W badge display in the call panel and the decode list

---

### 2. Logbook: QSO count display

Show a count of logged QSOs somewhere in the logbook UI (e.g. in the logbook panel header or footer).

**Desired behavior:** A simple numeric counter — total QSOs in the current logbook session, or total stored. Update live as QSOs are logged.

**Implementation notes:**
- Read the count from the logbook store/service
- Display near the logbook heading or as a small badge

---

### 3. Settings: disable automatic upload to Cloudlog/Wavelog

Add an option to suppress automatic QSO upload to Cloudlog/Wavelog after each logged QSO.

**Current behavior:** QSOs are uploaded automatically to Cloudlog/Wavelog when configured.

**Desired behavior (when disabled):** QSOs are stored locally only; no upload happens automatically. User can trigger upload manually (future feature) or rely on ADIF export.

**Implementation notes:**
- Add a boolean setting, e.g. `autoUploadCloudlog` (default: `true`)
- In the upload logic (wherever the Cloudlog/Wavelog API call is made after logging), check this flag and skip the call if `false`
- The setting should be visible/editable in the Cloudlog/Wavelog section of Settings

---

### 4. FSM: skip TX1 (grid) when answering a CQ station

Add a setting to skip the first outgoing message (TX1, which contains the grid locator) and start the exchange directly with the signal report (TX2).

**Current behavior:** When clicking a CQ station to answer, the FSM starts at TX1 — `OK1XX OK1CDJ JO70`.

**Desired behavior (when enabled):** FSM starts at TX2 — `OK1XX OK1CDJ -10` — skipping the grid transmission. Useful when the other station already has your grid or when you want to speed up the exchange.

**Implementation notes:**
- Add a boolean setting, e.g. `skipTx1Grid` (default: `false`)
- In the FSM, when initiating a QSO by answering a CQ, check the setting and advance the initial TX step from TX1 to TX2
- The grid is still known internally (needed for logging); it just won't be transmitted in the first message
- Should not affect the case where you are calling CQ yourself (TX1 is always your grid when CQing)
