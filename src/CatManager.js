/**
 * Helper: Convert integer frequency to 5-byte Little-Endian BCD array
 * e.g. 14074000 -> [0x00, 0x40, 0x07, 0x14, 0x00]
 */
function freqToBCD(freq) {
  let s = freq.toString().padStart(10, '0');
  let bcd = new Uint8Array(5);
  // Icom uses little-endian ordering for frequency bytes
  bcd[0] = parseInt(s.substring(8, 10), 16);
  bcd[1] = parseInt(s.substring(6, 8), 16);
  bcd[2] = parseInt(s.substring(4, 6), 16);
  bcd[3] = parseInt(s.substring(2, 4), 16);
  bcd[4] = parseInt(s.substring(0, 2), 16);
  return bcd;
}

/**
 * Helper: Convert 5-byte Little-Endian BCD array to integer frequency
 */
function bcdToFreq(bcd) {
  let freq = 0;
  let multiplier = 1;
  for (let i = 0; i < 5; i++) {
    let lower = bcd[i] & 0x0F;
    let upper = (bcd[i] >> 4) & 0x0F;
    freq += (lower * multiplier);
    multiplier *= 10;
    freq += (upper * multiplier);
    multiplier *= 10;
  }
  return freq;
}

// ---------------------------------------------------------
// Variant A: Manual (No CAT / Fallback)
// ---------------------------------------------------------
class ManualDriver {
  async connect(port) {
    // No-op for manual fallback
    return Promise.resolve();
  }
  async setFrequency(freqHz) {
    // Safely resolve immediately
    return Promise.resolve();
  }
  async setTx(isTxActive, userAudioFreq = 1500) {
    // Safely resolve immediately and return optimized audio frequency
    return Promise.resolve(isTxActive ? userAudioFreq : null);
  }
  async getFrequency() {
    // Doesn't interact with hardware
    return Promise.resolve(0);
  }
  async disconnect() {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------
// Variant B: Kenwood (ASCII Protocol)
// ---------------------------------------------------------
class KenwoodDriver {
  constructor(baudRate = 57600) {
    this.baudRate = baudRate;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.pendingFreqResolvers = [];
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.isActive = false;
    this.rxFrequency = 14074000; // Baseline frequency default
    this.vfoOffset = 0; // Current active offset
  }

  async connect(port) {
    if (!port) {
      throw new Error("No serial port provided for Kenwood connection");
    }
    this.port = port;
    if (!this.port.readable) {
        try {
            // Kenwood preferred baud rates are typically 38400 or 57600
            await this.port.open({ baudRate: this.baudRate });
        } catch (e) {
            console.error("Kenwood Port open error: ", e);
            throw new Error(`Failed to open Kenwood CAT port (${e.message || e})`);
        }
    }
    
    if (!this.port.readable || !this.port.writable) {
        throw new Error("Kenwood serial port opened but readable/writable streams are unavailable. Ensure another app is not using this port.");
    }
    
    try {
        if (this.port && typeof this.port.setSignals === 'function') {
            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
            console.log("[CatManager] Forced Kenwood RTS & DTR OFF on connect");
        }
    } catch (sigErr) {
        console.warn("[CatManager] Failed to set signals on connect:", sigErr);
    }
    
    // Use raw binary streams with clean on-the-fly text decoders to avoid pipeTo locking issues
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.isActive = true;
    
    // Start continuous read loop
    this.readLoop();
  }

  async readLoop() {
    try {
      while (this.isActive) {
        const { value, done } = await this.reader.read();
        if (done || !this.isActive) break;
        if (value) {
          const text = this.decoder.decode(value);
          this.buffer += text;
          let semiIndex;
          // Commands are semicolon terminated
          while ((semiIndex = this.buffer.indexOf(';')) !== -1) {
            const msg = this.buffer.substring(0, semiIndex + 1); // include ';' in case we want it
            this.buffer = this.buffer.substring(semiIndex + 1);
            this.handleMessage(msg);
          }
        }
      }
    } catch (e) {
      if (this.isActive) {
        console.error("Kenwood Read Loop Error:", e);
      }
    }
  }

  handleMessage(msg) {
    // e.g., FA00014074000;
    if (msg.startsWith("FA") && msg.length >= 13) {
      const freqStr = msg.substring(2, 13);
      const freq = parseInt(freqStr, 10);
      if (!this.vfoOffset || this.vfoOffset === 0) {
        this.rxFrequency = freq;
      }
      if (this.pendingFreqResolvers.length > 0) {
        const resolve = this.pendingFreqResolvers.shift();
        resolve(freq);
      }
    }
  }

  async setFrequency(freqHz) {
    this.rxFrequency = freqHz; // Store the baseline RX frequency
    if (!this.writer) return;
    // FA needs 11 digits padded with leading zeros
    const freqStr = freqHz.toString().padStart(11, '0');
    await this.writer.write(this.encoder.encode(`FA${freqStr};`));
  }

  async setTx(isTxActive, userAudioFreq = 1500) {
    if (!this.writer) return isTxActive ? userAudioFreq : null;
    
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    if (isTxActive) {
      // 1. Calculate vfoOffset and txAudioFreq
      const vfoOffset = Math.round((userAudioFreq - 1500) / 500) * 500;
      const txAudioFreq = userAudioFreq - vfoOffset;
      const txVfoFreq = this.rxFrequency + vfoOffset;

      // 2. Store offset state
      this.vfoOffset = vfoOffset;

      // 3. Command radio to retune VFO if offset is not 0
      if (this.vfoOffset !== 0) {
        const freqStr = txVfoFreq.toString().padStart(11, '0');
        await this.writer.write(this.encoder.encode(`FA${freqStr};`));
      }

      // 4. Minor hardware settling delay
      await sleep(50);

      // 5. Send PTT command to start transmitting
      await this.writer.write(this.encoder.encode('TX;'));

      // 6. Return recalculated audio frequency
      return txAudioFreq;
    } else {
      // 1. Immediately stop transmitting
      await this.writer.write(this.encoder.encode('RX;'));

      // 2. If vfoOffset was not 0, delay and retune back
      if (this.vfoOffset !== 0) {
        await sleep(50);
        const freqStr = this.rxFrequency.toString().padStart(11, '0');
        await this.writer.write(this.encoder.encode(`FA${freqStr};`));
      }

      // 3. Reset offset state
      this.vfoOffset = 0;

      return null;
    }
  }

  async getFrequency() {
    if (!this.writer) {
      return Promise.reject(new Error("Kenwood port is not connected"));
    }
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      try {
        await this.writer.write(this.encoder.encode('FA;'));
      } catch (writeErr) {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) this.pendingFreqResolvers.splice(idx, 1);
        reject(writeErr);
        return;
      }
      // Time-out if radio disconnected or unresponsive
      setTimeout(() => {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) {
          this.pendingFreqResolvers.splice(idx, 1);
          reject(new Error("Timeout reading Kenwood frequency"));
        }
      }, 1500);
    });
  }

  async disconnect() {
    this.isActive = false;
    if (!this.port) return;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch (e) {
      console.warn("Kenwood release lock error (reader):", e);
    }
    try {
      if (this.writer) {
        this.writer.releaseLock();
      }
    } catch (e) {
      console.warn("Kenwood release lock error (writer):", e);
    }
    try {
      if (this.port.readable || this.port.writable) {
        await this.port.close().catch(() => {});
      }
    } catch (e) {
      console.warn("Kenwood port close error:", e);
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
  }
}

