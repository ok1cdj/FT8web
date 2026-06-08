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
  async setTx(isTxActive) {
    // Safely resolve immediately
    return Promise.resolve();
  }
  async getFrequency() {
    // Doesn't interact with hardware
    return Promise.resolve(0);
  }
}

// ---------------------------------------------------------
// Variant B: Kenwood (ASCII Protocol)
// ---------------------------------------------------------
class KenwoodDriver {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.pendingFreqResolvers = [];
  }

  async connect(port) {
    this.port = port;
    if (!this.port.readable) {
        try {
            // Kenwood preferred baud rates are typically 38400 or 57600
            await this.port.open({ baudRate: 57600 });
        } catch (e) {
            console.log("Kenwood Port: ", e);
        }
    }
    
    // Implement Text encoder/decoder for ASCII stream
    this.textDecoder = new TextDecoderStream();
    this.readClosed = this.port.readable.pipeTo(this.textDecoder.writable);
    this.reader = this.textDecoder.readable.getReader();

    this.textEncoder = new TextEncoderStream();
    this.writeClosed = this.textEncoder.readable.pipeTo(this.port.writable);
    this.writer = this.textEncoder.writable.getWriter();
    
    // Start continuous read loop
    this.readLoop();
  }

  async readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.buffer += value;
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
      console.error("Kenwood Read Loop Error:", e);
    }
  }

  handleMessage(msg) {
    // e.g., FA00014074000;
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
    // FA needs 11 digits padded with leading zeros
    const freqStr = freqHz.toString().padStart(11, '0');
    await this.writer.write(`FA${freqStr};`);
  }

  async setTx(isTxActive) {
    if (isTxActive) {
      await this.writer.write('TX;');
    } else {
      await this.writer.write('RX;');
    }
  }

  async getFrequency() {
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      await this.writer.write('FA;');
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
}

// ---------------------------------------------------------
// Variant C: Icom (CI-V Binary Protocol)
// ---------------------------------------------------------
class IcomDriver {
  constructor(targetAddress = 0x94) {
    this.targetAddress = targetAddress; // IC-7300 default is 0x94, IC-705 is 0xA4
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = [];
    this.lastTransmittedBytes = [];
    this.pendingFreqResolvers = [];
  }

  async connect(port) {
    this.port = port;
    if (!this.port.readable) {
        try {
            await this.port.open({ baudRate: 115200 }); // Standard modern Icom rate
        } catch (e) {
            console.log("Icom Port:", e);
        }
    }
    
    // ICOM relies purely on raw binary bytes (Uint8Array)
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoop();
  }

  async readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          // Push received bytes to rolling buffer
          for (let i = 0; i < value.length; i++) {
            this.buffer.push(value[i]);
          }
          this.processBuffer();
        }
      }
    } catch (e) {
      console.error("Icom Read Loop Error:", e);
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
        if (this.pendingFreqResolvers.length > 0) {
          const resolve = this.pendingFreqResolvers.shift();
          resolve(freq);
        }
    }
  }

  async sendFrame(cmd, subCmd, dataBytes = []) {
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
    const bcd = freqToBCD(freqHz);
    // Command 0x05: Set frequency. No sub-command.
    await this.sendFrame(0x05, null, bcd);
  }

  async setTx(isTxActive) {
    const actionByte = isTxActive ? 0x01 : 0x00;
    // Command 0x1C: Transceiver Control. Sub 0x00: Transmit.
    await this.sendFrame(0x1C, 0x00, [actionByte]);
  }

  async getFrequency() {
    return new Promise(async (resolve, reject) => {
      this.pendingFreqResolvers.push(resolve);
      
      // Command 0x03: Request operating frequency
      await this.sendFrame(0x03, null, []);
      
      setTimeout(() => {
        const idx = this.pendingFreqResolvers.indexOf(resolve);
        if (idx > -1) {
          this.pendingFreqResolvers.splice(idx, 1);
          reject(new Error("Timeout reading Icom CI-V frequency"));
        }
      }, 1500);
    });
  }
}

// ---------------------------------------------------------
// Master Controller API
// ---------------------------------------------------------
export default class CatManager {
  /**
   * @param {Object} config 
   * @param {string} config.mode - 'manual', 'kenwood', or 'icom'
   * @param {number} config.icomAddress - Hex address for the target ICOM radio (e.g. 0x94)
   */
  constructor(config = {}) {
    this.mode = config.mode || 'manual';
    const icomAddress = config.icomAddress || 0x94;

    switch (this.mode.toLowerCase()) {
      case 'kenwood':
        this.driver = new KenwoodDriver();
        break;
      case 'icom':
        this.driver = new IcomDriver(icomAddress);
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
   * Toggles PTT (Transmit/Receive).
   * @param {boolean} isTxActive 
   */
  async setTx(isTxActive) {
    await this.driver.setTx(isTxActive);
  }

  /**
   * Requests the current frequency from the radio.
   * @returns {Promise<number>} - Frequency in Hz
   */
  async getFrequency() {
    return await this.driver.getFrequency();
  }
}
