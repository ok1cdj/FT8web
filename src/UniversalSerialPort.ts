export interface SerialOptions {
  baudRate: number;
}

export interface UniversalSerialPortInstance {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { requestToSend?: boolean, dataTerminalReady?: boolean }): Promise<void>;
}

// -------------------------------------------------------------
// Native Wrapper (PC Mode)
// -------------------------------------------------------------
class NativeSerialPortWrapper implements UniversalSerialPortInstance {
  constructor(private port: any) {}
  
  get readable() { return this.port.readable; }
  get writable() { return this.port.writable; }
  
  async open(options: SerialOptions) {
    await this.port.open(options);
  }
  
  async close() {
    await this.port.close();
  }
  
  async setSignals(signals: any) {
    if (this.port.setSignals) {
      await this.port.setSignals(signals);
    }
  }
}

// -------------------------------------------------------------
// WebUSB Custom Fallback (Android Mode)
// -------------------------------------------------------------
class AndroidWebUsbPortWrapper implements UniversalSerialPortInstance {
  public readable: ReadableStream<Uint8Array> | null = null;
  public writable: WritableStream<Uint8Array> | null = null;
  
  private endpointIn: number = 0;
  private endpointOut: number = 0;
  private isReading: boolean = false;
  private interfaceNumber: number = 0;

  constructor(private device: any) {}

  async open(options: SerialOptions) {
    await this.device.open();
    
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }
    
    const conf = this.device.configuration;
    if (!conf) throw new Error("No USB configuration found");
    
    for (const iface of conf.interfaces) {
      const alt = iface.alternates[0];
      let epIn, epOut;
      for (const ep of alt.endpoints) {
        if (ep.direction === 'in' && ep.type === 'bulk') epIn = ep.endpointNumber;
        if (ep.direction === 'out' && ep.type === 'bulk') epOut = ep.endpointNumber;
      }
      if (epIn && epOut) {
        this.endpointIn = epIn;
        this.endpointOut = epOut;
        this.interfaceNumber = iface.interfaceNumber;
        break;
      }
    }
    
    if (!this.endpointIn || !this.endpointOut) {
      throw new Error("Could not find bulk in/out endpoints");
    }
    