// ---------------------------------------------------------
// Variant B.2: Yaesu (ASCII Protocol)
// ---------------------------------------------------------
class YaesuDriver {
  constructor(baudRate = 38400) {
    this.baudRate = baudRate;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.pendingFreqResolvers = [];
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.isActive = false;
    this.rxFrequency = 14074000; // Baseline frequency default
    this.vfoOffset = 0; // Current active offset
  }

  async connect(port) {
    if (!port) {
      throw new Error("No serial port provided for Yaesu connection");
    }
    this.port = port;
    if (!this.port.readable) {
        try {
            await this.port.open({ baudRate: this.baudRate });
        } catch (e) {
            console.error("Yaesu Port open error: ", e);
            throw new Error(`Failed to open Yaesu CAT port (${e.message || e})`);
        }
    }
    
    if (!this.port.readable || !this.port.writable) {
        throw new Error("Yaesu serial port opened but readable/writable streams are unavailable. Ensure another app is not using this port.");
    }
    
    try {
        if (this.port && typeof this.port.setSignals === 'function') {
            await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
            console.log("[CatManager] DTR & RTS driven HIGH on connect for Yaesu");
        }
    } catch (sigErr) {
        console.warn("[CatManager] Failed to set signals on connect:", sigErr);
    }
    
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.isActive = true;
    
    // Start continuous read loop
    this.readLoop();
  }

  async readLoop() {
    try {
      while (this.isActive) {
        const { value, done } = await this.reader.read();
        if (done || !this.isActive) break;
        if (value) {
          const text = this.decoder.decode(value);
          this.buffer += text;
          let semiIndex;
          // Commands are semicolon terminated
          while ((semiIndex = this.buffer.indexOf(';')) !== -1) {
            const msg = this.buffer.substring(0, semiIndex + 1); // include ';'
            this.buffer = this.buffer.substring(semiIndex + 1);
            this.handleMessage(msg);
          }
        }
      }
    } catch (e) {
      if (this.isActive) {
        console.error("Yaesu Read Loop Error:", e);
      }
    }
  }

