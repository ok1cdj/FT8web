# Web FT8/FT4 Client

**Public App Available Here:** [https://ft8web.ok1cdj.com/](https://ft8web.ok1cdj.com/)

**Report Issues:** [GitHub Issues / Help](https://github.com/ok1cdj/FT8web)  
**Support the Project:** [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Become%20a%20Supporter-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/ok1cdj)

A production-ready Amateur Radio FT8/FT4 client running entirely in the browser using the Web Audio API, an integrated FSM for automated contacts, and the `@e04/ft8ts` DSP library.

## Features
- **FT8 & FT4 Modes:** Switch between FT8 (15s T/R cycles) and FT4 (7.5s T/R cycles) with a single button. Band dial frequencies, timing windows, decode triggers, and TX encoding all switch automatically. Mode is persisted across sessions.
- **In-Browser Decoding/Encoding:** Uses a Web Worker to decode FT8/FT4 audio streams in the background without blocking the UI.
- **Automated QSO State Machine:** Incorporates a robust Finite State Machine (FSM) to automatically manage the flow of your digital contacts (CQ, Grid, SNR Report, 73) and handle DX pile-up caller distance priority sorting.
- **Web Serial & WebUSB CAT Control:** Direct browser-to-radio communication. Uses the native Web Serial API on PC/desktop systems (with filters fully bypassed to let you select any connected hardware serial port) and a custom, optimized `WebUSB` fallback driver with pre-coded host chip filtering on Android (bypassing broken Android serial implementations). Supports low-level control transfers for major USB host chips (Silicon Labs CP210x including CP2105 dual-port, Qinheng CH34x, FTDI, and Prolific PL2303) over USB OTG.
- **Old Yaesu Binary CAT Protocol:** Native support for classic Yaesu transceivers (FT-817, FT-857, FT-897) using the 5-byte binary command set with BCD-encoded frequencies at 4800 baud.
- **CP2105 Dual-Port Support (Android):** On Android, the CP2105 USB-serial bridge exposes two independent UART interfaces. A channel selector lets you choose which port (Enhanced or Standard) is used for CAT, without needing a second device picker.
- **"Fake Split" (Rig Split) Transmit Optimization:** Dynamically shifts the transceiver VFO frequency during transmission to keep the modulated audio frequency close to the 1500 Hz filter center. This prevents power roll-off and harmonic splatter near the SSB filter edges (0 Hz and 3000 Hz) while restoring the baseline VFO frequency upon return to RX.
- **Band Activity & Active QSO:** Separated global logs and targeted incoming/outgoing QSO messages for clear visibility.
- **Hardware VOX Compatible:** Audio generation uses a hard-start envelope to assure VOX will work natively as an alternative to CAT control.
- **Live Waterfall:** Web Audio API AnalyserNode rendering a high-contrast waterfall focused tightly on the SSB filter bandwidth (0 Hz - 3000 Hz).
- **Audio Output Device Selection:** Choose a specific audio output device for TX (headphones, USB audio, etc.) independently from the system default. Requires Chrome on desktop.
- **Wavelog & Cloudlog API Logging:** Secure, real-time logging to cloud systems (Wavelog / Cloudlog) with a built-in proxy bypass to protect secret API keys, real-time status reporting, manual single-entry sync buttons, and batch sync commands.
- **Mobile Testing & iOS/Android Support:** Built with strict user-interaction requirements for audio contexts to support iOS Safari. Embedded Eruda developer console accessible via `?debug=true` for advanced on-device DSP/CAT protocol debugging.

## Testing with a Real Radio (Hardware Setup)

To use this application with a real transceiver, follow these steps:

### 1. Audio Connection
- **RX:** Connect your radio's Line Out / Audio Out to your computer/device's Microphone / Line In.
- **TX:** Connect your computer's Headphone / Line Out to your radio's Audio In / ACC port.
- *Note for modern radios (e.g. IC-7300, FT-991A): This is usually handled over a single USB cable presenting as a USB Audio Codec.*

### 2. Transceiver Settings
- **Mode:** USB Data (USB-D) or standard USB with a wide filter (2500 - 3000 Hz).
- **VOX / CAT:** Use Web Serial CAT control if supported for PTT via settings. Alternatively, enable Hardware VOX on your radio and adjust the VOX Gain/Delay so that it triggers reliably when the browser generates tone.
- **AGC:** Set AGC (Automatic Gain Control) to Fast or Off for best decoding performance.
- **DSP/Filters:** Disable Noise Blanker (NB), Noise Reduction (NR), and Notch Filters.

### 3. Application Workflow
1. Load the application and click **"ACTIVATE AUDIO"**.
2. Allow browser permissions to use the microphone/audio input.
3. Open the **Settings** menu to format your Station Configuration, CAT Protocol overrides, and other preferences.
   - *Note on CAT:* If setting up CAT control (via Web Serial API), you MUST open the app in a new tab for the browser to allow serial port access (due to iframe permissions). Once in a new tab, select your port and use "Test CAT" to verify frequency reading. On PC/Mac/Linux, serial port filtering is completely removed so the browser will prompt you with all connected serial adapters. On Android, a target set of filter vendor/product IDs is used inside WebUSB to cleanly list eligible USB devices.
   - *Yaesu Protocol Mode:* Choose **Yaesu** mode for modern Yaesu transceivers (FT-710, FTDX10, FT-991A, FT-891). It uses 38400 baud, forces DTR/RTS signals HIGH for CAT authentication, and maps to standard ASCII commands.
   - *Old Yaesu Protocol Mode:* Choose **Old Yaesu** mode for classic Yaesu transceivers (FT-817, FT-857, FT-897). It uses 5-byte binary commands with BCD-encoded frequencies at 4800 baud.
   - *Elecraft Transceiver Mode:* Choose **Elecraft** mode for Elecraft transceivers (K3, KX3, KX2, etc.). It communicates using ASCII commands at 38400 baud, sets DTR/RTS signals LOW to avoid inadvertent hardware PTT triggers, and supports the same automated split/VFO offset logic as the Kenwood driver.
   - *QDX Digital Transceiver Mode:* Choose **QDX** mode under CAT Protocol settings for a tailored Kenwood-cloned serial control profile matching standard hardware defaults (at 57600 baud rate). *Note on Android:* Due to Android kernel security constraints, Android automatically binds standard CDC ACM USB serial devices to its own system drivers, which prevents WebUSB from claiming the interface (`claimInterface()` failure). Consequently, QDX CAT is disabled in settings when running on Android, though standard desktop web browsers on PC/Mac/Linux support QDX fully.
   - *Automated "Fake Split" (Rig Split):* When CAT is successfully connected in Kenwood, Yaesu, Elecraft, or Icom modes, the system automatically uses a dual-stage asynchronous timing schedule during transmission. It dynamically increments/decrements your VFO frequency by blocks of 500 Hz while adjusting the Web Audio output tone proportionately. This ensures your transmitted audio stays locked within the cleanest center stage of your radio's SSB passband (at around 1500 Hz), preventing harmonic attenuation or clipping on the edges of the waterfall. Upon unkeying, the driver smoothly resets your radio's VFO back to its baseline frequency for reliable reception.
4. Observe the **Input Level (VU)** indicator. Adjust your radio's output or your computer's input volume so the meter sits in the green/yellow zone (avoid clipping in the red).
5. Select the operating mode (**FT8** or **FT4**) using the mode button in the band bar. FT8 decodes appear at :00, :15, :30, and :45 second marks; FT4 decodes appear at :00, :07, :15, :22, :30, :37, :45, and :52 second marks.
6. **CRITICAL:** Ensure your device's system clock is accurate (synchronized via NTP) as FT8/FT4 relies strictly on synchronized UTC time windows.

## Running the Automated Test Suite

We have included a standalone HTML-based Mock Test Suite to verify the core Logic and State Machine.
To run the tests:
1. Navgiate to the [`/fsm_test_runner.html`](/fsm_test_runner.html) route in your browser (e.g. `http://localhost:3000/fsm_test_runner.html` or the equivalent preview URL).
2. The browser will automatically run the validation suites, including Success Paths, Timeout handling, and caller distance calculations via the Haversine formula.
3. Review the on-screen logs for green `PASS` and red `FAIL` assertions.

## Wavelog & Cloudlog Integration

Log your FT8/FT4 QSOs automatically with **Wavelog** or **Cloudlog**:
- **Real-time Synchronization:** When configured, every finished QSO from your automated finite state machine (FSM) is pushed automatically.
- **Manual Force-Sync Actions:** If you did not have internet during the QSO, or if the initial API connection failed, you can retry at any time:
  - **Batch Sync:** In the Logbook Viewer section, select **Sync All** to queue all outstanding logs.
  - **Single Sync:** Click the dedicated cloud-upload icon next to any specific QSO row in the log list to manually upload the selected record.
- **Detailed Console Debugging:** To help troubleshoot failed submissions, the client includes explicit debug telemetry. Open the browser developer tools console to inspect exact payloads, ADIF format strings, HTTP status codes, and server return messages.
- **Secure Server Proxy (`/api/log-proxy`):** To avoid revealing your confidential read/write API Keys in the browser or getting blocked by browser Cross-Origin Resource Sharing (CORS) limits, all requests are securely proxied on the server.

### Setup Instructions
1. Open the **Station Configuration** (Settings gear icon).
2. Set **Wavelog Cloud Sync** to **Enabled**.
3. Input your **Wavelog Instance URL** (e.g. `https://log.example.com` or `https://log.sv0syh.eu`).
4. Enter your **Wavelog API Key** (`wl...` or your standard API key).
5. Enter your **Station Profile ID** (the corresponding numeric location profile).
6. Save and successfully log your contacts!

## Architecture
- **Frontend:** React 19 + Vite + Tailwind CSS v4
- **Hardware Integration Layer:** Custom `UniversalSerialPort` acting as an abstraction over native Web Serial API capability and direct Android `WebUSB` control transfers, facilitating Android USB-OTG connectivity for amateur radio transceivers.
- **DSP Engine:** `@e04/ft8ts` (Running in a dedicated Web Worker `ft8-worker.ts`)
- **Audio Pipeline:** `AudioWorkletNode` (`AudioWorkletBlob.ts`) for raw sample accumulation (avoiding main thread drops).

## 🗺️ Roadmap / Upcoming Features
- [ ] Intensive testing with more radios
- [x] FT4 Mode support (7.5s T/R cycles via `@e04/ft8ts` mode switching)
- [ ] Built-in better logbook

### Tested Radios

| Radio | PC | Android |
| :--- | :---: | :---: |
| **IC-705** | ✅ | ✅ |
| **IC-7300** | ✅ | ✅ |
| **Yaesu FTX-1** | ✅ | ✅ |
| **Yaesu FT-817** | In Progress | In Progress |
| **Flex 6400** | ✅ | N/A |
| **Flex 8400** | ✅ | N/A |

### Hardware Testing Feedback
We have implemented and support serial CAT and PTT protocols for **Kenwood**, **Yaesu** (modern ASCII: FT-710, FTDX10, FT-991A, FT-891), **Old Yaesu binary** (FT-817, FT-857, FT-897), **Elecraft**, **Icom**, and **QDX** transceivers, but some of these configurations are currently **untested in real-world environments**.

If you have success operating this web application with your radio model, or if you encounter any protocol mismatches, **please report your results by opening an issue on GitHub!**

## ⚖️ License & Attributions

This project is open-source and licensed under the **GNU General Public License v3 (GPL v3)**.

### Acknowledgments
* **FT8/FT4 Protocols:** FT8 and FT4 are digital amateur radio modes designed for weak-signal communication, originally developed by **Joe Taylor (K1JT)** and **Steve Franke (K9AN)** as part of the WSJT-X suite.
* **DSP Implementation:** This application utilizes the pure TypeScript DSP library `@e04/ft8ts`.