    await this.device.claimInterface(this.interfaceNumber);
    await this.initializeDriver(options.baudRate);
    this.setupStreams();
  }
  
  private async initializeDriver(baudRate: number) {
    const vid = this.device.vendorId;
    
    if (vid === 0x10C4) {
      // Silicon Labs CP210x
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: 0x00, value: 0x01, index: this.interfaceNumber }); // Enable UART
      const baudData = new Uint8Array(4);
      new DataView(baudData.buffer).setUint32(0, baudRate, true);
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: 0x1E, value: 0, index: this.interfaceNumber }, baudData); // Set baud rate
    } else if (vid === 0x1A86) {
      // Qinheng CH34x
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0xA1, value: 0, index: 0 }); 
      
      let baseValue, baseIndex;
      if (baudRate === 9600) { baseValue = 0xB202; baseIndex = 0x0008; }
      else if (baudRate === 38400) { baseValue = 0x6403; baseIndex = 0x0008; }
      else if (baudRate === 115200) { baseValue = 0xCC03; baseIndex = 0x0008; }
      else { baseValue = 0xCC03; baseIndex = 0x0008; } // Default 115200

      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x9A, value: 0x1312, index: baseValue });
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x9A, value: 0x0F2C, index: baseIndex });
    } else if (vid === 0x0403) {
      // FTDI
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x00, value: 0, index: 0 }); // Reset
      let divisor = 3000000 / baudRate;
      let bestDivisor = Math.floor(divisor);
      let floatPart = divisor - bestDivisor;
      let val = 0;
      if (floatPart >= 0.875) { bestDivisor++; }
      else if (floatPart >= 0.625) { val = 1; }
      else if (floatPart >= 0.375) { val = 2; }
      else if (floatPart >= 0.125) { val = 3; }
      let ftValue = (bestDivisor & 0xFFFF) | (val << 14);
      let ftIndex = (bestDivisor >> 16) & 0xFFFF;
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x03, value: ftValue, index: ftIndex }); 
    } else if (vid === 0x067B) {
      // Prolific PL2303
      await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x8484, index: 0 }, 1);
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x0404, index: 0 });
      await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x8484, index: 0 }, 1);
      await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x8383, index: 0 }, 1);
      await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x8484, index: 0 }, 1);
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x0404, index: 1 });
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x0404, index: 0 });
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x01, value: 0x0000, index: 1 });
      const lineData = new Uint8Array(7);
      new DataView(lineData.buffer).setUint32(0, baudRate, true);
      lineData[4] = 0; // 1 stop
      lineData[5] = 0; // no parity
      lineData[6] = 8; // 8 bits
      await this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: this.interfaceNumber }, lineData);
    }
  }
  
  private setupStreams() {
    this.isReading = true;
    
    this.readable = new ReadableStream({
      start: (controller) => {
        this.readLoop(controller);
      },
      cancel: () => {
        this.isReading = false;
      }
    });
    
    this.writable = new WritableStream({
      write: async (chunk) => {
        await this.device.transferOut(this.endpointOut, chunk);
      }
    });
  }
  
  private async readLoop(controller: ReadableStreamDefaultController) {
    while (this.isReading && this.device.opened) {
      try {
        const result = await this.device.transferIn(this.endpointIn, 64);
        if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
          const chunk = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
          if (this.device.vendorId === 0x0403) { // FTDI
            if (chunk.length > 2) {
               controller.enqueue(chunk.slice(2));
            }
          } else {
             controller.enqueue(chunk);
          }
        }
      } catch (e) {
        if (this.isReading) {
          console.error("WebUSB read error:", e);
          controller.error(e);
          this.isReading = false;
        }
        break;
      }
    }
  }

  async close() {
    this.isReading = false;
    if (this.device.opened) {
       await this.device.releaseInterface(this.interfaceNumber);
       await this.device.close();
    }
  }
  
  async setSignals(signals: { requestToSend?: boolean, dataTerminalReady?: boolean }) {
    if (!this.device.opened) return;
    const vid = this.device.vendorId;
    let dtr = signals.dataTerminalReady;
    let rts = signals.requestToSend;
    
    if (vid === 0x10C4) {
      let value = 0;
      if (dtr !== undefined) value |= (dtr ? 0x0101 : 0x0100);
      if (rts !== undefined) value |= (rts ? 0x0202 : 0x0200);
      if (value !== 0) {
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: 0x07, value, index: this.interfaceNumber });
      }
    } else if (vid === 0x1A86) {
      let mcr = 0;
      if (dtr) mcr |= 0x20;
      if (rts) mcr |= 0x40;
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0xA4, value: ~mcr & 0x60, index: 0 });
    } else if (vid === 0x0403) {
      if (dtr !== undefined) await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x01, value: dtr ? 0x0101 : 0x0100, index: 0 });
      if (rts !== undefined) await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x01, value: rts ? 0x0202 : 0x0200, index: 0 });
    } else if (vid === 0x067B) {
      let value = 0;
      if (dtr) value |= 0x01;
      if (rts) value |= 0x02;
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x22, value, index: this.interfaceNumber });
    }
  }
}

export class UniversalSerialPort {
  static async requestPort(options: { filters: any[] }): Promise<UniversalSerialPortInstance> {
    const isAndroid = /Android/i.test(navigator.userAgent);
    
    if (!isAndroid && (navigator as any).serial) {
      const port = await (navigator as any).serial.requestPort(options);
      return new NativeSerialPortWrapper(port);
    }
    
    if ((navigator as any).usb) {
      const usbFilters = options.filters.map(f => ({
        vendorId: f.vendorId || f.usbVendorId
      }));
      const device = await (navigator as any).usb.requestDevice({ filters: usbFilters });
      return new AndroidWebUsbPortWrapper(device);
    }
    
    throw new Error('No Native Serial or WebUSB API available');
  }
}