  handleMessage(msg) {
    // e.g., FA014074000;
    if (msg.startsWith("FA") && msg.length >= 11) {
      const freqStr = msg.substring(2, 11);
      const freq = parseInt(freqStr, 10);
      if (!this.vfoOffset || this.vfoOffset === 0) {
        this.rxFrequency = freq;
      }
      if (this.pendingFreqResolvers.length > 0) {
        const resolve = this.pendingFreqResolvers.shift();
        resolve(freq);
      }
    }
  }

  async setFrequency(freqHz) {
    this.rxFrequency = freqHz; // Store the baseline RX frequency
    if (!this.writer) return;
    // FA needs 9 digits padded with leading zeros
    const freqStr = freqHz.toString().padStart(9, '0');
    await this.writer.write(this.encoder.encode(`FA${freqStr};`));
  }

  async setTx(isTxActive, userAudioFreq = 1500) {
    if (!this.writer) return isTxActive ? userAudioFreq : null;
    
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    if (isTxActive) {
      // 1. Calculate vfoOffset and txAudioFreq
      const vfoOffset = Math.round((userAudioFreq - 1500) / 500) * 500;
      const txAudioFreq = userAudioFreq - vfoOffset;
      const txVfoFreq = this.rxFrequency + vfoOffset;

      // 2. Store offset state
      this.vfoOffset = vfoOffset;

      // 3. Command radio to retune VFO if offset is not 0
      if (this.vfoOffset !== 0) {
        const freqStr = txVfoFreq.toString().padStart(9, '0');
        await this.writer.write(this.encoder.encode(`FA${freqStr};`));
      }

      // 4. Minor hardware settling delay
      await sleep(50);

      // 5. Send PTT command to start transmitting (TX1;)
      await this.writer.write(this.encoder.encode('TX1;'));

      // 6. Return recalculated audio frequency
      return txAudioFreq;
    } else {
      // 1. Immediately stop transmitting (TX0;)
      await this.writer.write(this.encoder.encode('TX0;'));

      // 2. If vfoOffset was not 0, delay and retune back
      if (this.vfoOffset !== 0) {
        await sleep(50);
        const freqStr = this.rxFrequency.toString().padStart(9, '0');
        await this.writer.write(this.encoder.encode(`FA${freqStr};`));
      }

      // 3. Reset offset state
      this.vfoOffset = 0;

      return null;
    }
  }

  async getFrequency() {
    if (!this.writer) {
      return Promise.reject(new Error("Yaesu port is not connected"));
    }
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      try {
        await this.writer.write(this.encoder.encode('FA;'));
      } catch (writeErr) {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) this.pendingFreqResolvers.splice(idx, 1);
        reject(writeErr);
        return;
      }
      // Time-out if radio disconnected or unresponsive
      setTimeout(() => {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) {
          this.pendingFreqResolvers.splice(idx, 1);
          reject(new Error("Timeout reading Yaesu frequency"));
        }
      }, 1500);
    });
  }

  async disconnect() {
    this.isActive = false;
    if (!this.port) return;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch (e) {
      console.warn("Yaesu release lock error (reader):", e);
    }
    try {
      if (this.writer) {
        this.writer.releaseLock();
      }
    } catch (e) {
      console.warn("Yaesu release lock error (writer):", e);
    }
    try {
      if (this.port.readable || this.port.writable) {
        await this.port.close().catch(() => {});
      }
    } catch (e) {
      console.warn("Yaesu port close error:", e);
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
  }
}

// ---------------------------------------------------------
// Variant B.3: Old Yaesu (Binary Protocol, FT-817/857/897)
// ---------------------------------------------------------
// Commands are 5 bytes: [P1, P2, P3, P4, OPCODE]
// Frequency is encoded as big-endian BCD in 10 Hz resolution.
// Default baud rate is 4800 — too slow for fake-split VFO shifts,
// so PTT-only CAT is used and audio stays at the user-selected offset.
class OldYaesuDriver {
  constructor(baudRate = 4800) {
    this.baudRate = baudRate;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.rxBuffer = [];
    this.pendingFreqResolvers = [];
    this.isActive = false;
    this.rxFrequency = 14074000;
  }

