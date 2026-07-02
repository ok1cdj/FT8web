import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, Settings, X, HelpCircle } from 'lucide-react';
import { getCaptureWorkletUrl } from './AudioWorkletBlob';
import { encodeFT8, encodeFT4 } from '@e04/ft8ts';
import CatManager from './CatManager.js';
import { UniversalSerialPort } from './UniversalSerialPort';
import FT8FSM, { QueuedCaller } from './FT8FSM';

import { LogBookViewer } from './components/LogBookViewer';
import { VersionInfo } from './components/VersionInfo';
import { logBook, QSO } from './LogBook';
import { CloudLogService } from './services/CloudLogService';
import { LogbookService } from './services/LogbookService';
import { dxccService } from './services/DxccService';

export interface FT8DecodedMessage {
  time: string;
  snr: number;
  freq: number;
  message: string;
  isDivider?: boolean;
  isTx?: boolean;
  isIncoming?: boolean;
}

function extractTransmitterCallsign(message: string): string | null {
  if (!message) return null;
  // Strip any prepended arrow indicators like "<- " or "-> "
  const cleanMsg = message.replace(/^<-?\s+/, '').replace(/^->\s+/, '').trim();
  const parts = cleanMsg.split(/\s+/).map(p => p.replace(/[<>]/g, ''));
  
  if (parts.length === 0) return null;
  
  const first = parts[0].toUpperCase();
  if (first === 'CQ' || first === 'QRZ') {
    if (parts.length >= 3) {
      const hasDigit1 = /\d/.test(parts[1]);
      const hasDigit2 = /\d/.test(parts[2]);
      if (!hasDigit1 && hasDigit2) {
        return parts[2];
      }
    }
    if (parts.length >= 2) {
      return parts[1];
    }
    return null;
  }
  
  // For standard QSOs: ADDRESSEE TRANSMITTER [REPORT/MSG]
  // The transmitter whom we hear is the second token
  if (parts.length >= 2) {
    return parts[1];
  }
  
  return parts[0] || null;
}

// --- Advisory clock-accuracy check (SNTP-style over HTTP) -------------------
// FT8 is time-critical. Browsers can't read the system NTP daemon or set the
// clock, so we measure the device-clock offset against a trusted HTTP time
// source and only DISPLAY a status. The fix for bad drift is to correct the
// device clock, which is what every timing path in this app already relies on.
export type ClockStatus = 'ok' | 'warn' | 'bad' | 'unknown';

export interface ClockVerdict {
  status: ClockStatus;
  offsetMs: number;
  message: string;
}

// Time source: the app's OWN origin. We read the server's `Date` response
// header — no CORS, no third-party dependency, and the service worker passes
// same-origin requests fine. Resolution is 1 second, which is exactly right for
// an advisory "is the clock badly wrong?" check.
async function sampleClockOffset(): Promise<{ offsetMs: number; uncertaintyMs: number }> {
  const tx = Date.now();
  // Cache-buster + no-store → forces a fresh network response whose `Date`
  // header is the server's current UTC time (not a cached value).
  const res = await fetch(`/?_t=${tx}`, { method: 'GET', cache: 'no-store' });
  const rx = Date.now();
  const dateHeader = res.headers.get('date');
  if (!dateHeader) throw new Error('no Date header');
  const serverMs = Date.parse(dateHeader);           // truncated to whole second
  if (!Number.isFinite(serverMs)) throw new Error('bad Date header');
  const rtt = rx - tx;
  // +500ms: the header floors to the second, so the true instant is ~mid-second.
  return { offsetMs: serverMs + 500 - (tx + rtt / 2), uncertaintyMs: rtt / 2 + 500 };
}

async function checkClock(): Promise<ClockVerdict> {
  let best: { offsetMs: number; uncertaintyMs: number } | null = null;
  try {
    for (let i = 0; i < 5; i++) {
      const s = await sampleClockOffset();             // keep the lowest-jitter sample
      if (!best || s.uncertaintyMs < best.uncertaintyMs) best = s;
    }
  } catch {
    return { status: 'unknown', offsetMs: 0, message: 'Time check unavailable' };
  }
  if (!best) return { status: 'unknown', offsetMs: 0, message: 'Time check unavailable' };

  const drift = Math.abs(best.offsetMs);
  const sign = best.offsetMs >= 0 ? '+' : '\u2212';
  const offsetStr = `${sign}${(drift / 1000).toFixed(2)}s`;

  // Thresholds match a ~1s-resolution source and FT8 tolerance: <1s fine,
  // 1-2s decoding degrades, >2s won't decode. Guard avoids false warnings.
  if (drift <= Math.max(best.uncertaintyMs, 50) || drift < 1000) {
    return { status: 'ok', offsetMs: best.offsetMs, message: `Clock OK (${offsetStr})` };
  }
  if (drift < 2000) {
    return { status: 'warn', offsetMs: best.offsetMs, message: `Off ${offsetStr} \u2014 watch it` };
  }
  return { status: 'bad', offsetMs: best.offsetMs, message: `Off ${offsetStr} \u2014 fix device clock` };
}

