# Web FT8 Proof of Concept (PoC)

An Amateur Radio FT8 client running entirely in the browser using the Web Audio API and the `@e04/ft8ts` DSP library.

## Features
- **In-Browser Decoding/Encoding:** Uses a Web Worker to decode FT8 audio streams in the background without blocking the UI.
- **Band Activity & Active QSO:** Separated global logs and targeted incoming/outgoing QSO messages for clear visibility.
- **Hardware VOX Compatible:** Audio generation uses a hard-start envelope to ensure immediate triggering of transceiver hardware VOX (No CAT control required).
- **Live Waterfall:** Web Audio API AnalyserNode rendering a high-contrast waterfall focused tightly on the SSB filter bandwidth (0 Hz - 3000 Hz).
- **iOS Compliant:** Strict user-interaction requirements for audio context creation to ensure compatibility with Safari on iOS.

## Testing with a Real Radio (Hardware Setup)

To test this PoC with a real transceiver, follow these steps:

### 1. Audio Connection
- **RX:** Connect your radio's Line Out / Audio Out to your computer/device's Microphone / Line In.
- **TX:** Connect your computer's Headphone / Line Out to your radio's Audio In / ACC port.
- *Note for modern radios (e.g. IC-7300, FT-991A): This is usually handled over a single USB cable presenting as a USB Audio Codec.*

### 2. Transceiver Settings
- **Mode:** USB Data (USB-D) or standard USB with a wide filter (2500 - 3000 Hz).
- **VOX:** Enable Hardware VOX on your radio and adjust the VOX Gain/Delay so that it triggers reliably when the browser generates tone, but doesn't drop between FT8 symbols.
- **AGC:** Set AGC (Automatic Gain Control) to Fast or Off for best decoding performance.
- **DSP/Filters:** Disable Noise Blanker (NB), Noise Reduction (NR), and Notch Filters.

### 3. Application Workflow
1. Load the application and click **"ACTIVATE AUDIO"**.
2. Allow browser permissions to use the microphone/audio input.
3. Observe the **Input Level (VU)** indicator. Adjust your radio's output or your computer's input volume so the meter sits in the green/yellow zone (avoid clipping in the red).
4. Watch the waterfall for FT8 signals. Decodes will appear at the :00, :15, :30, and :45 second marks in the UTC cycle.
5. **CRITICAL:** Ensure your device's system clock is accurate (synchronized via NTP) as FT8 relies strictly on synchronized UTC time windows.

## Architecture
- **Frontend:** React 19 + Vite + Tailwind CSS v4
- **DSP Engine:** `@e04/ft8ts` (Running in a dedicated Web Worker `ft8-worker.ts`)
- **Audio Pipeline:** `AudioWorkletNode` (`AudioWorkletBlob.ts`) for raw sample accumulation (avoiding main thread drops).