  async connect(port) {
    if (!port) throw new Error("No serial port provided for Old Yaesu connection");
    this.port = port;
    if (!this.port.readable) {
      try {
        await this.port.open({ baudRate: this.baudRate });
      } catch (e) {
        throw new Error(`Failed to open Old Yaesu CAT port (${e.message || e})`);
      }
    }
    if (!this.port.readable || !this.port.writable) {
      throw new Error("Old Yaesu serial port opened but streams are unavailable.");
    }
    try {
      if (typeof this.port.setSignals === 'function') {
        await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      }
    } catch (e) {
      console.warn("[CatManager] Old Yaesu: failed to set signals:", e);
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.isActive = true;
    this.readLoop();
  }

  async readLoop() {
    try {
      while (this.isActive) {
        const { value, done } = await this.reader.read();
        if (done || !this.isActive) break;
        if (value) {
          for (let i = 0; i < value.length; i++) this.rxBuffer.push(value[i]);
          this.processBuffer();
        }
      }
    } catch (e) {
      if (this.isActive) console.error("Old Yaesu Read Loop Error:", e);
    }
  }

  processBuffer() {
    if (this.pendingFreqResolvers.length > 0 && this.rxBuffer.length >= 5) {
      // Bytes 0-3: big-endian BCD frequency (10 Hz resolution). Byte 4: mode (ignored).
      const frame = this.rxBuffer.splice(0, 5);
      const freq = this._bcdBytesToHz(frame);
      if (freq > 0) this.rxFrequency = freq;
      const resolve = this.pendingFreqResolvers.shift();
      resolve(freq);
    } else if (this.pendingFreqResolvers.length === 0) {
      // Drain single-byte ACKs from PTT / set-frequency responses.
      this.rxBuffer = [];
    }
  }

  // 4 big-endian BCD bytes → Hz  (byte 4 is mode, ignored)
  _bcdBytesToHz(bytes) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += ((bytes[i] >> 4) & 0x0F).toString();
      s += (bytes[i] & 0x0F).toString();
    }
    return parseInt(s, 10) * 10;
  }

  // Hz → 4 big-endian BCD bytes (10 Hz resolution)
  _hzToBcdBytes(freqHz) {
    const s = Math.round(freqHz / 10).toString().padStart(8, '0');
    // Treat each pair of decimal digits as a hex byte — this packs them as BCD.
    return [
      parseInt(s.substring(0, 2), 16),
      parseInt(s.substring(2, 4), 16),
      parseInt(s.substring(4, 6), 16),
      parseInt(s.substring(6, 8), 16),
    ];
  }

  async _sendCmd(p1, p2, p3, p4, opcode) {
    if (!this.writer) return;
    await this.writer.write(new Uint8Array([p1, p2, p3, p4, opcode]));
  }

  async getFrequency() {
    if (!this.writer) return Promise.reject(new Error("Old Yaesu port is not connected"));
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      try {
        await this._sendCmd(0x00, 0x00, 0x00, 0x00, 0x03); // READ_FREQ
      } catch (e) {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) this.pendingFreqResolvers.splice(idx, 1);
        reject(e);
        return;
      }
      // 4800 baud needs a longer timeout than faster drivers
      setTimeout(() => {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) {
          this.pendingFreqResolvers.splice(idx, 1);
          reject(new Error("Timeout reading Old Yaesu frequency"));
        }
      }, 3000);
    });
  }

  async setFrequency(freqHz) {
    this.rxFrequency = freqHz;
    const [f1, f2, f3, f4] = this._hzToBcdBytes(freqHz);
    await this._sendCmd(f1, f2, f3, f4, 0x01); // SET_FREQ
  }

  async setTx(isTxActive, userAudioFreq = 1500) {
    if (isTxActive) {
      await this._sendCmd(0x00, 0x00, 0x00, 0x00, 0x08); // PTT ON
      return userAudioFreq;
    } else {
      await this._sendCmd(0x00, 0x00, 0x00, 0x00, 0x88); // PTT OFF
      return null;
    }
  }

  async disconnect() {
    this.isActive = false;
    if (!this.port) return;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch (e) {
      console.warn("Old Yaesu release lock error (reader):", e);
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch (e) {
      console.warn("Old Yaesu release lock error (writer):", e);
    }
    try {
      if (this.port.readable || this.port.writable) await this.port.close().catch(() => {});
    } catch (e) {
      console.warn("Old Yaesu port close error:", e);
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.rxBuffer = [];
  }
}

// ---------------------------------------------------------
// Variant C: Icom (CI-V Binary Protocol)
// ---------------------------------------------------------
class IcomDriver {
  constructor(targetAddress = 0x94, baudRate = 115200) {
    this.targetAddress = targetAddress; // IC-7300 default is 0x94, IC-705 is 0xA4
    this.baudRate = baudRate;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = [];
    this.lastTransmittedBytes = [];
    this.pendingFreqResolvers = [];
    this.isActive = false;
    this.rxFrequency = 14074000; // Baseline frequency default
    this.vfoOffset = 0; // Current active offset
  }

  async connect(port) {
    if (!port) {
      throw new Error("No serial port provided for Icom connection");
    }
    this.port = port;
    if (!this.port.readable) {
        try {
            await this.port.open({ baudRate: this.baudRate }); // Standard modern Icom rate
        } catch (e) {
            console.error("Icom Port open error:", e);
            throw new Error(`Failed to open Icom CAT port (${e.message || e})`);
        }
    }
    
    if (!this.port.readable || !this.port.writable) {
        throw new Error("Icom serial port opened but readable/writable streams are unavailable. Ensure another app is not using this port.");
    }
    
    try {
        if (this.port && typeof this.port.setSignals === 'function') {
            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
            console.log("[CatManager] Forced Icom RTS & DTR OFF on connect");
        }
    } catch (sigErr) {
        console.warn("[CatManager] Failed to set signals on connect:", sigErr);
    }
    
    // ICOM relies purely on raw binary bytes (Uint8Array)
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.isActive = true;
    this.readLoop();
  }

  async readLoop() {
    try {
      while (this.isActive) {
        const { value, done } = await this.reader.read();
        if (done || !this.isActive) break;
        if (value) {
          // Push received bytes to rolling buffer
          for (let i = 0; i < value.length; i++) {
            this.buffer.push(value[i]);
          }
          this.processBuffer();
        }
      }
    } catch (e) {
      if (this.isActive) {
        console.error("Icom Read Loop Error:", e);
      }
    }
  }

  processBuffer() {
    // Minimal CI-V message is 5 bytes: [FE, FE, target, source, FD]
    while (this.buffer.length >= 5) {
      // 1. Locate Preamble 0xFE 0xFE
      let startIdx = -1;
      for (let i = 0; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === 0xFE && this.buffer[i+1] === 0xFE) {
          startIdx = i;
          break;
        }
      }
      
      if (startIdx === -1) {
        // No valid preamble starting sequence, dump buffer
        this.buffer = [];
        return;
      }
      
      // Trim prefix garbage
      if (startIdx > 0) {
        this.buffer = this.buffer.slice(startIdx);
      }

      // 2. Locate Terminator 0xFD
      let endIdx = this.buffer.indexOf(0xFD);
      if (endIdx === -1) {
        // Incomplete frame, wait for consecutive reads
        return;
      }
      
      // Extract the isolated complete frame
      const frame = this.buffer.slice(0, endIdx + 1);
      this.buffer = this.buffer.slice(endIdx + 1); // Shift queue
      
      this.handleFrame(frame);
    }
  }

  handleFrame(frame) {
    // CI-V Edge Case: Echo Cancellation
    // Icom USB serial effectively loops back the bytes the host just wrote.
    if (this.lastTransmittedBytes.length > 0) {
      let isEcho = true;
      if (frame.length === this.lastTransmittedBytes.length) {
        for (let i = 0; i < frame.length; i++) {
          if (frame[i] !== this.lastTransmittedBytes[i]) {
            isEcho = false;
            break;
          }
        }
        if (isEcho) {
          // Perfectly matches what we just sent. Erase lock and discard.
          this.lastTransmittedBytes = [];
          return;
        }
      }
    }

    // CI-V Frame Structure: [0xFE, 0xFE, Target, Source, Command, [SubCommand / Data], 0xFD]
    if (frame.length < 6) return; 
    
    const sender = frame[3]; // The radio answering us
    const cmd = frame[4];
    
    // Command 0x03 read freq responses echo as cmd 0x03 with payload.
    // Length must be at least 11: FE FE [target] [source] 03 [5 bytes freq] FD
    if (cmd === 0x03 && frame.length >= 10) {
        const bcdData = frame.slice(5, 10);
        const freq = bcdToFreq(bcdData);
        if (!this.vfoOffset || this.vfoOffset === 0) {
          this.rxFrequency = freq;
        }
        if (this.pendingFreqResolvers.length > 0) {
          const resolve = this.pendingFreqResolvers.shift();
          resolve(freq);
        }
    }
  }

  async sendFrame(cmd, subCmd, dataBytes = []) {
    if (!this.writer) return;
    // 0xE0 represents the "Controller" (PC) address commonly used
    let packet = [0xFE, 0xFE, this.targetAddress, 0xE0, cmd];
    if (subCmd !== null && subCmd !== undefined) {
      packet.push(subCmd);
    }
    packet.push(...dataBytes);
    packet.push(0xFD);
    
    const uint8Payload = new Uint8Array(packet);
    
    // Snap a copy of what we transmitted to filter out the echo on RX bus.
    this.lastTransmittedBytes = Array.from(uint8Payload);
    
    await this.writer.write(uint8Payload);
  }

  async setFrequency(freqHz) {
    this.rxFrequency = freqHz; // Save baseline
    const bcd = freqToBCD(freqHz);
    // Command 0x05: Set frequency. No sub-command.
    await this.sendFrame(0x05, null, bcd);
  }

  async setTx(isTxActive, userAudioFreq = 1500) {
    if (!this.writer) return isTxActive ? userAudioFreq : null;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    if (isTxActive) {
      // 1. Calculate vfoOffset and txAudioFreq
      const vfoOffset = Math.round((userAudioFreq - 1500) / 500) * 500;
      const txAudioFreq = userAudioFreq - vfoOffset;
      const txVfoFreq = this.rxFrequency + vfoOffset;

      // 2. Store offset
      this.vfoOffset = vfoOffset;

      // 3. Command the radio to retune VFO
      if (this.vfoOffset !== 0) {
        const bcd = freqToBCD(txVfoFreq);
        await this.sendFrame(0x05, null, bcd);
      }

      // 4. Hardware settling delay
      await sleep(50);

      // 5. Send PTT command to start transmitting
      await this.sendFrame(0x1C, 0x00, [0x01]);

      // 6. Return recalculated audio frequency
      return txAudioFreq;
    } else {
      // 1. Immediately stop transmitting (unkey radio)
      await this.sendFrame(0x1C, 0x00, [0x00]);

      // 2. If vfoOffset was not 0, delay and retune back
      if (this.vfoOffset !== 0) {
        await sleep(50);
        const bcd = freqToBCD(this.rxFrequency);
        await this.sendFrame(0x05, null, bcd);
      }

      // 3. Reset state
      this.vfoOffset = 0;

      return null;
    }
  }

  async getFrequency() {
    if (!this.writer) {
      return Promise.reject(new Error("Icom port is not connected"));
    }
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      
      try {
        // Command 0x03: Request operating frequency
        await this.sendFrame(0x03, null, []);
      } catch (writeErr) {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) this.pendingFreqResolvers.splice(idx, 1);
        reject(writeErr);
        return;
      }
      
      setTimeout(() => {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) {
          this.pendingFreqResolvers.splice(idx, 1);
          reject(new Error("Timeout reading Icom CI-V frequency"));
        }
      }, 1500);
    });
  }

  async disconnect() {
    this.isActive = false;
    if (!this.port) return;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch (e) {
      console.warn("Icom release lock error (reader):", e);
    }
    try {
      if (this.writer) {
        this.writer.releaseLock();
      }
    } catch (e) {
      console.warn("Icom release lock error (writer):", e);
    }
    try {
      if (this.port.readable || this.port.writable) {
        await this.port.close().catch(() => {});
      }
    } catch (e) {
      console.warn("Icom port close error:", e);
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = [];
  }
}