export default function App() {
  const BAND_FREQS_FT8 = [
    { label: '80m', mhz: '3.5', hz: 3573000 },
    { label: '40m', mhz: '7.0', hz: 7074000 },
    { label: '30m', mhz: '10.1', hz: 10136000 },
    { label: '20m', mhz: '14.0', hz: 14074000 },
    { label: '17m', mhz: '18.1', hz: 18100000 },
    { label: '15m', mhz: '21.0', hz: 21074000 },
    { label: '12m', mhz: '24.9', hz: 24915000 },
    { label: '10m', mhz: '28.0', hz: 28074000 },
    { label: '6m', mhz: '50.3', hz: 50313000 },
    { label: '2m', mhz: '144.1', hz: 144174000 },
    { label: '70cm', mhz: '432.1', hz: 432174000 },
    { label: '23cm', mhz: '1296.1', hz: 1296174000 }
  ];

  const BAND_FREQS_FT4 = [
    { label: '80m', mhz: '3.5', hz: 3575000 },
    { label: '40m', mhz: '7.0', hz: 7047500 },
    { label: '30m', mhz: '10.1', hz: 10140000 },
    { label: '20m', mhz: '14.0', hz: 14080000 },
    { label: '17m', mhz: '18.1', hz: 18104000 },
    { label: '15m', mhz: '21.1', hz: 21140000 },
    { label: '12m', mhz: '24.9', hz: 24919000 },
    { label: '10m', mhz: '28.1', hz: 28180000 },
    { label: '6m',  mhz: '50.3', hz: 50318000 },
    { label: '2m',  mhz: '144.1', hz: 144170000 }
  ];

  const [vfoFreq, setVfoFreq] = useState<number>(() => {
    const saved = localStorage.getItem('ft8_vfoFreq');
    return saved ? Number(saved) : 14074000;
  });
  const [editingVfo, setEditingVfo] = useState(false);
  const [vfoInputStr, setVfoInputStr] = useState('');

  useEffect(() => {
    localStorage.setItem('ft8_vfoFreq', vfoFreq.toString());
  }, [vfoFreq]);

  const [txPeriod, setTxPeriod] = useState<number>(() => {
    const saved = localStorage.getItem('ft8_txPeriod');
    return saved !== null ? Number(saved) : 0; // 0 = Even, 1 = Odd
  });

  useEffect(() => {
    localStorage.setItem('ft8_txPeriod', txPeriod.toString());
  }, [txPeriod]);

  const [mode, setMode] = useState<'FT8' | 'FT4'>(() =>
    (localStorage.getItem('ft8_mode') as 'FT8' | 'FT4') || 'FT8'
  );
  useEffect(() => { localStorage.setItem('ft8_mode', mode); }, [mode]);

  const BAND_FREQS = mode === 'FT4' ? BAND_FREQS_FT4 : BAND_FREQS_FT8;

  // Global Audio State
  const [audioActive, setAudioActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [utcTime, setUtcTime] = useState('00:00:00');
  const [windowProgress, setWindowProgress] = useState(0);
  const [clockVerdict, setClockVerdict] = useState<ClockVerdict>({ status: 'unknown', offsetMs: 0, message: 'Checking\u2026' });
  
  // Device Selection State
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => localStorage.getItem('ft8_audioInputId') || '');
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<string>(() => localStorage.getItem('ft8_audioOutputId') || 'default');

  useEffect(() => {
    localStorage.setItem('ft8_audioInputId', selectedDeviceId);
    localStorage.setItem('ft8_audioOutputId', selectedOutputDeviceId);
  }, [selectedDeviceId, selectedOutputDeviceId]);

  // Advisory clock-accuracy check: measures device-clock drift vs a trusted
  // network source and updates the status light. Never sets the system clock.
  useEffect(() => {
    let alive = true;
    const run = () => { checkClock().then(v => { if (alive) setClockVerdict(v); }); };

    run();                                            // on mount
    const hourly = setInterval(run, 60 * 60 * 1000);  // hourly backstop

    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', run);           // network restored

    // Wake-from-sleep watchdog: a >35s gap between 30s ticks means the device
    // suspended; uses only the delta, so it works even if the clock is wrong.
    let last = Date.now();
    const wake = setInterval(() => {
      const now = Date.now();
      if (now - last > 35000) run();
      last = now;
    }, 30000);

    return () => {
      alive = false;
      clearInterval(hourly);
      clearInterval(wake);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', run);
    };
  }, []);
  
  // Station Configuration State
  const [myCall, setMyCall] = useState<string>(() => localStorage.getItem('ft8_myCall') || 'N0TMP');
  const [myGrid, setMyGrid] = useState<string>(() => localStorage.getItem('ft8_myGrid') || 'EM12');
  const [txFreq, setTxFreq] = useState<number>(() => {
      const saved = localStorage.getItem('ft8_txFreq');
      return saved ? Number(saved) : 1500;
  }); // Default TX offset
  const [decodeDepth, setDecodeDepth] = useState<number>(() => {
      const saved = localStorage.getItem('ft8_decodeDepth');
      return saved ? Number(saved) : 2;
  });
  const [maxRetries, setMaxRetries] = useState<number>(() => {
      const saved = localStorage.getItem('ft8_maxRetries');
      return saved ? Number(saved) : 4;
  });
  const [finalMessageMode, setFinalMessageMode] = useState<'RR73'|'RRR'>(() => {
      return (localStorage.getItem('ft8_finalMessageMode') as 'RR73'|'RRR') || 'RR73';
  });

  // Keep a Set of callsigns worked before on the current band & mode
  const [workedCallsigns, setWorkedCallsigns] = useState<Set<string>>(new Set());
  const [dxccReady, setDxccReady] = useState(false);
  const [workedDxccEntities, setWorkedDxccEntities] = useState<Set<number>>(new Set());

  // Helper to determine band from VFO frequency
  const getBandFromFreq = useCallback((freqInHz: number): string => {
      const mhz = freqInHz / 1e6;
      if (mhz >= 1.8 && mhz <= 2.0) return "160m";
      if (mhz >= 3.5 && mhz <= 4.0) return "80m";
      if (mhz >= 5.3 && mhz <= 5.4) return "60m";
      if (mhz >= 7.0 && mhz <= 7.3) return "40m";
      if (mhz >= 10.1 && mhz <= 10.2) return "30m";
      if (mhz >= 14.0 && mhz <= 14.35) return "20m";
      if (mhz >= 18.068 && mhz <= 18.168) return "17m";
      if (mhz >= 21.0 && mhz <= 21.45) return "15m";
      if (mhz >= 24.89 && mhz <= 24.99) return "12m";
      if (mhz >= 28.0 && mhz <= 29.7) return "10m";
      if (mhz >= 50.0 && mhz <= 54.0) return "6m";
      return "";
  }, []);

  const loadWorkedCallsigns = useCallback(async () => {
    const currentBand = getBandFromFreq(vfoFreq);
    const set = await LogbookService.getWorkedCallsigns(currentBand, mode);
    setWorkedCallsigns(set);
  }, [vfoFreq, getBandFromFreq, mode]);

  useEffect(() => {
    loadWorkedCallsigns();
  }, [loadWorkedCallsigns]);

  useEffect(() => {
    const handleQsoChange = () => {
      loadWorkedCallsigns();
    };
    window.addEventListener('qso-logged', handleQsoChange);
    return () => {
      window.removeEventListener('qso-logged', handleQsoChange);
    };
  }, [loadWorkedCallsigns]);

  const backfillDxcc = async (): Promise<void> => {
    const qsos = await logBook.getAllQSOs();
    for (const qso of qsos) {
      if (qso.dxcc === undefined) {
        const entity = dxccService.lookup(qso.call);
        if (entity) await logBook.updateQSO({ ...qso, dxcc: entity.adifCode }).catch(() => {});
      }
    }
  };

  const loadWorkedDxccEntities = useCallback(async () => {
    if (!dxccService.loaded) return;
    const currentBand = getBandFromFreq(vfoFreq);
    const qsos = await logBook.getAllQSOs();
    const worked = new Set<number>();
    for (const qso of qsos) {
      const qsoBand = (qso.band || '').trim().toUpperCase();
      const qsoMode = (qso.mode || '').trim().toUpperCase();
      if (qsoBand !== currentBand.toUpperCase() || qsoMode !== mode.toUpperCase()) continue;
      const code = qso.dxcc ?? dxccService.lookup(qso.call)?.adifCode;
      if (code && code > 0) worked.add(code);
    }
    setWorkedDxccEntities(worked);
  }, [vfoFreq, getBandFromFreq, mode]);

  useEffect(() => {
    dxccService.load().then(async () => {
      if (!dxccService.loaded) { setDxccReady(true); return; }
      try {
        await backfillDxcc();
        await loadWorkedDxccEntities();
      } catch (e) {
        console.warn('[DXCC] Init failed:', e);
      }
      setDxccReady(true);
    });
  }, []);

  useEffect(() => {
    if (!dxccReady) return;
    loadWorkedDxccEntities();
  }, [loadWorkedDxccEntities, dxccReady]);

  useEffect(() => {
    if (!dxccReady) return;
    window.addEventListener('qso-logged', loadWorkedDxccEntities);
    return () => window.removeEventListener('qso-logged', loadWorkedDxccEntities);
  }, [loadWorkedDxccEntities, dxccReady]);

  const [catMode, setCatMode] = useState<'manual'|'kenwood'|'yaesu'|'old-yaesu'|'elecraft'|'qdx'|'icom'>(() => {
    const saved = localStorage.getItem('ft8_catMode') as 'manual'|'kenwood'|'yaesu'|'old-yaesu'|'elecraft'|'qdx'|'icom';
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (isAndroid && saved === 'qdx') {
      return 'manual';
    }
    return saved || 'manual';
  });
  const [catBaudRate, setCatBaudRate] = useState<number>(() => {
    const saved = localStorage.getItem('ft8_catBaudRate');
    return saved ? Number(saved) : 38400;
  });
  const [icomAddress, setIcomAddress] = useState<string>(() => {
    return localStorage.getItem('ft8_icomAddress') || '94';
  });
  const [cp2105Channel, setCp2105Channel] = useState<0 | 1>(() => {
    return (Number(localStorage.getItem('ft8_cp2105Channel')) || 0) as 0 | 1;
  });
  const [isDualPort, setIsDualPort] = useState<boolean>(false);

  const [maxLogEntries, setMaxLogEntries] = useState<number>(() => {
    const saved = localStorage.getItem('ft8_maxLogEntries');
    return saved ? Number(saved) : 50;
  });

  const [wavelogEnabled, setWavelogEnabled] = useState<boolean>(() => {
    return localStorage.getItem('ft8_wavelogEnabled') === 'true';
  });
  const [wavelogUrl, setWavelogUrl] = useState<string>(() => {
    return localStorage.getItem('ft8_wavelogUrl') || '';
  });
  const [wavelogApiKey, setWavelogApiKey] = useState<string>(() => {
    return localStorage.getItem('ft8_wavelogApiKey') || '';
  });
  const [wavelogStationProfileId, setWavelogStationProfileId] = useState<string>(() => {
    return localStorage.getItem('ft8_wavelogStationProfileId') || '';
  });

  const [decodeStats, setDecodeStats] = useState<{ count: number, durationMs: number } | null>(null);

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('ft8_theme') as 'dark' | 'light') || 'dark';
  });

  const [wakeLockEnabled, setWakeLockEnabled] = useState<boolean>(() => {
    return localStorage.getItem('ft8_wakelock') === 'true';
  });
  
  useEffect(() => {
    localStorage.setItem('ft8_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('ft8_wakelock', String(wakeLockEnabled));
    let wakeLock: any = null;
    let isMounted = true;
    
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && wakeLockEnabled) {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        console.error('Wake Lock request failed:', err);
      }
    };

    if (wakeLockEnabled) {
      requestWakeLock();
      
      const handleVisibilityChange = () => {
        if (wakeLock !== null && document.visibilityState === 'visible') {
           requestWakeLock();
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      
      return () => {
        isMounted = false;
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        if (wakeLock !== null) {
          wakeLock.release().catch(console.error);
        }
      }
    }
  }, [wakeLockEnabled]);

  useEffect(() => {
      localStorage.setItem('ft8_myCall', myCall);
      localStorage.setItem('ft8_myGrid', myGrid);
      localStorage.setItem('ft8_txFreq', txFreq.toString());
      localStorage.setItem('ft8_decodeDepth', decodeDepth.toString());
      localStorage.setItem('ft8_maxRetries', maxRetries.toString());
      localStorage.setItem('ft8_finalMessageMode', finalMessageMode);
      localStorage.setItem('ft8_catMode', catMode);
      localStorage.setItem('ft8_catBaudRate', catBaudRate.toString());
      localStorage.setItem('ft8_icomAddress', icomAddress);
      localStorage.setItem('ft8_cp2105Channel', cp2105Channel.toString());
      localStorage.setItem('ft8_maxLogEntries', maxLogEntries.toString());
      localStorage.setItem('ft8_wavelogEnabled', String(wavelogEnabled));
      localStorage.setItem('ft8_wavelogUrl', wavelogUrl);
      localStorage.setItem('ft8_wavelogApiKey', wavelogApiKey);
      localStorage.setItem('ft8_wavelogStationProfileId', wavelogStationProfileId);
  }, [myCall, myGrid, txFreq, decodeDepth, maxRetries, finalMessageMode, catMode, catBaudRate, icomAddress, cp2105Channel, maxLogEntries, wavelogEnabled, wavelogUrl, wavelogApiKey, wavelogStationProfileId]);

  // UI State
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [serialPort, setSerialPort] = useState<any>(null);
  const [catTestResult, setCatTestResult] = useState<string | null>(null);
  const [catConnected, setCatConnected] = useState<boolean>(false);
  const vfoFreqRef = useRef(14074000);
  
  useEffect(() => {
    vfoFreqRef.current = vfoFreq;
  }, [vfoFreq]);

  const catRef = useRef<CatManager | null>(null);

  // Auto-connect to previously permitted serial port if any
  useEffect(() => {
    if ('serial' in navigator && catMode !== 'manual') {
      (navigator as any).serial.getPorts().then((ports: any[]) => {
        if (ports.length > 0) {
          setSerialPort(ports[0]);
        }
      }).catch(console.error);
    }
  }, []);

  const initCatManager = async (port: any) => {
    try {
      const parsedAddr = parseInt(icomAddress, 16);
      const cat = new CatManager({ 
        mode: catMode, 
        icomAddress: isNaN(parsedAddr) ? 0x94 : parsedAddr,
        baudRate: catBaudRate
      } as any);
      await cat.connect(port);
      catRef.current = cat;
      setCatConnected(true);
      return cat;
    } catch (e: any) {
      console.error("CAT Init error:", e);
      setCatConnected(false);
      throw e;
    }
  };

  // Poll CAT frequency
  useEffect(() => {
    if (!serialPort || catMode === 'manual') {
      if (catRef.current) {
        catRef.current.disconnect().catch(err => console.error("Error disconnecting CAT:", err));
        catRef.current = null;
        setCatConnected(false);
      }
      return;
    }

    let interval: any;
    let isActive = true;

    const startPolling = () => {
      interval = setInterval(() => {
        if (catRef.current && isActive) {
          catRef.current.getFrequency()
            .then(freq => {
              if (freq > 0 && isActive) setVfoFreq(freq);
            })
            .catch(() => {});
        }
      }, 2000);
    };

    const init = async () => {
      // Disconnect current driver cleanly first
      if (catRef.current) {
        await catRef.current.disconnect().catch(() => {});
        catRef.current = null;
        setCatConnected(false);
      }

      if (!isActive) return;
      try {
        await initCatManager(serialPort);
        if (isActive) {
          startPolling();
        }
      } catch (err: any) {
        if (isActive) {
          setCatTestResult("Auto-init error: " + err.message);
          setCatConnected(false);
        }
      }
    };

    init();

    return () => {
      isActive = false;
      if (interval) clearInterval(interval);
      if (catRef.current) {
        const oldCat = catRef.current;
        catRef.current = null;
        setCatConnected(false);
        oldCat.disconnect().catch(err => console.error("Error disconnecting on cleanup:", err));
      }
    };
  }, [serialPort, catMode, catBaudRate, icomAddress]);

  // When the user changes the CP2105 channel while a dual-port device is already
  // selected, swap to a new wrapper using the same USB device — no picker shown.
  useEffect(() => {
    if (!isDualPort || !serialPort || !serialPort.withChannel) return;
    const newPort = serialPort.withChannel(cp2105Channel);
    if (catRef.current) {
      catRef.current.disconnect().catch(() => {});
      catRef.current = null;
    }
    setSerialPort(newPort);
  }, [cp2105Channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectBand = (hz: number) => {
    setVfoFreq(hz);
    setRxLog([]);
    setQsoLog([]);
    if (catRef.current && catMode !== 'manual') {
      catRef.current.setFrequency(hz).catch(e => console.error("CAT Set Freq Error:", e));
    }
  };

  const commitVfoInput = () => {
    setEditingVfo(false);
    const mhz = parseFloat(vfoInputStr.replace(',', '.'));
    if (!isNaN(mhz) && mhz >= 1 && mhz <= 450) {
      selectBand(Math.round(mhz * 1_000_000));
    }
  };

  const formatFrequency = (hz: number) => {
    return hz.toLocaleString('en-US').replace(/,/g, '.') + ' Hz';
  };

  const handleSelectSerialPort = async () => {
    try {
      const serialFilters = [
        { usbVendorId: 0x10C4, vendorId: 4292 }, // Silicon Labs CP210x
        { usbVendorId: 0x1A86, vendorId: 6790 }, // Qinheng CH34x
        { usbVendorId: 0x0403, vendorId: 1027 }, // FTDI
        { usbVendorId: 0x067B, vendorId: 1659 },  // Prolific PL2303
        { usbVendorId: 0x0C26, vendorId: 3110 },  // Icom Inc. IC-7300 MKII
        { usbVendorId: 0x0483, vendorId: 1155 }   // STMicroelectronics (QDX)
      ];

      const port = await UniversalSerialPort.requestPort({ filters: serialFilters, channelIndex: cp2105Channel });

      // Cleanly disconnect old port before switching to a new selected port
      if (catRef.current) {
        await catRef.current.disconnect().catch(() => {});
        catRef.current = null;
      }

      setIsDualPort(port.isDualPort ?? false);
      setSerialPort(port);
      setCatTestResult("Port selected successfully. Ready to test.");
    } catch (e: any) {
      console.error("Failed to select serial port:", e);
      setCatTestResult(`Port selection failed: ${e.message || e}`);
    }
  };

  const handleTestCat = async () => {
    if (!serialPort) {
      setCatTestResult("Please select a serial port first.");
      return;
    }
    
    try {
      setCatTestResult("Testing connection...");
      let cat = catRef.current;
      if (!cat) {
        cat = await initCatManager(serialPort);
      }
      
      const freq = await cat.getFrequency();
      setCatTestResult(`Success! Freq: ${freq} Hz`);
      setVfoFreq(freq);
    } catch (e: any) {
      console.error("CAT Test error:", e);
      setCatTestResult("Error: " + e.message);
    }
  };
  
  // App State
  const [rxLog, setRxLog] = useState<FT8DecodedMessage[]>([]);
  const [qsoLog, setQsoLog] = useState<FT8DecodedMessage[]>([]);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const isTransmittingRef = useRef(false);
  const [isTxQueued, setIsTxQueued] = useState(false);
  
  // TX Controls State
  const [targetCall, setTargetCall] = useState('');
  const [txEnabled, setTxEnabled] = useState(false);

  // FSM State Machine Integration
  const [autoSequence, setAutoSequence] = useState<boolean>(() => {
    const saved = localStorage.getItem('ft8_autoSequence');
    return saved !== null ? saved === 'true' : true;
  });
  const [fsmState, setFsmState] = useState<string>('IDLE');
  const [fsmQueue, setFsmQueue] = useState<QueuedCaller[]>([]);
  const fsmRef = useRef<FT8FSM | null>(null);

  useEffect(() => {
    localStorage.setItem('ft8_autoSequence', String(autoSequence));
  }, [autoSequence]);

  const txFreqRef = useRef<number>(txFreq);
  useEffect(() => {
    txFreqRef.current = txFreq;
  }, [txFreq]);

  // Component unmount PTT cleanup
  useEffect(() => {
    return () => {
      if (catRef.current && catMode !== 'manual') {
        catRef.current.setTx(false).catch(() => {});
      }
    };
  }, [catMode]);

  // Cloudlog Syncing Hook
  useEffect(() => {
    const handleOnline = async () => {
      if (wavelogEnabled) {
        await CloudLogService.syncOfflineQueue({
          wavelogEnabled,
          wavelogUrl,
          wavelogApiKey,
          wavelogStationProfileId
        });
        // Trigger UI refresh
        if (typeof (window as any).refreshQsoLogbookUi === 'function') {
           (window as any).refreshQsoLogbookUi();
        }
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [wavelogEnabled, wavelogUrl, wavelogApiKey, wavelogStationProfileId]);

  // Refs for Worker Access
  const myCallRef = useRef<string>(myCall);
  const targetCallRef = useRef<string>('');
  const txPeriodRef = useRef<number>(txPeriod);
  const autoSequenceRef = useRef<boolean>(autoSequence);
  
  useEffect(() => {
    myCallRef.current = myCall;
  }, [myCall]);
  
  useEffect(() => {
    targetCallRef.current = targetCall;
  }, [targetCall]);

  useEffect(() => {
    txPeriodRef.current = txPeriod;
  }, [txPeriod]);

  const modeRef = useRef<'FT8' | 'FT4'>(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => { isTransmittingRef.current = isTransmitting; }, [isTransmitting]);

  useEffect(() => {
    autoSequenceRef.current = autoSequence;
  }, [autoSequence]);

  const wavelogEnabledRef = useRef<boolean>(wavelogEnabled);
  const wavelogUrlRef = useRef<string>(wavelogUrl);
  const wavelogApiKeyRef = useRef<string>(wavelogApiKey);
  const wavelogStationProfileIdRef = useRef<string>(wavelogStationProfileId);

  useEffect(() => {
    wavelogEnabledRef.current = wavelogEnabled;
  }, [wavelogEnabled]);

  useEffect(() => {
    wavelogUrlRef.current = wavelogUrl;
  }, [wavelogUrl]);

  useEffect(() => {
    wavelogApiKeyRef.current = wavelogApiKey;
  }, [wavelogApiKey]);

  useEffect(() => {
    wavelogStationProfileIdRef.current = wavelogStationProfileId;
  }, [wavelogStationProfileId]);

  // Core References

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const txSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const queuedTxMessageRef = useRef<string | null>(null);

  const startTx = useCallback(async (message: string) => {
    setIsTransmitting(true);
    
    // Add to QSO Log (only if not handled automatically by FSM)
    if (!autoSequenceRef.current) {
        setQsoLog(prev => {
            const now = new Date();
            const nowString = now.toISOString().substring(11, 19).replace(/:/g, '');
            return [{
                time: nowString,
                snr: 0,
                freq: txFreqRef.current,
                message: "-> " + message,
                isTx: true
            }, ...prev].slice(0, 100);
        });
    }

    let audioFreq = txFreqRef.current;
    if (catRef.current && catMode !== 'manual') {
        try {
            console.log(`[CAT TX] Keying transceiver with waterfall freq ${txFreqRef.current} Hz`);
            const retFreq = await catRef.current.setTx(true, txFreqRef.current);
            if (typeof retFreq === 'number') {
                audioFreq = retFreq;
                console.log(`[CAT TX] "Fake Split" center optimization active. Transmit audio modulated to ${audioFreq} Hz`);
            }
        } catch (err: any) {
            console.error("[CAT TX] PTT keying failed:", err);
        }
    }

    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== 'suspended') {
        if (typeof (ctx as any).setSinkId === 'function') {
            (ctx as any).setSinkId(selectedOutputDeviceId).catch((e: any) => console.error("setSinkId fail:", e));
        }
        
        try {
            const audioData = modeRef.current === 'FT4'
              ? encodeFT4(message, { sampleRate: ctx.sampleRate, baseFrequency: audioFreq })
              : encodeFT8(message, { sampleRate: ctx.sampleRate, baseFrequency: audioFreq });
            
            const audioBuffer = ctx.createBuffer(1, audioData.length, ctx.sampleRate);
            audioBuffer.copyToChannel(audioData, 0);
            
            const sourceNode = ctx.createBufferSource();
            sourceNode.buffer = audioBuffer;
            
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(1, ctx.currentTime);
            
            sourceNode.connect(gain);
            gain.connect(ctx.destination);
            
            sourceNode.start(ctx.currentTime);
            txSourceNodeRef.current = sourceNode;
            
            sourceNode.onended = () => {
                setIsTransmitting(false);
                txSourceNodeRef.current = null;
                if (catRef.current && catMode !== 'manual') {
                    console.log("[CAT TX] Transmission complete, unkeying standard...");
                    catRef.current.setTx(false).catch((err: any) => console.error("CAT setTx RX error:", err));
                }
            };
        } catch (err) {
            console.error("FT8 Encoding Error:", err);
            setIsTransmitting(false);
            if (catRef.current && catMode !== 'manual') {
                catRef.current.setTx(false).catch(() => {});
            }
        }
    } else {
        setIsTransmitting(false);
        if (catRef.current && catMode !== 'manual') {
            catRef.current.setTx(false).catch(() => {});
        }
    }
  }, [catMode, selectedOutputDeviceId]);

  // Clean up any active TX
  const stopTx = useCallback(() => {
    queuedTxMessageRef.current = null;
    if (txSourceNodeRef.current) {
        try {
            txSourceNodeRef.current.stop();
        } catch (e) {}
        try {
            txSourceNodeRef.current.disconnect();
        } catch (e) {}
        txSourceNodeRef.current = null;
    }
    setIsTransmitting(false);
    setIsTxQueued(false);
    if (catRef.current && catMode !== 'manual') {
        catRef.current.setTx(false).catch((err: any) => console.error("CAT setTx RX error:", err));
    }
  }, [catMode]);

  // Monitor txEnabled toggle for stopping TX
  useEffect(() => {
    if (!txEnabled && (isTransmitting || isTxQueued)) {
        stopTx();
    }
  }, [txEnabled, isTransmitting, isTxQueued, stopTx]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rxBufferRef = useRef<Float32Array>(new Float32Array(0));
  const workerRef = useRef<Worker | null>(null);
  const lastDrawTimeRef = useRef<number>(0);
  const waterfallRowsRef = useRef<number>(0);
  const pendingMarkersRef = useRef<{ atRow: number; label: string }[]>([]);

  const getDevices = async () => {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(d => d.kind === 'audioinput');
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        setAudioDevices(inputs);
        setAudioOutputs(outputs);
        if (inputs.length > 0) {
            setSelectedDeviceId(prev => {
                if (prev && inputs.some(a => a.deviceId === prev)) return prev;
                return inputs[0].deviceId;
            });
        }
        if (outputs.length > 0) {
            setSelectedOutputDeviceId(prev => {
                if (prev && outputs.some(a => a.deviceId === prev)) return prev;
                return 'default';
            });
        }
    } catch (err) {
        console.error("Error enumerating devices", err);
    }
  };

  // Initialize Web Worker and Devices
  useEffect(() => {
    getDevices();
    navigator.mediaDevices.addEventListener('devicechange', getDevices);

    const worker = new Worker(new URL('./ft8-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'DECODED') {
        if (e.data.durationMs !== undefined) {
            setDecodeStats({ count: e.data.count, durationMs: e.data.durationMs });
        }
        
        const payload = e.data.payload || [];
        const _now = new Date();
        const _totalSec = _now.getUTCSeconds() + _now.getUTCMilliseconds() / 1000;
        const decPeriodIndex = Math.floor(_totalSec / (modeRef.current === 'FT4' ? 7.5 : 15)) % 2;

        if (payload.length > 0) {
            setRxLog(prev => {
                const timeString = payload[0].time;
                const formattedTime = timeString.length === 6 
                    ? `${timeString.substring(0,2)}:${timeString.substring(2,4)}:${timeString.substring(4,6)}` 
                    : timeString;
                const divider: FT8DecodedMessage = {
                    time: timeString,
                    snr: 0,
                    freq: 0,
                    message: `-------- ${formattedTime} UTC --------`,
                    isDivider: true
                };
                const newLog = [divider, ...payload, ...prev];
                
                // Keep only the last 4 periods (i.e., up to 4 dividers)
                let dividerCount = 0;
                const filteredLog: FT8DecodedMessage[] = [];
                for (const item of newLog) {
                    if (item.isDivider) {
                        dividerCount++;
                    }
                    if (dividerCount > 4) {
                        break;
                    }
                    filteredLog.push(item);
                }
                return filteredLog;
            });
        }
        
        if (autoSequenceRef.current && fsmRef.current) {
            fsmRef.current.onPeriodDecodeReady(payload, decPeriodIndex);
        } else if (payload.length > 0) {
            // Route to QSO Log based on rules
            const incomingQsoMessages = payload.filter((msg: FT8DecodedMessage) => {
                const myCall = myCallRef.current;
                const targetCall = targetCallRef.current;
                
                const parts = msg.message.trim().split(/\s+/);
                
                if (myCall && msg.message.includes(myCall)) return true;
                
                if (targetCall) {
                    // Normalize parts to remove hashed call brackets like <W1AW> if present
                    const cleanParts = parts.map(p => p.replace(/[<>]/g, ''));
                    
                    // Check if target is the transmitter (Source)
                    if (cleanParts.length >= 2 && cleanParts[1] === targetCall) return true;
                    // CQ/QRZ with modifier format: CQ DX W1AW FN34
                    if (cleanParts.length >= 3 && (cleanParts[0] === 'CQ' || cleanParts[0] === 'QRZ') && cleanParts[2] === targetCall) return true;
                }
                
                return false;
            }).map((msg: FT8DecodedMessage) => ({ ...msg, message: "<- " + msg.message, isIncoming: true }));
            
            if (incomingQsoMessages.length > 0) {
                setQsoLog(prev => {
                    const newLog = [...incomingQsoMessages.reverse(), ...prev];
                    return newLog.slice(0, 100);
                });
            }
        }
      } else if (e.data.type === 'ERROR') {
        console.error("FT8 Decode Worker Error:", e.data.error);
      }
    };
    workerRef.current = worker;
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', getDevices);
      worker.terminate();
    };
  }, []);

  const drawWaterfall = useCallback((time: number) => {
    // TX Freeze Logic: completely freeze waterfall if Transmitting
    if (isTransmittingRef.current) return;

    // Throttle to 100ms (10fps). 1 pixel per frame = 10 px / sec.
    if (time - lastDrawTimeRef.current < 100) return;
    lastDrawTimeRef.current = time;

    if (!analyserRef.current || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    
    const analyser = analyserRef.current;
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    const width = canvas.width;
    const height = canvas.height;
    
    // Zoom waterfall to exactly 200 to 3000 Hz.
    const sampleRate = audioCtx.sampleRate;
    const binSize = sampleRate / analyser.fftSize;
    const minBinIndex = Math.floor(200 / binSize);
    const maxBinIndex = Math.floor(3000 / binSize);
    const binSpan = maxBinIndex - minBinIndex;
    
    // Shift current canvas image vertically downwards by 1px
    ctx.drawImage(canvas, 0, 0, width, height - 1, 0, 1, width, height - 1);
    
    // Compute the new top row
    const rowImg = ctx.createImageData(width, 1);
    for (let x = 0; x < width; x++) {
      const binIndex = minBinIndex + Math.floor((x / width) * binSpan);
      const val = dataArray[binIndex] || 0;
      
      const px = x * 4;
      // Smooth color palette: Black -> Blue -> Purple/Red -> Yellow/White
      let r = 0, g = 0, b = 0;
      
      if (val < 50) {
        b = val * 2;
      } else if (val < 100) {
        b = 100 + (val - 50) * 3;
        r = (val - 50) * 2;
      } else if (val < 180) {
        b = 250 - (val - 100);
        r = 100 + (val - 100) * 1.5;
      } else {
        r = 255;
        g = (val - 180) * 3;
        b = (val - 220) * 5 > 0 ? (val - 220) * 5 : 0;
      }
      
      rowImg.data[px + 0] = Math.min(255, Math.max(0, r)); 
      rowImg.data[px + 1] = Math.min(255, Math.max(0, g));   
      rowImg.data[px + 2] = Math.min(255, Math.max(0, b));                             
      rowImg.data[px + 3] = 255;                            
    }
    
    ctx.putImageData(rowImg, 0, 0);

    // Advance the row counter (naturally pauses during TX since drawWaterfall returns early)
    waterfallRowsRef.current += 1;
    const totalRows = waterfallRowsRef.current;

    // Prune markers that have scrolled off the bottom of the canvas
    pendingMarkersRef.current = pendingMarkersRef.current.filter(
      m => totalRows - m.atRow < height
    );

    // Draw each queued period marker at its correct canvas Y position
    for (const marker of pendingMarkersRef.current) {
      const y = totalRows - marker.atRow;
      ctx.fillStyle = 'rgba(255, 215, 0, 0.4)';
      ctx.fillRect(0, y, width, 1);
      // Draw the timestamp label once, just below the line, when it first enters the canvas
      if (y <= 1) {
        ctx.fillStyle = 'rgba(255, 215, 0, 0.9)';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText(marker.label, 4, y + 12);
      }
    }
  }, [mode]);

  const toggleAudio = async (forcedDeviceId?: string) => {
    const targetDeviceId = typeof forcedDeviceId === 'string' ? forcedDeviceId : selectedDeviceId;
    
    // De-activate path
    if (audioActive && typeof forcedDeviceId === 'undefined') {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(t => t.stop());
            mediaStreamRef.current = null;
        }
        if (audioCtxRef.current) {
            try {
                await audioCtxRef.current.close();
            } catch (e) {
                console.error('[Audio] Error closing context on stop:', e);
            }
            audioCtxRef.current = null;
        }
        sourceNodeRef.current = null;
        analyserRef.current = null;
        captureNodeRef.current = null;
        setAudioActive(false);
        setAudioLevel(0);
        return;
    }

    try {
      // If there's an active context and we are forcing a change, tear it down first!
      if (audioCtxRef.current && typeof forcedDeviceId === 'string') {
        console.log('[Audio] Tearing down old AudioContext before switching devices...');
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(t => t.stop());
            mediaStreamRef.current = null;
        }
        try {
            await audioCtxRef.current.close();
        } catch (e) {
            console.error('[Audio] Error closing context for switch:', e);
        }
        audioCtxRef.current = null;
        sourceNodeRef.current = null;
        analyserRef.current = null;
        captureNodeRef.current = null;
        // Tiny 250ms sleep to allow the Android OS audio hardware thread to completely free/recycle the input handles.
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      // 1. First get the MediaStream from getUserMedia BEFORE creating/resuming AudioContext.
      // This is crucial on Android because if the user selects a non-existent or locked device,
      // creating/resuming the context first can get WebAudio out-of-sync or stuck in a broken state.
      let stream: MediaStream;
      try {
        // Try strict targetDeviceId exact mode first if specified.
        // DO NOT pass electronic DSP constraints (echoCancellation, etc.) here to prevent Android driver / HAL crash on raw USB adapters.
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: targetDeviceId ? { deviceId: { exact: targetDeviceId } } : true
        });
        console.log('[Audio] Successfully acquired media stream with exact constraint:', targetDeviceId);
      } catch (err: any) {
        console.warn('[Audio] getUserMedia strict constraints failed, attempting fallback to ideal deviceId constraint:', err);
        try {
          // Retry using "ideal" constraint without voice-processing DSP constraints to avoid USB driver rejections.
          stream = await navigator.mediaDevices.getUserMedia({ 
            audio: targetDeviceId ? { deviceId: { ideal: targetDeviceId } } : true
          });
          console.log('[Audio] Successfully acquired stream using ideal constraint:', targetDeviceId);
        } catch (err2) {
          console.error('[Audio] getUserMedia of target device failed, falling back to default input with DSP safety. Error:', err2);
          // Standard ultimate default fallback - request simply any audio input but explicitly disable mobile phone line DSP voice processing filters for FT8.
          stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            } 
          });
          console.log('[Audio] Acquired default system microphone with DSP filters turned off');
        }
      }

      mediaStreamRef.current = stream;

      // 2. Now instantiate/resume the AudioContext
      let ctx = audioCtxRef.current;
      if (!ctx) {
          const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
          // FT8 strongly prefers 12KHz. We request it, but must be resilient if OS overrides it.
          ctx = new AudioContextCtor({ sampleRate: 12000 });
          audioCtxRef.current = ctx;
      }

      if (ctx.state === 'suspended') {
          await ctx.resume();
      }

      if (typeof (ctx as any).setSinkId === 'function' && selectedOutputDeviceId) {
          (ctx as any).setSinkId(selectedOutputDeviceId).catch((e: any) => console.error("setSinkId fail:", e));
      }
      
      const source = ctx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      
      // Waterfall visualizer pipeline
      if (!analyserRef.current) {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 4096;
          analyser.smoothingTimeConstant = 0.0;
          analyser.minDecibels = -110;
          analyser.maxDecibels = -30;
          analyserRef.current = analyser;
      }
      source.connect(analyserRef.current);
      
      // Accumulator pipeline via Worklet
      if (!captureNodeRef.current) {
          const workletUrl = getCaptureWorkletUrl();
          await ctx.audioWorklet.addModule(workletUrl);
          const captureNode = new AudioWorkletNode(ctx, 'capture-processor');
          
          captureNode.port.onmessage = (e) => {
              const chunk = e.data as Float32Array;
              // Calculate RMS level for VU meter
              let sumSquares = 0;
              for(let i=0; i<chunk.length; i++) sumSquares += chunk[i] * chunk[i];
              const rms = Math.sqrt(sumSquares / chunk.length);
              setAudioLevel(Math.min(100, rms * 1500)); 
              
              // Only accumulate if we are in the 0.0 - 13.0s recording window
              const now = new Date();
              const secondsInWindow = (now.getUTCSeconds() + now.getUTCMilliseconds() / 1000) % 15;
              
              if (secondsInWindow < 13.0) {
                  const newBuffer = new Float32Array(rxBufferRef.current.length + chunk.length);
                  newBuffer.set(rxBufferRef.current, 0);
                  newBuffer.set(chunk, rxBufferRef.current.length);
                  rxBufferRef.current = newBuffer;
              }
          };
          captureNode.connect(ctx.destination); 
          captureNodeRef.current = captureNode;
      }
      
      source.connect(captureNodeRef.current);
      
      setAudioActive(true);
      getDevices(); // Refresh devices now that permissions may be granted
    } catch (e) {
      console.error("Audio Context Init Failed:", e);
      alert("Failed to initialize audio or access microphone. Check browser permissions.");
    }
  };

  const handleDeviceChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newId = e.target.value;
      setSelectedDeviceId(newId);
      
      if (!audioActive) return;

      console.log(`[Audio] Initiating input device shift to: ${newId}`);

      try {
          await toggleAudio(newId);
          console.log('[Audio] Successfully completed device switch.');
      } catch (err: any) {
          console.error('[Audio] Failed to switch audio input device:', err);
          alert(`Failed to switch audio device: ${err.message || 'Device Busy'}`);
          setAudioActive(false);
      }
  };

  const handleOutputDeviceChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newId = e.target.value;
      setSelectedOutputDeviceId(newId);
      if (audioCtxRef.current && typeof (audioCtxRef.current as any).setSinkId === 'function') {
          try {
              await (audioCtxRef.current as any).setSinkId(newId);
          } catch (err) {
              console.error("Failed to set output device:", err);
          }
      }
  };

  // TX Orchestrator
  const transmitMessage = useCallback(async (message: string) => {
    if (!audioCtxRef.current || isTransmitting || isTxQueued || !txEnabled) return;
    
    // Guarantee audio is alive before queuing
    if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
    }
    
    queuedTxMessageRef.current = message;
    setIsTxQueued(true);
  }, [isTransmitting, isTxQueued, txEnabled]);

  // Sync FSM parameters
  useEffect(() => {
    if (!fsmRef.current) {
      const fsm = new FT8FSM({
        myCall,
        myGrid,
        myPeriod: txPeriod,
        maxRetries,
        finalMessageMode,
        isTxEnabled: txEnabled,
      });

      fsm.onStateChange = (state, target, queue) => {
        setFsmState(state);
        setFsmQueue([...queue]);
        setTargetCall(target || '');
      };

      fsm.onTransmit = (msg) => {
        // Direct queue setting to bypass stale closures
        queuedTxMessageRef.current = msg;
        setIsTxQueued(true);
      };

      fsm.onAppendQsoLog = (msg, isTx, isDivider) => {
        setQsoLog(prev => {
          const now = new Date();
          const nowString = now.toISOString().substring(11, 19).replace(/:/g, '');
          const item: FT8DecodedMessage = {
            time: nowString,
            snr: isTx ? 0 : -10,
            freq: txFreqRef.current,
            message: msg,
            isTx,
            isDivider
          };
          return [item, ...prev].slice(0, 100);
        });
      };

      fsm.onLogQSO = async (qsoData) => {
        try {
            const now = new Date();
            const pad = (n: number) => n.toString().padStart(2, '0');
            const dateStr = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
            const timeStr = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
            
            // Helper to determine band from VFO frequency
            const getBandFromFreq = (freqInHz: number): string => {
                const mhz = freqInHz / 1e6;
                if (mhz >= 1.8 && mhz <= 2.0) return "160m";
                if (mhz >= 3.5 && mhz <= 4.0) return "80m";
                if (mhz >= 5.3 && mhz <= 5.4) return "60m";
                if (mhz >= 7.0 && mhz <= 7.3) return "40m";
                if (mhz >= 10.1 && mhz <= 10.2) return "30m";
                if (mhz >= 14.0 && mhz <= 14.35) return "20m";
                if (mhz >= 18.068 && mhz <= 18.168) return "17m";
                if (mhz >= 21.0 && mhz <= 21.45) return "15m";
                if (mhz >= 24.89 && mhz <= 24.99) return "12m";
                if (mhz >= 28.0 && mhz <= 29.7) return "10m";
                if (mhz >= 50.0 && mhz <= 54.0) return "6m";
                return "";
            };

            const currentVfo = vfoFreqRef.current;

            const dxccEntity = dxccService.lookup(qsoData.call);
            const qsoRecord: QSO = {
                call: qsoData.call,
                qso_date: dateStr,
                time_on: timeStr,
                band: getBandFromFreq(currentVfo),
                freq: currentVfo / 1e6,
                mode: modeRef.current,
                submode: "",
                rst_sent: qsoData.rst_sent || "",
                rst_rcvd: qsoData.rst_rcvd || "",
                gridsquare: qsoData.grid || "",
                timestamp: now.getTime(),
                synced: false,
                dxcc: dxccEntity?.adifCode,
            };

            const id = await logBook.logQSO(qsoRecord);
            qsoRecord.id = id;

            // Dispatch global event to trigger worked calls Set updates instantly
            window.dispatchEvent(new Event('qso-logged'));

            // Trigger global refresh for UI immediately so it appears on screen without delay
            if (typeof (window as any).refreshQsoLogbookUi === 'function') {
                (window as any).refreshQsoLogbookUi();
            }

            // Push to cloud instantly if enabled
            if (wavelogEnabledRef.current && navigator.onLine) {
                 try {
                     const success = await CloudLogService.pushSingleQSO(qsoRecord, {
                         wavelogEnabled: wavelogEnabledRef.current,
                         wavelogUrl: wavelogUrlRef.current,
                         wavelogApiKey: wavelogApiKeyRef.current,
                         wavelogStationProfileId: wavelogStationProfileIdRef.current
                     });
                     if (success) {
                         await logBook.updateQSO({ ...qsoRecord, synced: true });
                         
                         window.dispatchEvent(new Event('qso-logged'));
                         
                         // Refresh UI again to update the synced cloud status icon on screen
                         if (typeof (window as any).refreshQsoLogbookUi === 'function') {
                             (window as any).refreshQsoLogbookUi();
                         }
                     }
                 } catch (cloudErr) {
                     console.error("Failed to push QSO dynamically to Wavelog", cloudErr);
                 }
            }
        } catch (err) {
            console.error("Failed to save QSO automatically", err);
        }
      };

      fsmRef.current = fsm;
      setFsmState('IDLE');
    } else {
      fsmRef.current.myCall = myCall;
      fsmRef.current.myGrid = myGrid;
      fsmRef.current.myPeriod = txPeriod;
      fsmRef.current.maxRetries = maxRetries;
      fsmRef.current.finalMessageMode = finalMessageMode;
      fsmRef.current.isTxEnabled = txEnabled;
    }
  }, [myCall, myGrid, txPeriod, maxRetries, finalMessageMode, txEnabled]);

  // Auto-reset state machine if PTT is disabled
  useEffect(() => {
    if (!txEnabled && fsmRef.current) {
      fsmRef.current.resetToIdle();
    }
  }, [txEnabled]);

  // Sync Interval Management & Animation Frame
  useEffect(() => {
    let animationFrameId: number;
    let periodState = {
       lastPeriod: -1,
       decodedThisPeriod: false,
    };
    
    const loop = (time: number) => {
      animationFrameId = requestAnimationFrame(loop);
      
      const now = new Date();
      const seconds = now.getUTCSeconds();
      const ms = now.getUTCMilliseconds();
      const totalSeconds = seconds + (ms / 1000);
      
      const PERIOD = modeRef.current === 'FT4' ? 7.5 : 15;
      const RECORD_AT = modeRef.current === 'FT4' ? 6.0 : 13.0;

      const currentPeriod = Math.floor(totalSeconds / PERIOD);
      const secondsInWindow = totalSeconds % PERIOD;

      setWindowProgress((secondsInWindow / PERIOD) * 100);
      setUtcTime(now.toISOString().substring(11, 19));

      // Epoch boundary: period start mark
      if (currentPeriod !== periodState.lastPeriod && periodState.lastPeriod !== -1) {
        periodState.lastPeriod = currentPeriod;
        periodState.decodedThisPeriod = false;

        // Queue a waterfall period marker at the current canvas row
        pendingMarkersRef.current.push({
          atRow: waterfallRowsRef.current,
          label: now.toISOString().substring(11, 19) + ' UTC',
        });

        // Drive FSM at slot transition
        if (autoSequence && fsmRef.current) {
          fsmRef.current.onPeriodStart(currentPeriod);
        }

        // Start TX exactly at period start if queued and matches selected period
        if (queuedTxMessageRef.current && txEnabled && currentPeriod % 2 === txPeriodRef.current) {
            const message = queuedTxMessageRef.current;
            queuedTxMessageRef.current = null;
            setIsTxQueued(false);
            startTx(message);
        }

        // Clear RX buffer for the new recording period
        rxBufferRef.current = new Float32Array(0);
      } else if (currentPeriod !== periodState.lastPeriod) {
        // Init first run
        periodState.lastPeriod = currentPeriod;
      }

      // Decode trigger
      if (secondsInWindow >= RECORD_AT && !periodState.decodedThisPeriod) {
        periodState.decodedThisPeriod = true;
        const audioData = rxBufferRef.current;

        if (audioActive && audioCtxRef.current && audioData.length > 0) {
            if (workerRef.current) {
                const periodStartTotalSec = Math.floor(totalSeconds / PERIOD) * PERIOD;
                const periodStartWholeSec = Math.floor(periodStartTotalSec);
                const periodStartMs = Math.round((periodStartTotalSec - periodStartWholeSec) * 1000);
                const periodStart = new Date(now.getTime());
                periodStart.setUTCSeconds(periodStartWholeSec, periodStartMs);
                const nowString = periodStart.toISOString().substring(11, 19).replace(/:/g, '');

                workerRef.current.postMessage({
                    audioData,
                    sampleRate: audioCtxRef.current.sampleRate,
                    nowString,
                    decodeDepth,
                    mode: modeRef.current
                });
            }
        }
      }

      if (audioActive) {
          drawWaterfall(time);
      }
    };
    
    animationFrameId = requestAnimationFrame(loop);
    
    return () => {
        cancelAnimationFrame(animationFrameId);
    };
  }, [audioActive, drawWaterfall, decodeDepth, txEnabled, txFreq, selectedOutputDeviceId, autoSequence]);

  const handleWaterfallClick = (e: React.MouseEvent<HTMLElement, MouseEvent>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const freq = Math.round((x / rect.width) * 2800) + 200;
    setTxFreq(Math.max(200, Math.min(3000, freq)));
  };

  return (
    <div className="min-h-screen bg-app text-text-main font-sans flex flex-col p-4 select-none">
      
      {/* Header Pipeline */}
      <header className="flex flex-wrap items-center justify-between bg-panel border border-border-subtle rounded-lg p-4 mb-3 shadow-lg gap-4">
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-widest text-text-muted mb-1">System Status</span>
            <div className="flex gap-2">
              <button 
                onClick={() => toggleAudio()}
                className={`px-3 py-1.5 border rounded text-[10px] font-bold transition-all flex items-center gap-2 uppercase tracking-widest ${
                  audioActive 
                    ? 'bg-btn border-[#4caf50] text-green-600 dark:text-[#4caf50] hover:border-red-500 hover:text-red-500'
                    : 'bg-btn border-border-input hover:border-[#4caf50] text-text-muted hover:text-green-600 dark:text-[#4caf50]'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${audioActive ? 'bg-green-600 dark:bg-[#4caf50] shadow-[0_0_8px_#4caf50]' : 'bg-[#2a2c31]'}`}></div>
                {audioActive ? "Audio Active" : "Activate Audio"}
              </button>
              <button
                onClick={() => setShowSettings(true)}
                className="px-2 border border-border-input bg-btn hover:bg-btn-hover rounded flex items-center justify-center text-text-muted hover:text-text-main transition-colors"
                title="Settings"
              >
                  <Settings size={14} />
              </button>
              <button
                onClick={() => setShowAbout(true)}
                className="px-2 border border-border-input bg-btn hover:bg-btn-hover rounded flex items-center justify-center text-text-muted hover:text-text-main transition-colors"
                title="About / Help"
              >
                  <HelpCircle size={14} />
              </button>
            </div>
          </div>

          {/* VU Meter Payload */}
          <div className="flex flex-col min-w-[140px]">
            <span className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Input Level (VU)</span>
            <div className="h-4 bg-black rounded-sm border border-border-subtle relative overflow-hidden">
              <div 
                className="absolute left-0 top-0 h-full bg-gradient-to-r from-green-500 via-yellow-400 to-red-500 opacity-80 transition-all duration-75 ease-linear"
                style={{ width: `${audioLevel}%` }}
              />
              <div className="absolute inset-0 grid grid-cols-10 gap-px px-0.5">
                {[...Array(10)].map((_, i) => <div key={i} className="border-r border-black/50 h-full" />)}
              </div>
            </div>
          </div>
        </div>

        {/* --- RF Frequency Readout --- */}
        <div className="flex flex-col items-center justify-center min-w-[180px]">
          <span className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Radio VFO</span>
          {editingVfo ? (
            <input
              type="text"
              className="text-[26px] font-mono font-bold leading-none tracking-tight text-green-600 dark:text-[#4caf50] bg-transparent border-b border-[#4caf50] outline-none w-[180px] text-center"
              value={vfoInputStr}
              autoFocus
              onChange={e => setVfoInputStr(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitVfoInput();
                if (e.key === 'Escape') setEditingVfo(false);
              }}
              onBlur={commitVfoInput}
            />
          ) : (
            <span
              className={`text-[26px] font-mono font-bold leading-none tracking-tight cursor-pointer hover:opacity-70 transition-opacity ${
                catMode !== 'manual' && !catConnected
                  ? 'text-red-500 shadow-[0_0_8px_rgba(239,68,68,0.3)]'
                  : 'text-green-600 dark:text-[#4caf50]'
              }`}
              title="Click to enter custom frequency (MHz)"
              onClick={() => {
                setVfoInputStr((vfoFreq / 1_000_000).toFixed(6));
                setEditingVfo(true);
              }}
            >
              {formatFrequency(vfoFreq)}
            </span>
          )}
        </div>

        <div className="flex flex-col items-center">
          <span className="text-[10px] uppercase tracking-widest text-text-muted mb-1">{mode} Window ({mode === 'FT4' ? '7.5s' : '15s'} Sync)</span>
          <div className="w-32 md:w-48 h-1.5 bg-black rounded-full border border-border-subtle relative overflow-hidden">
             <div 
              className="absolute left-0 top-0 h-full bg-green-600 dark:bg-[#4caf50] transition-all duration-75 ease-linear shadow-[0_0_5px_rgba(76,175,80,0.5)]"
              style={{ width: `${windowProgress}%` }}
            />
          </div>
        </div>

        <div className="flex flex-col items-end min-w-[120px]">
          <span className="text-[10px] uppercase tracking-widest text-text-muted block mb-1">Station Clock (UTC)</span>
          <span className="text-2xl font-mono font-bold text-text-main leading-none">
            {utcTime}
          </span>
          <div className="flex items-center gap-1.5 mt-1.5" title={clockVerdict.message}>
            <span
              className={`h-2 w-2 rounded-full transition-colors duration-500 ${
                clockVerdict.status === 'ok'   ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.7)]' :
                clockVerdict.status === 'warn' ? 'bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.7)] animate-pulse' :
                clockVerdict.status === 'bad'  ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)] animate-pulse' :
                                                 'bg-gray-500'
              }`}
            />
            <span className={`text-[10px] font-mono tracking-wide ${
              clockVerdict.status === 'bad'  ? 'text-red-400' :
              clockVerdict.status === 'warn' ? 'text-yellow-400' :
              'text-text-muted'
            }`}>
              {clockVerdict.message}
            </span>
          </div>
        </div>
      </header>

      {/* --- Band Selection Bar --- */}
      <div className="bg-panel rounded-lg border border-border-subtle p-1.5 mb-3 flex items-center justify-between shadow-sm gap-2">
        <div 
          className="flex gap-2 overflow-x-auto band-control-bar flex-1 min-w-0 pr-4 lg:border-r border-border-subtle shrink"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          <style>{`.band-control-bar::-webkit-scrollbar { display: none; }`}</style>
          {BAND_FREQS.map(band => {
            // If within 2kHz of standard FT8 frequency, consider it active
            const isActive = Math.abs(vfoFreq - band.hz) < 2000;
            return (
              <button
                key={band.label}
                onClick={() => selectBand(band.hz)}
                className={`px-5 py-1.5 rounded-full text-[11px] uppercase tracking-wider font-bold transition-colors whitespace-nowrap shrink-0 ${
                  isActive 
                    ? 'bg-blue-600 text-white shadow-[0_0_8px_rgba(37,99,235,0.8)] border border-blue-400' 
                    : 'bg-btn text-text-muted border border-transparent hover:bg-btn-hover hover:text-text-main'
                }`}
              >
                {band.label}
              </button>
            );
          })}
        </div>
        
        {/* Mode Toggle */}
        <button
          onClick={() => {
            const newMode = mode === 'FT8' ? 'FT4' : 'FT8';
            const freqs = newMode === 'FT4' ? BAND_FREQS_FT4 : BAND_FREQS_FT8;
            const currentBand = getBandFromFreq(vfoFreq);
            const match = freqs.find(b => b.label === currentBand);
            setMode(newMode);
            if (match) selectBand(match.hz);
          }}
          className={`shrink-0 px-4 py-1.5 rounded text-[11px] font-mono uppercase font-bold border transition-colors ${
            mode === 'FT8'
              ? 'bg-[#0f1e30] text-blue-400 border-blue-800 hover:bg-[#162540]'
              : 'bg-[#2a1505] text-orange-400 border-orange-800 hover:bg-[#3d2007]'
          }`}
        >
          {mode}
        </button>

        {/* PTT Period Toggle */}
        <button
          onClick={() => setTxPeriod(p => p === 0 ? 1 : 0)}
          className={`shrink-0 px-4 py-1.5 rounded text-[11px] font-mono uppercase font-bold border transition-colors ${
            txPeriod === 0
              ? 'bg-[#0f2e1b] text-green-400 border-green-800 hover:bg-[#154628]'
              : 'bg-[#3d1f05] text-amber-500 border-amber-700 hover:bg-[#5a2e07]'
          }`}
        >
          Tx: {txPeriod === 0 ? 'Even (:00)' : `Odd (${mode === 'FT4' ? ':07' : ':15'})`}
        </button>
      </div>

      {/* Main Working Environment */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-[400px]">
        
        {/* Left pane: Logs */}
        <section className="lg:col-span-5 flex flex-col gap-3 min-h-0">
          
          {/* Band Activity (Global Log) */}
          <div className="bg-panel border border-border-subtle rounded-lg flex flex-col h-[300px] max-h-[300px] shrink-0 overflow-hidden">
            <div className="bg-header border-b border-border-subtle px-3 py-2 flex justify-between items-center rounded-t-lg shrink-0">
              <h3 className="text-[11px] font-bold text-text-muted tracking-widest uppercase flex items-center gap-2">
                <Activity size={14} className="text-green-600 dark:text-[#4caf50]"/> 
                Band Activity
                {decodeStats && (
                  <span className={`normal-case tracking-normal ${decodeStats.durationMs > 1500 ? "text-orange-400" : "text-zinc-500"}`}>
                    ({decodeStats.count} stations in {decodeStats.durationMs}ms)
                  </span>
                )}
              </h3>
              <button
                onClick={() => setRxLog([])}
                className="text-[10px] font-mono font-bold uppercase bg-red-950/80 text-red-100 hover:bg-red-900 border border-red-700 hover:border-red-500 px-2.5 py-1 rounded transition-all shrink-0 shadow-sm"
                title="Clear Band Activity Log"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 font-mono text-[11px] overflow-hidden p-2 flex flex-col">
              <div className="grid grid-cols-[55px_40px_60px_1fr] gap-2 py-1 text-text-muted border-b border-border-subtle mb-2 uppercase text-[9px] shrink-0">
                <div>Time</div>
                <div>SNR</div>
                <div>Freq</div>
                <div>Message</div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
                {rxLog.length === 0 && (
                    <div className="text-text-muted flex items-center justify-center h-full opacity-50 p-6 text-center text-xs">
                        Awaiting FT8 signals...<br/>(Audio decoded every 15s synced period)
                    </div>
                )}
                {rxLog.map((log, i) => {
                  if (log.isDivider) {
                    return (
                      <div key={i} className="flex items-center justify-center py-2 opacity-50">
                         <span className="text-[9px] font-mono tracking-widest text-text-muted">{log.message}</span>
                      </div>
                    );
                  }

                  const callsign = extractTransmitterCallsign(log.message);
                  const isWorked = callsign ? workedCallsigns.has(callsign.toUpperCase()) : false;

                  return (
                    <div 
                      key={i}
                      onClick={() => {
                        const call = extractTransmitterCallsign(log.message);
                        if (call) {
                          setTargetCall(call);
                          if (fsmRef.current) {
                            const isSameStation = fsmRef.current.targetCall === call;
                            fsmRef.current.targetCall = call;
                            const gridMatch = log.message.match(/\b[A-Z]{2}[0-9]{2}\b/);
                            if (gridMatch && gridMatch[0] !== 'RR73') {
                              fsmRef.current.targetGrid = gridMatch[0];
                            } else if (!isSameStation) {
                              fsmRef.current.targetGrid = null;
                            }
                            if (autoSequence) {
                              const msgContent = log.message.trim().split(/\s+/).slice(2).join(' ').toUpperCase();
                              const reportMatch = msgContent.match(/^R?([+-]\d+)$/);
                              if (reportMatch) {
                                fsmRef.current.myReceivedReport = reportMatch[1];
                                const snr = log.snr !== undefined ? Math.round(log.snr) : -12;
                                fsmRef.current.targetReport = snr >= 0
                                  ? `+${String(snr).padStart(2, '0')}`
                                  : `-${String(Math.abs(snr)).padStart(2, '0')}`;
                                fsmRef.current.updateState('SENDING_R_REPORT', call);
                              } else {
                                fsmRef.current.updateState('REPLY_SENDING', call);
                              }
                              setTxEnabled(true);
                            }
                          }
                        }

                        // Auto-set TX period to the OPPOSITE of the caller's period
                        const seconds = parseInt(log.time.substring(4, 6), 10);
                        const periodLen = mode === 'FT4' ? 7.5 : 15;
                        const callerPeriod = Math.floor(seconds / periodLen) % 2;
                        setTxPeriod(callerPeriod === 0 ? 1 : 0);
                      }}
                      className={`grid grid-cols-[55px_40px_60px_1fr] gap-2 hover:bg-btn cursor-pointer p-1 rounded transition-colors group text-[11px] items-center ${
                        isWorked ? 'opacity-55 hover:opacity-100' : ''
                      }`}
                    >
                      <span className="text-zinc-500">{log.time}</span>
                      <span className={log.snr > -10 ? 'text-green-400' : 'text-red-400'}>{log.snr}</span>
                      <span className="text-blue-400">{log.freq}Hz</span>
                      <span className="text-text-main group-hover:text-text-highlight font-bold flex items-center flex-wrap">
                        {log.message}
                        {isWorked && (
                          <span
                            className="ml-1.5 inline-flex items-center text-[7.5px] px-1 py-0.2 rounded font-mono font-bold uppercase bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400 border border-neutral-300 dark:border-neutral-700/60 leading-none select-none"
                            title="Worked before on this band and mode (B4)"
                          >
                            B4
                          </span>
                        )}
                        {dxccReady && callsign && (() => {
                          const entity = dxccService.lookup(callsign);
                          if (!entity) return null;
                          const isNewDxcc = !workedDxccEntities.has(entity.adifCode);
                          return <>
                            {isNewDxcc && (
                              <span className="ml-1 inline-flex items-center text-[7.5px] px-1 py-0.2 rounded font-mono font-bold uppercase bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400 border border-neutral-300 dark:border-neutral-700/60 leading-none select-none" title="New DXCC entity">N</span>
                            )}
                            <span className="ml-1 inline-flex items-center text-[7.5px] px-1 py-0.2 rounded font-mono uppercase bg-cyan-900/40 text-cyan-400 border border-cyan-700/40 leading-none select-none" title={entity.name}>{entity.primaryPrefix}</span>
                          </>;
                        })()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* QSO Window (Targeted Log) */}
          <div className="bg-qso border border-border-subtle rounded-lg flex flex-col h-[250px] max-h-[250px] shrink-0 overflow-hidden">
            <div className="bg-header border-b border-border-subtle px-3 py-2 flex justify-between items-center rounded-t-lg shrink-0">
              <h3 className="text-[11px] font-bold text-text-muted tracking-widest uppercase flex items-center gap-2">
                <Activity size={14} className="text-green-600 dark:text-[#4caf50]"/> 
                Active QSO
              </h3>
              <button
                onClick={() => setQsoLog([])}
                className="text-[10px] font-mono font-bold uppercase bg-red-950/80 text-red-100 hover:bg-red-900 border border-red-700 hover:border-red-500 px-2.5 py-1 rounded transition-all shrink-0 shadow-sm"
                title="Clear Active QSO Log"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 font-mono text-[11px] overflow-hidden p-2 flex flex-col">
              <div className="grid grid-cols-[55px_40px_60px_1fr] gap-2 py-1 text-text-muted border-b border-border-subtle mb-2 uppercase text-[9px] shrink-0">
                <div>Time</div>
                <div>SNR</div>
                <div>Freq</div>
                <div>Message</div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
                {qsoLog.length === 0 && (
                    <div className="text-text-muted flex items-center justify-center h-full opacity-50 p-6 text-center text-xs">
                        No active QSOs...
                    </div>
                )}
                {qsoLog.map((log, i) => {
                  if (log.isDivider) return null;
                  
                  let textClass = "text-text-main font-bold";
                  if (log.isTx) textClass = "text-sky-300 font-bold";
                  else if (log.isIncoming) textClass = "text-green-400 font-bold";
                  
                  return (
                  <div 
                    key={i}
                    onClick={() => {
                      if (!log.isTx) {
                        const callsign = extractTransmitterCallsign(log.message);
                        if (callsign) {
                          setTargetCall(callsign);
                          if (fsmRef.current) {
                            const isSameStation = fsmRef.current.targetCall === callsign;
                            fsmRef.current.targetCall = callsign;
                            const gridMatch = log.message.match(/\b[A-Z]{2}[0-9]{2}\b/);
                            if (gridMatch && gridMatch[0] !== 'RR73') {
                              fsmRef.current.targetGrid = gridMatch[0];
                            } else if (!isSameStation) {
                              fsmRef.current.targetGrid = null;
                            }
                            if (autoSequence) {
                              const msgContent = log.message.trim().split(/\s+/).slice(2).join(' ').toUpperCase();
                              const reportMatch = msgContent.match(/^R?([+-]\d+)$/);
                              if (reportMatch) {
                                fsmRef.current.myReceivedReport = reportMatch[1];
                                const snr = log.snr !== undefined ? Math.round(log.snr) : -12;
                                fsmRef.current.targetReport = snr >= 0
                                  ? `+${String(snr).padStart(2, '0')}`
                                  : `-${String(Math.abs(snr)).padStart(2, '0')}`;
                                fsmRef.current.updateState('SENDING_R_REPORT', callsign);
                              } else {
                                fsmRef.current.updateState('REPLY_SENDING', callsign);
                              }
                              setTxEnabled(true);
                            }
                          }
                        }
                      }

                      // If incoming message, set TX period to OPPOSITE of caller's period
                      if (!log.isTx && log.time && log.time.length >= 6) {
                        const seconds = parseInt(log.time.substring(4, 6), 10);
                        const periodLen = mode === 'FT4' ? 7.5 : 15;
                        const callerPeriod = Math.floor(seconds / periodLen) % 2;
                        setTxPeriod(callerPeriod === 0 ? 1 : 0);
                      }
                    }}
                    className="grid grid-cols-[55px_40px_60px_1fr] gap-2 hover:bg-btn cursor-pointer p-1 rounded transition-colors group text-[11px] items-center"
                  >
                    <span className="text-zinc-500">{log.time}</span>
                    <span className={log.isTx ? 'text-zinc-500' : (log.snr > -10 ? 'text-green-400' : 'text-red-400')}>{log.isTx ? '--' : log.snr}</span>
                    <span className="text-blue-400">{log.freq}Hz</span>
                    <span className={`group-hover:text-text-highlight ${textClass} flex items-center flex-wrap`}>
                      {log.message}
                      {dxccReady && !log.isTx && (() => {
                        const cs = extractTransmitterCallsign(log.message);
                        const entity = cs ? dxccService.lookup(cs) : null;
                        if (!entity) return null;
                        const isNewDxcc = !workedDxccEntities.has(entity.adifCode);
                        return <>
                          {isNewDxcc && (
                            <span className="ml-1 inline-flex items-center text-[7.5px] px-1 py-0.2 rounded font-mono font-bold uppercase bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400 border border-neutral-300 dark:border-neutral-700/60 leading-none select-none" title="New DXCC entity">N</span>
                          )}
                          <span className="ml-1 inline-flex items-center text-[7.5px] px-1 py-0.2 rounded font-mono uppercase bg-cyan-900/40 text-cyan-400 border border-cyan-700/40 leading-none select-none" title={entity.name}>{entity.primaryPrefix}</span>
                        </>;
                      })()}
                    </span>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Right pane: Waterfall DSP */}
        <section className={`lg:col-span-7 border border-border-subtle rounded-lg overflow-hidden flex flex-col relative h-[300px] lg:h-auto ${theme === 'dark' ? 'bg-[#050505]' : 'bg-white'}`}>
           <div className="absolute top-0 inset-x-0 bg-black/40 backdrop-blur-sm px-3 py-1 border-b border-border-subtle flex justify-between z-10 pointer-events-none">
            <span className={`text-[9px] font-mono tracking-tighter ${theme === 'dark' ? 'text-[#4caf50]' : 'text-green-600'}`}>WATERFALL (200 - 3000 Hz)</span>
            <div className="flex gap-4">
               <span className="text-[9px] font-mono text-zinc-500">1k</span>
               <span className="text-[9px] font-mono text-zinc-500">2k</span>
               <span className="text-[9px] font-mono text-zinc-500">3k</span>
            </div>
          </div>
          <div className="flex-1 relative bg-black flex items-end">
            <canvas 
               ref={canvasRef}
               width={1024} 
               height={300} 
               className="w-full h-full block cursor-crosshair"
               onClick={handleWaterfallClick}
            />
            {/* TX Frequency Overlay Bar (50 Hz for FT8, 83 Hz for FT4) */}
            <div
               className="absolute top-0 bottom-0 bg-red-500/35 border-x border-red-500/50 pointer-events-none transition-all duration-75"
               style={{
                 left: `${((txFreq - 200) / 2800) * 100}%`,
                 width: `${((mode === 'FT4' ? 83.33 : 50) / 2800) * 100}%`,
                 transform: 'translateX(-50%)'
               }}
            />
            {/* Waterfall Static Vertical Rule */}
            <div className="absolute inset-0 flex pointer-events-none">
               <div className="h-full w-px bg-[#2a2c31]/30 ml-[33.3%]"></div>
               <div className="h-full w-px bg-[#2a2c31]/30 ml-[33.3%]"></div>
            </div>
            {!audioActive && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 font-bold text-zinc-500 z-20 text-xs">
                    AUDIO INACTIVE
                </div>
            )}
          </div>
        </section>
      </div>

      {/* TX Operations Panel */}
      <footer className="bg-header border border-border-subtle rounded-lg p-4 shadow-inner mt-3">
        <div className="flex flex-col lg:flex-row gap-4 items-center justify-between">
          
          <div className="w-full lg:w-auto space-y-3 lg:border-r border-border-subtle lg:pr-6 shrink-0">
            <div className="flex flex-col">
              <label className="text-[9px] uppercase tracking-widest text-text-muted mb-1">My Station</label>
              <div className="flex items-center gap-2 cursor-pointer" onClick={() => setShowSettings(true)}>
                <span className={`border border-border-subtle rounded px-3 py-1.5 text-xs font-mono uppercase font-bold min-w-[80px] text-center ${
                  theme === 'dark' ? 'bg-[#050505] text-[#4caf50]' : 'bg-white text-green-600'
                }`} title="Click to edit in Settings">{myCall}</span>
                <span className={`border border-border-subtle rounded px-3 py-1.5 text-xs font-mono uppercase min-w-[60px] text-center ${
                  theme === 'dark' ? 'bg-[#050505] text-text-muted' : 'bg-white text-text-muted'
                }`} title="Click to edit in Settings">{myGrid}</span>
                <span className={`border border-border-subtle rounded px-3 py-1.5 text-xs font-mono min-w-[80px] text-center ${
                  theme === 'dark' ? 'bg-[#050505] text-text-main' : 'bg-white text-text-main'
                }`} title="Click to edit in Settings">{txFreq} Hz</span>
              </div>
            </div>
            <div className="flex flex-col">
              <label className="text-[9px] uppercase tracking-widest text-text-muted mb-1">Target Station</label>
              <input type="text" value={targetCall} placeholder="DX_CALL" onChange={e => setTargetCall(e.target.value.toUpperCase())} className="bg-app border border-border-input rounded px-2 py-1 text-xs font-mono w-full max-w-[200px] focus:outline-none focus:border-blue-500 text-text-main uppercase" />
            </div>
          </div>

          <div className="w-full lg:w-auto flex-1 grid grid-cols-2 gap-2 px-0 lg:px-4">
             <button 
                onClick={() => {
                  if (autoSequence && fsmRef.current) {
                    fsmRef.current.updateState('CQ_SENDING');
                    setTxEnabled(true);
                  } else {
                    transmitMessage(`CQ ${myCall} ${myGrid.substring(0, 4)}`);
                  }
                }}
                disabled={(!autoSequence && !txEnabled) || isTransmitting || isTxQueued}
                className="h-10 bg-btn border border-border-input hover:bg-btn-hover disabled:opacity-50 disabled:hover:bg-btn text-[10px] font-bold rounded uppercase tracking-wider transition-colors flex items-center justify-center gap-1"
              >
                 CQ {myCall}
             </button>
             
             <button 
                onClick={() => {
                  if (autoSequence && fsmRef.current) {
                    fsmRef.current.targetCall = targetCall;
                    fsmRef.current.updateState('REPLY_SENDING', targetCall);
                    setTxEnabled(true);
                  } else {
                    transmitMessage(`${targetCall} ${myCall} ${myGrid.substring(0, 4)}`);
                  }
                }}
                disabled={(!autoSequence && !txEnabled) || !targetCall || isTransmitting || isTxQueued}
                className="h-10 bg-btn border border-border-input hover:bg-btn-hover disabled:opacity-50 disabled:hover:bg-btn text-[10px] font-bold rounded uppercase tracking-wider transition-colors flex items-center justify-center gap-1"
              >
                 Ans {targetCall || '...'}
             </button>

             {(isTransmitting || isTxQueued) && (
                <div className={`col-span-2 mt-1 flex items-center justify-center gap-2 p-2 ${isTransmitting ? 'bg-rose-950/40 text-rose-400 border-rose-900 animate-pulse' : 'bg-amber-950/40 text-amber-500 border-amber-900'} border rounded font-bold text-[10px] uppercase tracking-widest`}>
                    <Activity size={12} className={isTransmitting ? "" : "opacity-50"} /> {isTransmitting ? 'Transmitting...' : 'TX Queued...'}
                </div>
             )}
          </div>

          <div className="w-full lg:w-auto flex flex-col sm:flex-row gap-3 items-center justify-center lg:pl-6 lg:border-l border-border-subtle mt-4 lg:mt-0 shrink-0">
            {/* Auto Sequence Toggle and FSM State Indicator */}
            <div className="flex flex-col items-center justify-center">
              <button
                 onClick={() => setAutoSequence(!autoSequence)}
                 className={`w-full lg:w-32 h-16 border rounded flex flex-col items-center justify-center gap-1 group transition-all active:scale-95 ${
                   autoSequence 
                     ? (theme === 'dark'
                         ? 'bg-[#0f2a18] border-[#184525] hover:bg-[#153a21] text-green-400 font-bold'
                         : 'bg-green-100 border-green-300 hover:bg-green-200 text-green-800 font-bold')
                     : 'bg-btn border-border-input hover:bg-btn-hover text-text-muted'
                 }`}
              >
                 <span className="text-[9px] font-bold tracking-widest uppercase">AUTO SEQUENCE</span>
                 <span className="text-[10px] font-mono uppercase bg-black/40 px-2 py-0.5 rounded text-sky-400 font-bold tracking-wider">
                   {autoSequence ? fsmState : "OFF"}
                 </span>
              </button>
              {autoSequence && fsmQueue.length > 0 && (
                <div className="w-full lg:w-32 mt-1 max-h-[72px] overflow-y-auto flex flex-col gap-0.5 custom-scrollbar">
                  {fsmQueue.map(c => (
                    <div key={c.callsign} className="flex items-center justify-between px-1.5 py-0.5 rounded bg-black/30 border border-border-subtle/40">
                      <span className="text-[9px] font-mono font-bold text-sky-400 tracking-wide">{c.callsign}</span>
                      <span className="text-[9px] font-mono text-zinc-400">
                        {c.report ?? '?'}{c.distance ? ` ${c.distance}km` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Enable TX PTT Trigger */}
            <div className="flex flex-col items-center justify-center">
              <button 
                 onClick={() => setTxEnabled(!txEnabled)}
                 className={`w-full lg:w-32 h-16 border rounded flex flex-col items-center justify-center gap-1 group transition-all active:scale-95 ${
                   txEnabled 
                     ? (theme === 'dark'
                         ? 'bg-[#2a0e0e] border-[#4a1a1a] hover:bg-[#3a1212] text-[#ff4444]'
                         : 'bg-red-100 border-red-300 hover:bg-red-200 text-red-600')
                     : 'bg-btn border-border-input hover:bg-btn-hover text-text-muted'
                 }`}
              >
                 <span className="text-[10px] font-bold tracking-widest uppercase">{txEnabled ? 'TX Enabled' : 'Enable TX'}</span>
                 <div className={`w-8 h-2 rounded-full relative ${
                   txEnabled 
                     ? (theme === 'dark' ? 'bg-[#4a1a1a]' : 'bg-red-200')
                     : 'bg-panel'
                 }`}>
                   <div className={`absolute left-0 top-0 w-3 h-2 rounded-full transition-all ${
                     txEnabled 
                       ? (theme === 'dark' 
                           ? 'bg-[#ff4444] shadow-[0_0_8px_#ff4444] translate-x-5' 
                           : 'bg-red-600 shadow-[0_0_8px_rgba(220,38,38,0.5)] translate-x-5')
                       : 'bg-[#3a3d45]'
                   }`}></div>
                 </div>
              </button>
              
            </div>
          </div>
        </div>
      </footer>

      {/* Logbook Viewer Section */}
      <div className="w-full mt-3">
         <LogBookViewer 
            maxEntries={maxLogEntries} 
            wavelogEnabled={wavelogEnabled} 
            wavelogUrl={wavelogUrl} 
            wavelogApiKey={wavelogApiKey} 
            wavelogStationProfileId={wavelogStationProfileId}
         />
      </div>

      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-4">
          <div className="bg-panel border border-border-subtle p-6 rounded-lg shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-sm font-bold uppercase tracking-widest text-text-main">Station Configuration</h2>
              <button onClick={() => setShowSettings(false)} className="text-text-muted hover:text-text-main">
                <X size={20} />
              </button>
            </div>
            
            <div className="space-y-4">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">My Callsign</label>
                <input type="text" value={myCall} onChange={e => setMyCall(e.target.value.toUpperCase())} className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main uppercase" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">My Grid Locator</label>
                <input type="text" value={myGrid} onChange={e => setMyGrid(e.target.value.toUpperCase())} className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main uppercase" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Decoder Depth</label>
                <select 
                  value={decodeDepth.toString()}
                  onChange={e => setDecodeDepth(Number(e.target.value))}
                  className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                >
                  <option value="1">1 - Fast (Normal)</option>
                  <option value="2">2 - Deep (Slower, Decodes more)</option>
                  <option value="3">3 - Max (Slowest, Decodes weak signals)</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Max Retries</label>
                <input 
                  type="number" 
                  min="0"
                  max="10"
                  value={maxRetries} 
                  onChange={e => setMaxRetries(Number(e.target.value))} 
                  className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main" 
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Final Message Mode</label>
                <select 
                  value={finalMessageMode}
                  onChange={e => setFinalMessageMode(e.target.value as 'RR73' | 'RRR')}
                  className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                >
                  <option value="RR73">RR73 (Standard, Faster)</option>
                  <option value="RRR">RRR (Requires 73 from target)</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Display Last N QSOs</label>
                <input 
                  type="number" 
                  min="10"
                  max="1000"
                  value={maxLogEntries} 
                  onChange={e => setMaxLogEntries(Number(e.target.value))} 
                  className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main" 
                />
              </div>

              <hr className="border-border-subtle my-2" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#8e9299]">CAT Radio Control</h3>
              
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Protocol Mode</label>
                <select 
                  value={catMode}
                  onChange={e => setCatMode(e.target.value as 'manual' | 'kenwood' | 'yaesu' | 'old-yaesu' | 'elecraft' | 'qdx' | 'icom')}
                  className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                >
                  <option value="manual">Manual (No CAT / iOS)</option>
                  <option value="kenwood">Kenwood</option>
                  <option value="yaesu">Yaesu (FT-710, FTDX10, FT-991A, FT-891)</option>
                  <option value="old-yaesu">Yaesu Old Binary (FT-817, FT-857, FT-897)</option>
                  <option value="elecraft">Elecraft (K3, KX3, KX2, etc.)</option>
                  {/Android/i.test(navigator.userAgent) ? (
                    <option value="qdx" disabled className="text-gray-400">QDX (Unsupported on Android)</option>
                  ) : (
                    <option value="qdx">QDX</option>
                  )}
                  <option value="icom">Icom (CI-V)</option>
                </select>
              </div>

              {catMode !== 'manual' && (
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase tracking-widest text-text-muted">Baud Rate</label>
                  <select 
                    value={catBaudRate}
                    onChange={e => setCatBaudRate(Number(e.target.value))}
                    className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                  >
                    <option value="4800">4800</option>
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                    <option value="38400">38400</option>
                    <option value="57600">57600</option>
                    <option value="115200">115200</option>
                  </select>
                </div>
              )}

              {catMode === 'icom' && (
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase tracking-widest text-text-muted">Icom Address (Hex)</label>
                  <input 
                    type="text" 
                    value={icomAddress} 
                    onChange={e => setIcomAddress(e.target.value.toUpperCase())} 
                    className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main uppercase" 
                    placeholder="94"
                  />
                  <span className="text-[10px] text-text-muted font-mono leading-tight mt-0.5">
                    Common addresses: IC-7300: 94 • IC-705: A4 • IC-7100: 88 • IC-9700: A2 • IC-7610: 98 • IC-7000: 70
                  </span>
                </div>
              )}

              {isDualPort && /Android/i.test(navigator.userAgent) && (
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase tracking-widest text-text-muted">CP2105 Channel</label>
                  <select
                    value={cp2105Channel}
                    onChange={e => setCp2105Channel(Number(e.target.value) as 0 | 1)}
                    className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                  >
                    <option value={0}>Port A — Enhanced (Interface 0)</option>
                    <option value={1}>Port B — Standard (Interface 1)</option>
                  </select>
                </div>
              )}

              {catMode !== 'manual' && (
                <div className="flex flex-col gap-2 pt-2">
                  <div className="flex gap-2">
                    <button
                      onClick={handleSelectSerialPort}
                      className="flex-1 bg-app border border-border-input text-text-main hover:bg-[#4caf50] hover:text-white hover:border-[#4caf50] rounded px-3 py-2 text-xs font-mono font-bold transition-colors"
                    >
                      {serialPort ? 'Port Selected' : 'Select Serial Port'}
                    </button>
                    <button 
                      onClick={handleTestCat}
                      disabled={!serialPort}
                      className="flex-1 bg-app border border-border-input text-text-main hover:bg-[#4caf50] hover:text-white hover:border-[#4caf50] disabled:opacity-50 disabled:hover:bg-app disabled:hover:border-border-input disabled:hover:text-text-main rounded px-3 py-2 text-xs font-mono font-bold transition-colors"
                    >
                      Test CAT
                    </button>
                  </div>
                  {catTestResult && (
                    <div className="text-[10px] font-mono text-center p-1 bg-app border border-border-subtle rounded text-text-muted">
                      {catTestResult}
                    </div>
                  )}
                </div>
              )}

              <hr className="border-border-subtle my-2" />

              <div className="flex items-center justify-between pt-2">
                 <label className="text-[10px] uppercase tracking-widest text-text-muted">Color Scheme</label>
                 <button 
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                    className="bg-app border border-border-input text-text-main rounded px-3 py-1 text-xs font-mono focus:outline-none hover:border-[#4caf50]"
                 >
                    {theme === 'dark' ? 'Dark Mode' : 'Light Mode'}
                 </button>
              </div>

              <div className="flex items-center justify-between pt-2">
                 <div className="flex flex-col">
                    <label className="text-[10px] uppercase tracking-widest text-text-muted">Prevent Screen Off</label>
                    <span className="text-[9px] text-text-muted">Requires mobile Wake Lock support</span>
                 </div>
                 <button 
                    onClick={() => setWakeLockEnabled(!wakeLockEnabled)}
                    className="bg-app border border-border-input text-text-main rounded px-3 py-1 text-xs font-mono focus:outline-none hover:border-[#4caf50]"
                 >
                    {wakeLockEnabled ? 'Enabled' : 'Disabled'}
                 </button>
              </div>

              <hr className="border-border-subtle my-4" />
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#8e9299]">Cloudlog / Wavelog</h3>
                <button 
                    onClick={() => setWavelogEnabled(!wavelogEnabled)}
                    className={`bg-app border rounded px-3 py-1 text-xs font-mono focus:outline-none transition-colors ${wavelogEnabled ? 'border-[#4caf50] text-[#4caf50]' : 'border-border-input text-text-main'}`}
                 >
                    {wavelogEnabled ? 'Enabled' : 'Disabled'}
                 </button>
              </div>

              {wavelogEnabled && (
                <div className="flex flex-col gap-3 mt-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-widest text-text-muted">Server URL</label>
                    <input 
                      type="text" 
                      value={wavelogUrl} 
                      onChange={e => setWavelogUrl(e.target.value)} 
                      className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main" 
                      placeholder="https://log.example.com"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-widest text-text-muted">API Key</label>
                    <input 
                      type="password" 
                      value={wavelogApiKey} 
                      onChange={e => setWavelogApiKey(e.target.value)} 
                      className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main" 
                      placeholder="Your API Key"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-widest text-[#8e9299]">Station Profile ID</label>
                    <input 
                      type="text" 
                      value={wavelogStationProfileId} 
                      onChange={e => setWavelogStationProfileId(e.target.value)} 
                      className="bg-app border border-border-input rounded px-3 py-2 text-sm font-mono w-full focus:outline-none focus:border-[#4caf50] text-text-main" 
                      placeholder="e.g. 5"
                    />
                  </div>
                  <button 
                    onClick={async () => {
                        const btn = document.getElementById('btn-wavelog-test');
                        if (btn) btn.innerText = 'Testing...';
                        const result = await CloudLogService.testWavelogConnection(wavelogUrl, wavelogApiKey, wavelogStationProfileId);
                        if (btn) {
                            if (result.success) {
                                btn.innerText = 'Success!';
                                btn.className = 'w-full bg-[#4caf50]/20 border border-[#4caf50] text-[#4caf50] rounded px-3 py-2 text-xs font-mono font-bold transition-colors';
                                setTimeout(() => {
                                    btn.innerText = 'Test Connection';
                                    btn.className = 'w-full bg-app border border-border-input text-text-main hover:bg-[#4caf50] hover:text-white hover:border-[#4caf50] rounded px-3 py-2 text-xs font-mono font-bold transition-colors';
                                }, 3000);
                            } else {
                                btn.innerText = result.message.length > 50 ? 'Error (Hover for details)' : result.message;
                                btn.title = result.message; // tool tip
                                btn.className = 'w-full bg-red-500/20 border border-red-500 text-red-500 rounded px-3 py-2 text-xs font-mono font-bold transition-colors truncate';
                                setTimeout(() => {
                                    btn.innerText = 'Test Connection';
                                    btn.title = '';
                                    btn.className = 'w-full bg-app border border-border-input text-text-main hover:bg-[#4caf50] hover:text-white hover:border-[#4caf50] rounded px-3 py-2 text-xs font-mono font-bold transition-colors';
                                }, 6000);
                            }
                        }
                    }}
                    id="btn-wavelog-test"
                    disabled={!wavelogUrl || !wavelogApiKey || !wavelogStationProfileId}
                    className="w-full bg-app border border-border-input text-text-main hover:bg-[#4caf50] hover:text-white hover:border-[#4caf50] disabled:opacity-50 disabled:hover:bg-app disabled:hover:border-border-input disabled:hover:text-text-main rounded px-3 py-2 text-xs font-mono font-bold transition-colors"
                  >
                    Test Connection
                  </button>
                </div>
              )}
              
              <hr className="border-border-subtle my-4" />
              
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Audio Input (RX)</label>
                <select 
                  value={selectedDeviceId}
                  onChange={handleDeviceChange}
                  className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                >
                  <option value="">Default Source</option>
                  {audioDevices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Input ${d.deviceId.substring(0,5)}...`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Audio Output (TX)</label>
                <select 
                  value={selectedOutputDeviceId}
                  onChange={handleOutputDeviceChange}
                  className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                >
                  <option value="default">System Default</option>
                  {audioOutputs.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Output ${d.deviceId.substring(0,5)}...`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            
            <div className="mt-8 flex justify-end">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="bg-green-600 dark:bg-[#4caf50] hover:bg-green-600 text-black px-6 py-2 rounded text-xs font-bold uppercase tracking-widest"
                >
                  Save & Close
                </button>
            </div>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-4">
          <div className="bg-panel border border-border-subtle p-6 rounded-lg shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-sm font-bold uppercase tracking-widest text-text-main">About FT8 Web Client</h2>
              <button onClick={() => setShowAbout(false)} className="text-text-muted hover:text-text-main">
                <X size={20} />
              </button>
            </div>
            
            <div className="space-y-4 text-xs text-text-main leading-relaxed">
              <p>Welcome to the Web FT8 Client! This application runs entirely in your browser using the Web Audio API.</p>
              
              <div>
                <h3 className="font-bold text-green-600 dark:text-[#4caf50] mb-1">1. Audio Setup</h3>
                <p>Click "ACTIVATE AUDIO" and allow browser permissions to use the microphone. Adjust your computer's input volume so the <strong>Input Level (VU)</strong> sits in the green/yellow zone, avoiding the red to prevent clipping.</p>
              </div>

              <div>
                <h3 className="font-bold text-green-600 dark:text-[#4caf50] mb-1">2. Configuration</h3>
                <p>Open the <strong>Settings</strong> to set your Call Sign and Grid Square and configure CAT control.</p>
              </div>

              <div>
                <h3 className="font-bold text-green-600 dark:text-[#4caf50] mb-1">3. Operations</h3>
                <p>Select your band using the pill buttons. If CAT is configured, this will change the radio's VFO and poll its frequency.</p>
                <p>FT8 relies strictly on synchronized UTC time. Verify your system clock is accurate. Decodes appear automatically at the :00, :15, :30, and :45 marks.</p>
                <p>Enable TX by pressing Enable TX button. If you initiate a connection manually via CQ or answer from Band Activity, it will wait for the synchronization boundary to transmit.</p>
              </div>

              <div>
                <h3 className="font-bold text-green-600 dark:text-[#4caf50] mb-1">4. Wavelog & Cloudlog Integration</h3>
                <p>You can seamlessly log your completed QSOs directly to your <strong>Wavelog</strong> or <strong>Cloudlog</strong> instance. In Settings, enable the integration and input your instance URL, API Key, and Station Profile ID.</p>
                <p>QSOs are uploaded in real time. If an upload fails, you can use the **Sync All** button or click the manual cloud-upload action icon next to a specific logbook entry to re-trigger the upload. Troubleshooting output will exist in the browser developer tools console.</p>
              </div>

              <div className="pt-4 mt-4 border-t border-border-subtle">
                <h3 className="font-bold text-green-600 dark:text-[#4caf50] mb-1">Tested Radios & Feedback</h3>
                <p className="mb-2"><strong>Officially Tested:</strong> IC-7300, IC-705.</p>
                <p className="mb-2">We need more real-world validation with <strong>Kenwood</strong> and <strong>QDX</strong> transceivers. If you have success running this web app with your radio model, please report it to us on GitHub!</p>
              </div>

              <div className="pt-4 mt-4 border-t border-border-subtle">
                <h3 className="font-bold text-green-600 dark:text-[#4caf50] mb-1">Credits & License</h3>
                <p className="mb-2">Created by <strong>Ondřej Koloničný, OK1CDJ</strong>.</p>
                <p className="mb-2">This project is open-source and licensed under the <strong>GNU General Public License v3 (GPL v3)</strong>.</p>
                <h4 className="font-bold text-text-main mt-4 mb-2">Acknowledgments</h4>
                <ul className="list-disc pl-5 mb-4 space-y-1 text-[11px] text-text-muted">
                  <li><strong className="text-text-main">FT8/FT4 Protocols:</strong> FT8 and FT4 are digital amateur radio modes designed for weak-signal communication, originally developed by <strong>Joe Taylor (K1JT)</strong> and <strong>Steve Franke (K9AN)</strong> as part of the WSJT-X suite.</li>
                  <li><strong className="text-text-main">DSP Implementation:</strong> This application utilizes the pure TypeScript DSP library <a href="https://github.com/e04/ft8ts" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline font-semibold">@e04/ft8ts</a>.</li>
                </ul>

                <div className="flex flex-wrap gap-2 pt-2 border-t border-border-subtle/40">
                  <a 
                    href="https://buymeacoffee.com/ok1cdj" 
                    target="_blank" 
                    rel="noreferrer" 
                    className="inline-flex items-center gap-1.5 bg-[#FFDD00] hover:bg-[#ffea42] text-black font-extrabold px-3 py-1.5 rounded transition-transform hover:scale-102 active:scale-98 shadow-sm text-[11px] uppercase tracking-wide cursor-pointer"
                  >
                    <span className="text-sm">☕</span>
                    <span>Buy me a coffee</span>
                  </a>
                  <a 
                    href="https://github.com/ok1cdj/FT8web" 
                    target="_blank" 
                    rel="noreferrer" 
                    className="inline-flex items-center gap-1.5 bg-btn border border-border-input hover:border-text-main text-text-muted hover:text-text-main px-3 py-1.5 rounded text-[11px] uppercase tracking-wide transition-colors cursor-pointer"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                      <path d="M9 18c-4.51 2-5-2-7-2" />
                    </svg>
                    <span>Report Issue</span>
                  </a>
                </div>
              </div>
            </div>

            <div className="mt-8 flex justify-end">
                <button 
                  onClick={() => setShowAbout(false)}
                  className="bg-app border border-border-input hover:bg-btn text-text-main px-6 py-2 rounded text-xs font-bold uppercase tracking-widest transition-colors"
                >
                  Close
                </button>
            </div>
          </div>
        </div>
      )}
      
      <VersionInfo />
    </div>
  );
}
