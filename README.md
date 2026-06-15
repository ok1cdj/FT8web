# Web FT8 Client

**Public App Available Here:** [https://ft8web.ok1cdj.com/](https://ft8web.ok1cdj.com/)

**Report Issues:** [GitHub Issues / Help](https://github.com/ok1cdj/FT8web)  
**Support the Project:** [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Become%20a%20Supporter-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/ok1cdj)

A production-ready Amateur Radio FT8 client running entirely in the browser using the Web Audio API, an integrated FSM for automated contacts, and the `@e04/ft8ts` DSP library.

## Features
- **In-Browser Decoding/Encoding:** Uses a Web Worker to decode FT8 audio streams in the background without blocking the UI.
- **Automated QSO State Machine:** Incorporates a robust Finite State Machine (FSM) to automatically manage the flow of your digital contacts (CQ, Grid, SNR Report, 73) and handle DX pile-up caller distance priority sorting.
- **Web Serial & WebUSB CAT Control:** Direct browser-to-radio communication. Uses the native Web Serial API on desktops and a custom `WebUSB` fallback driver on Android (bypassing broken Android serial implementations). Supports low-level control transfers for major USB host chips (Silicon Labs CP210x, Qinheng CH34x, FTDI, and Prolific PL2303) over USB OTG.
- **"Fake Split" (Rig Split) Transmit Optimization:** Dynamically shifts the transceiver VFO frequency during transmission to keep the modulated audio frequency close to the 1500 Hz filter center. This prevents power roll-off and harmonic splatter near the SSB filter edges (0 Hz and 3000 Hz) while restoring the baseline VFO frequency upon return to RX.
- **Band Activity & Active QSO:** Separated global logs and targeted incoming/outgoing QSO messages for clear visibility.
- **Hardware VOX Compatible:** Audio generation uses a hard-start envelope to assure VOX will work natively as an alternative to CAT control.
- **Live Waterfall:** Web Audio API AnalyserNode rendering a high-contrast waterfall focused tightly on the SSB filter bandwidth (0 Hz - 3000 Hz).
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
3. Open the **Settings** menu to format your Station Configuration, CAT Protocol overrides (Kenwood, Icom, or QDX), and other preferences.
   - *Note on CAT:* If setting up CAT control (via Web Serial API), you MUST open the app in a new tab for the browser to allow serial port access (due to iframe permissions). Once in a new tab, select your port and use "Test CAT" to verify frequency reading.
   - *QDX Digital Transceiver Mode:* Choose **QDX** mode under CAT Protocol settings for a tailored Kenwood-cloned serial control profile matching standard hardware defaults (at 57600 baud rate).
   - *Automated "Fake Split" (Rig Split):* When CAT is successfully connected in Kenwood or Icom modes, the system automatically uses a dual-stage asynchronous timing schedule during transmission. It dynamically increments/decrements your VFO frequency by blocks of 500 Hz while adjusting the Web Audio output tone proportionately. This ensures your transmitted audio stays locked within the cleanest center stage of your radio's SSB passband (at around 1500 Hz), preventing harmonic attenuation or clipping on the edges of the waterfall. Upon unkeying, the driver smoothly resets your radio's VFO back to its baseline frequency for reliable reception.
4. Observe the **Input Level (VU)** indicator. Adjust your radio's output or your computer's input volume so the meter sits in the green/yellow zone (avoid clipping in the red).
5. Watch the waterfall for FT8 signals. Decodes will appear at the :00, :15, :30, and :45 second marks in the UTC cycle.
6. **CRITICAL:** Ensure your device's system clock is accurate (synchronized via NTP) as FT8 relies strictly on synchronized UTC time windows.

## Running the Automated Test Suite

We have included a standalone HTML-based Mock Test Suite to verify the core Logic and State Machine.
To run the tests:
1. Navgiate to the [`/fsm_test_runner.html`](/fsm_test_runner.html) route in your browser (e.g. `http://localhost:3000/fsm_test_runner.html` or the equivalent preview URL).
2. The browser will automatically run the validation suites, including Success Paths, Timeout handling, and caller distance calculations via the Haversine formula.
3. Review the on-screen logs for green `PASS` and red `FAIL` assertions.

## Architecture
- **Frontend:** React 19 + Vite + Tailwind CSS v4
- **Hardware Integration Layer:** Custom `UniversalSerialPort` acting as an abstraction over native Web Serial API capability and direct Android `WebUSB` control transfers, facilitating Android USB-OTG connectivity for amateur radio transceivers.
- **DSP Engine:** `@e04/ft8ts` (Running in a dedicated Web Worker `ft8-worker.ts`)
- **Audio Pipeline:** `AudioWorkletNode` (`AudioWorkletBlob.ts`) for raw sample accumulation (avoiding main thread drops).

## 🗺️ Roadmap / Upcoming Features
- [ ] Intensive testing with more radios
- [ ] FT4 Mode support (7.5s T/R cycles via `@e04/ft8ts` mode switching)
- [ ] Built-in better logbook

### Tested Radios
- **IC-7300** (Success)
- **IC-705** (Success)

### Hardware Testing Feedback
We need to test Kenwood and QDX transceivers. If you have success running this web app with your radio model, **please report it to us by opening an issue!**

## ⚖️ License & Attributions

This project is open-source and licensed under the **GNU General Public License v3 (GPL v3)**.

### Acknowledgments
* **FT8/FT4 Protocols:** FT8 and FT4 are digital amateur radio modes designed for weak-signal communication, originally developed by **Joe Taylor (K1JT)** and **Steve Franke (K9AN)** as part of the WSJT-X suite.
* **DSP Implementation:** This application utilizes the pure TypeScript DSP library `@e04/ft8ts`.