// ---------------------------------------------------------
// Variant D: QDX (Kenwood Clone for now)
// ---------------------------------------------------------
class QDXDriver {
  constructor(baudRate = 57600) {
    this.baudRate = baudRate;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.pendingFreqResolvers = [];
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.isActive = false;
  }

  async connect(port) {
    if (!port) {
      throw new Error("No serial port provided for QDX connection");
    }
    this.port = port;
    if (!this.port.readable) {
        try {
            await this.port.open({ baudRate: this.baudRate });
        } catch (e) {
            console.error("QDX Port open error: ", e);
            throw new Error(`Failed to open QDX CAT port (${e.message || e})`);
        }
    }
    
    if (!this.port.readable || !this.port.writable) {
        throw new Error("QDX serial port opened but readable/writable streams are unavailable. Ensure another app is not using this port.");
    }
    
    try {
        if (this.port && typeof this.port.setSignals === 'function') {
            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
            console.log("[CatManager] Forced QDX RTS & DTR OFF on connect");
        }
    } catch (sigErr) {
        console.warn("[CatManager] Failed to set signals on connect:", sigErr);
    }
    
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.isActive = true;
    
    this.readLoop();
  }

  async readLoop() {
    try {
      while (this.isActive) {
        const { value, done } = await this.reader.read();
        if (done || !this.isActive) break;
        if (value) {
          const text = this.decoder.decode(value);
          this.buffer += text;
          let semiIndex;
          while ((semiIndex = this.buffer.indexOf(';')) !== -1) {
            const msg = this.buffer.substring(0, semiIndex + 1);
            this.buffer = this.buffer.substring(semiIndex + 1);
            this.handleMessage(msg);
          }
        }
      }
    } catch (e) {
      if (this.isActive) {
        console.error("QDX Read Loop Error:", e);
      }
    }
  }

  handleMessage(msg) {
    if (msg.startsWith("FA") && msg.length >= 13) {
      const freqStr = msg.substring(2, 13);
      const freq = parseInt(freqStr, 10);
      if (this.pendingFreqResolvers.length > 0) {
        const resolve = this.pendingFreqResolvers.shift();
        resolve(freq);
      }
    }
  }

  async setFrequency(freqHz) {
    if (!this.writer) return;
    const freqStr = freqHz.toString().padStart(11, '0');
    await this.writer.write(this.encoder.encode(`FA${freqStr};`));
  }

  async setTx(isTxActive, userAudioFreq = 1500) {
    if (!this.writer) return isTxActive ? userAudioFreq : null;
    if (isTxActive) {
      await this.writer.write(this.encoder.encode('TX;'));
      return userAudioFreq;
    } else {
      await this.writer.write(this.encoder.encode('RX;'));
      return null;
    }
  }

  async getFrequency() {
    if (!this.writer) {
      return Promise.reject(new Error("QDX port is not connected"));
    }
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      try {
        await this.writer.write(this.encoder.encode('FA;'));
      } catch (writeErr) {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) this.pendingFreqResolvers.splice(idx, 1);
        reject(writeErr);
        return;
      }
      setTimeout(() => {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) {
          this.pendingFreqResolvers.splice(idx, 1);
          reject(new Error("Timeout reading QDX frequency"));
        }
      }, 1500);
    });
  }

  async disconnect() {
    this.isActive = false;
    if (!this.port) return;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch (e) {
      console.warn("QDX release lock error (reader):", e);
    }
    try {
      if (this.writer) {
        this.writer.releaseLock();
      }
    } catch (e) {
      console.warn("QDX release lock error (writer):", e);
    }
    try {
      if (this.port.readable || this.port.writable) {
        await this.port.close().catch(() => {});
      }
    } catch (e) {
      console.warn("QDX port close error:", e);
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
  }
}

// ---------------------------------------------------------
// Variant D.2: Elecraft (ASCII Protocol)
// ---------------------------------------------------------
class ElecraftDriver {
  constructor(baudRate = 38400) {
    this.baudRate = baudRate;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.pendingFreqResolvers = [];
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.isActive = false;
    this.rxFrequency = 14074000; // Baseline frequency default
    this.vfoOffset = 0; // Current active offset
  }

  async connect(port) {
    if (!port) {
      throw new Error("No serial port provided for Elecraft connection");
    }
    this.port = port;
    if (!this.port.readable) {
        try {
            await this.port.open({ baudRate: this.baudRate });
        } catch (e) {
            console.error("Elecraft Port open error: ", e);
            throw new Error(`Failed to open Elecraft CAT port (${e.message || e})`);
        }
    }
    
    if (!this.port.readable || !this.port.writable) {
        throw new Error("Elecraft serial port opened but readable/writable streams are unavailable. Ensure another app is not using this port.");
    }
    
    try {
        if (this.port && typeof this.port.setSignals === 'function') {
            await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
            console.log("[CatManager] Forced Elecraft RTS & DTR OFF on connect");
        }
    } catch (sigErr) {
        console.warn("[CatManager] Failed to set signals on connect:", sigErr);
    }
    
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.isActive = true;
    
    // Start continuous read loop
    this.readLoop();
  }

  async readLoop() {
    try {
      while (this.isActive) {
        const { value, done } = await this.reader.read();
        if (done || !this.isActive) break;
        if (value) {
          const text = this.decoder.decode(value);
          this.buffer += text;
          let semiIndex;
          // Commands are semicolon terminated
          while ((semiIndex = this.buffer.indexOf(';')) !== -1) {
            const msg = this.buffer.substring(0, semiIndex + 1); // include ';'
            this.buffer = this.buffer.substring(semiIndex + 1);
            this.handleMessage(msg);
          }
        }
      }
    } catch (e) {
      if (this.isActive) {
        console.error("Elecraft Read Loop Error:", e);
      }
    }
  }

  handleMessage(msg) {
    // e.g., FA00014074000;
    if (msg.startsWith("FA") && msg.length >= 13) {
      const freqStr = msg.substring(2, 13);
      const freq = parseInt(freqStr, 10);
      if (!this.vfoOffset || this.vfoOffset === 0) {
        this.rxFrequency = freq;
      }
      if (this.pendingFreqResolvers.length > 0) {
        const resolve = this.pendingFreqResolvers.shift();
        resolve(freq);
      }
    }
  }

  async setFrequency(freqHz) {
    this.rxFrequency = freqHz; // Store the baseline RX frequency
    if (!this.writer) return;
    // FA needs 11 digits padded with leading zeros
    const freqStr = freqHz.toString().padStart(11, '0');
    await this.writer.write(this.encoder.encode(`FA${freqStr};`));
  }

  async setTx(isTxActive, userAudioFreq = 1500) {
    if (!this.writer) return isTxActive ? userAudioFreq : null;
    
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    if (isTxActive) {
      // 1. Calculate vfoOffset and txAudioFreq
      const vfoOffset = Math.round((userAudioFreq - 1500) / 500) * 500;
      const txAudioFreq = userAudioFreq - vfoOffset;
      const txVfoFreq = this.rxFrequency + vfoOffset;

      // 2. Store offset state
      this.vfoOffset = vfoOffset;

      // 3. Command radio to retune VFO if offset is not 0
      if (this.vfoOffset !== 0) {
        const freqStr = txVfoFreq.toString().padStart(11, '0');
        await this.writer.write(this.encoder.encode(`FA${freqStr};`));
      }

      // 4. Minor hardware settling delay
      await sleep(50);

      // 5. Send PTT command to start transmitting
      await this.writer.write(this.encoder.encode('TX;'));

      // 6. Return recalculated audio frequency
      return txAudioFreq;
    } else {
      // 1. Immediately stop transmitting
      await this.writer.write(this.encoder.encode('RX;'));

      // 2. If vfoOffset was not 0, delay and retune back
      if (this.vfoOffset !== 0) {
        await sleep(50);
        const freqStr = this.rxFrequency.toString().padStart(11, '0');
        await this.writer.write(this.encoder.encode(`FA${freqStr};`));
      }

      // 3. Reset offset state
      this.vfoOffset = 0;

      return null;
    }
  }

  async getFrequency() {
    if (!this.writer) {
      return Promise.reject(new Error("Elecraft port is not connected"));
    }
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      try {
        await this.writer.write(this.encoder.encode('FA;'));
      } catch (writeErr) {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) this.pendingFreqResolvers.splice(idx, 1);
        reject(writeErr);
        return;
      }
      // Time-out if radio disconnected or unresponsive
      setTimeout(() => {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) {
          this.pendingFreqResolvers.splice(idx, 1);
          reject(new Error("Timeout reading Elecraft frequency"));
        }
      }, 1500);
    });
  }

  async disconnect() {
    this.isActive = false;
    if (!this.port) return;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch (e) {
      console.warn("Elecraft release lock error (reader):", e);
    }
    try {
      if (this.writer) {
        this.writer.releaseLock();
      }
    } catch (e) {
      console.warn("Elecraft release lock error (writer):", e);
    }
    try {
      if (this.port.readable || this.port.writable) {
        await this.port.close().catch(() => {});
      }
    } catch (e) {
      console.warn("Elecraft port close error:", e);
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
  }
}

// ---------------------------------------------------------
// Master Controller API
// ---------------------------------------------------------
export default class CatManager {
  /**
   * @param {Object} config 
   * @param {string} config.mode - 'manual', 'kenwood', 'qdx', or 'icom'
   * @param {number} config.icomAddress - Hex address for the target ICOM radio (e.g. 0x94)
   */
  constructor(config = {}) {
    this.mode = config.mode || 'manual';
    const icomAddress = config.icomAddress || 0x94;
    const baudRate = config.baudRate;

    switch (this.mode.toLowerCase()) {
      case 'kenwood':
        this.driver = new KenwoodDriver(baudRate || 38400);
        break;
      case 'yaesu':
        this.driver = new YaesuDriver(baudRate || 38400);
        break;
      case 'old-yaesu':
        this.driver = new OldYaesuDriver(baudRate || 4800);
        break;
      case 'elecraft':
        this.driver = new ElecraftDriver(baudRate || 38400);
        break;
      case 'qdx':
        this.driver = new QDXDriver(baudRate || 57600);
        break;
      case 'icom':
        this.driver = new IcomDriver(icomAddress, baudRate || 115200);
        break;
      case 'manual':
      default:
        this.driver = new ManualDriver();
        break;
    }
  }

  /**
   * Initializes the serial connection (if required by mode).
   * @param {SerialPort} serialPort - A Web Serial API port instance
   */
  async connect(serialPort) {
    await this.driver.connect(serialPort);
  }

  /**
   * Changes the radio's VFO frequency.
   * @param {number} frequencyHz 
   */
  async setFrequency(frequencyHz) {
    await this.driver.setFrequency(frequencyHz);
  }

  /**
   * Toggles PTT (Transmit/Receive) with split.
   * @param {boolean} isTxActive 
   * @param {number} userAudioFreq 
   * @returns {Promise<number|null>}
   */
  async setTx(isTxActive, userAudioFreq = 1500) {
    return await this.driver.setTx(isTxActive, userAudioFreq);
  }

  /**
   * Requests the current frequency from the radio.
   * @returns {Promise<number>} - Frequency in Hz
   */
  async getFrequency() {
    return await this.driver.getFrequency();
  }

  /**
   * Closes the active port and releases stream locks.
   */
  async disconnect() {
    if (this.driver && typeof this.driver.disconnect === 'function') {
      await this.driver.disconnect();
    }
  }
}
