import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Activity, Settings, X, HelpCircle } from 'lucide-react';
import { getCaptureWorkletUrl } from './AudioWorkletBlob';
import { encodeFT8 } from '@e04/ft8ts';
import CatManager from './CatManager.js';

export interface FT8DecodedMessage {
  time: string;
  snr: number;
  freq: number;
  message: string;
  isDivider?: boolean;
}

export default function App() {
  const BAND_FREQS = [
    { label: '80m', mhz: '3.5', hz: 3573000 },
    { label: '40m', mhz: '7.0', hz: 7074000 },
    { label: '30m', mhz: '10.1', hz: 10136000 },
    { label: '20m', mhz: '14.0', hz: 14074000 },
    { label: '17m', mhz: '18.1', hz: 18100000 },
    { label: '15m', mhz: '21.0', hz: 21074000 },
    { label: '12m', mhz: '24.9', hz: 24915000 },
    { label: '10m', mhz: '28.0', hz: 28074000 },
    { label: '6m', mhz: '50.3', hz: 50313000 }
  ];

  const [vfoFreq, setVfoFreq] = useState<number>(() => {
    const saved = localStorage.getItem('ft8_vfoFreq');
    return saved ? Number(saved) : 14074000;
  });

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

  // Global Audio State
  const [audioActive, setAudioActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [utcTime, setUtcTime] = useState('00:00:00');
  const [windowProgress, setWindowProgress] = useState(0);
  
  // Device Selection State
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => localStorage.getItem('ft8_audioInputId') || '');
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<string>(() => localStorage.getItem('ft8_audioOutputId') || 'default');

  useEffect(() => {
    localStorage.setItem('ft8_audioInputId', selectedDeviceId);
    localStorage.setItem('ft8_audioOutputId', selectedOutputDeviceId);
  }, [selectedDeviceId, selectedOutputDeviceId]);
  
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

  const [catMode, setCatMode] = useState<'manual'|'kenwood'|'icom'>(() => {
    return (localStorage.getItem('ft8_catMode') as 'manual'|'kenwood'|'icom') || 'manual';
  });
  const [catBaudRate, setCatBaudRate] = useState<number>(() => {
    const saved = localStorage.getItem('ft8_catBaudRate');
    return saved ? Number(saved) : 38400;
  });
  const [icomAddress, setIcomAddress] = useState<string>(() => {
    return localStorage.getItem('ft8_icomAddress') || '94';
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
  }, [myCall, myGrid, txFreq, decodeDepth, maxRetries, finalMessageMode, catMode, catBaudRate, icomAddress]);

  // UI State
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [serialPort, setSerialPort] = useState<any>(null);
  const [catTestResult, setCatTestResult] = useState<string | null>(null);
  
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
      });
      await cat.connect(port);
      catRef.current = cat;
      return cat;
    } catch (e: any) {
      console.error("CAT Init error:", e);
      throw e;
    }
  };

  // Poll CAT frequency
  useEffect(() => {
    if (!serialPort || catMode === 'manual') {
      catRef.current = null;
      return;
    }

    let interval: any;

    const startPolling = () => {
      interval = setInterval(() => {
        if (catRef.current) {
          catRef.current.getFrequency()
            .then(freq => {
              if (freq > 0) setVfoFreq(freq);
            })
            .catch(() => {});
        }
      }, 2000);
    };

    if (!catRef.current) {
      initCatManager(serialPort)
        .then(() => startPolling())
        .catch(e => setCatTestResult("Auto-init error: " + e.message));
    } else {
      startPolling();
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [serialPort, catMode, catBaudRate, icomAddress]);

  const selectBand = (hz: number) => {
    setVfoFreq(hz);
    if (catRef.current && catMode !== 'manual') {
      catRef.current.setFrequency(hz).catch(e => console.error("CAT Set Freq Error:", e));
    }
  };

  const formatFrequency = (hz: number) => {
    return hz.toLocaleString('en-US').replace(/,/g, '.') + ' Hz';
  };

  const handleSelectSerialPort = async () => {
    try {
      if (!('serial' in navigator)) {
        setCatTestResult("Web Serial API not supported in this browser. Try opening in a new tab or use Chrome/Edge.");
        return;
      }
      const port = await (navigator as any).serial.requestPort();
      setSerialPort(port);
      catRef.current = null; // Forces re-init in the polling effect
      setCatTestResult("Port selected successfully. Ready to test.");
    } catch (e: any) {
      console.error(e);
      let errorMsg = "Error selecting port: " + e.message;
      if (e.message?.includes('permission') || e.message?.includes('disallowed')) {
          errorMsg += ". Try opening the app in a new tab.";
      }
      setCatTestResult(errorMsg);
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
  const [isTxQueued, setIsTxQueued] = useState(false);
  
  // TX Controls State
  const [targetCall, setTargetCall] = useState('');
  const [txEnabled, setTxEnabled] = useState(false);

  // Refs for Worker Access
  const myCallRef = useRef<string>(myCall);
  const targetCallRef = useRef<string>('');
  const txPeriodRef = useRef<number>(txPeriod);
  
  useEffect(() => {
    myCallRef.current = myCall;
  }, [myCall]);
  
  useEffect(() => {
    targetCallRef.current = targetCall;
  }, [targetCall]);

  useEffect(() => {
    txPeriodRef.current = txPeriod;
  }, [txPeriod]);

  // Core References

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const txSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const queuedTxMessageRef = useRef<string | null>(null);

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
  }, []);

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
  const lastPeriodRef = useRef<number>(-1);

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
        if (e.data.payload.length > 0) {
            setRxLog(prev => {
                const timeString = e.data.payload[0].time;
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
                const newLog = [divider, ...e.data.payload, ...prev];
                return newLog.slice(0, 100); 
            });
            
            // Route to QSO Log based on rules
            const incomingQsoMessages = e.data.payload.filter((msg: FT8DecodedMessage) => {
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
                    const timeString = incomingQsoMessages[0].time;
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
                    const newLog = [divider, ...incomingQsoMessages.reverse(), ...prev];
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
    if (isTransmitting) return;

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

    // Period Markers (15s boundaries)
    const currentDate = new Date();
    const seconds = currentDate.getUTCSeconds();
    
    if (seconds % 15 === 0 && lastPeriodRef.current !== seconds) {
      lastPeriodRef.current = seconds;
      
      // Draw divider line
      ctx.fillStyle = 'rgba(255, 215, 0, 0.4)'; // Semi-transparent gold
      ctx.fillRect(0, 0, width, 1);
      
      // Target text cleanly below the line (at Y=12)
      ctx.fillStyle = 'rgba(255, 215, 0, 0.9)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText(currentDate.toISOString().substring(11, 19) + ' UTC', 4, 12);
    }
  }, [isTransmitting]);

  const toggleAudio = async (forcedDeviceId?: string) => {
    const targetDeviceId = typeof forcedDeviceId === 'string' ? forcedDeviceId : selectedDeviceId;
    
    if (audioActive && typeof forcedDeviceId === 'undefined') {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(t => t.stop());
            mediaStreamRef.current = null;
        }
        if (audioCtxRef.current && audioCtxRef.current.state === 'running') {
            await audioCtxRef.current.suspend();
        }
        setAudioActive(false);
        setAudioLevel(0);
        return;
    }

    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
          // Must be derived via user interaction for iOS strict compliance
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
      
      if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(t => t.stop());
      }
      if (sourceNodeRef.current) {
          sourceNodeRef.current.disconnect();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          ...(targetDeviceId ? { deviceId: { exact: targetDeviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false, 
        } 
      });
      mediaStreamRef.current = stream;
      
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
              // Scale RMS roughly to 0-100 progress
              setAudioLevel(Math.min(100, rms * 1500)); 
              
              // Only accumulate if we are in the 0.0 - 13.0s recording window
              const now = new Date();
              const secondsInWindow = (now.getUTCSeconds() + now.getUTCMilliseconds() / 1000) % 15;
              
              if (secondsInWindow < 13.0) {
                  // Accumulate raw payload
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

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newId = e.target.value;
      setSelectedDeviceId(newId);
      if (audioActive) {
          toggleAudio(newId);
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
  const transmitMessage = async (message: string) => {
    if (!audioCtxRef.current || isTransmitting || isTxQueued || !txEnabled) return;
    
    // Guarantee audio is alive before queuing
    if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
    }
    
    queuedTxMessageRef.current = message;
    setIsTxQueued(true);
  };

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
      
      const currentPeriod = Math.floor(seconds / 15);
      const secondsInWindow = totalSeconds % 15;
      
      setWindowProgress((secondsInWindow / 15) * 100);
      setUtcTime(now.toISOString().substring(11, 19));
      
      // Epoch boundary: 0.0s mark
      if (currentPeriod !== periodState.lastPeriod && periodState.lastPeriod !== -1) {
        periodState.lastPeriod = currentPeriod;
        periodState.decodedThisPeriod = false;
        
        // Start TX exactly at 0.0s if queued and matches selected period
        if (queuedTxMessageRef.current && txEnabled && currentPeriod % 2 === txPeriodRef.current) {
            const message = queuedTxMessageRef.current;
            queuedTxMessageRef.current = null;
            setIsTxQueued(false);
            setIsTransmitting(true);
            
            // Add to QSO Log
            setQsoLog(prev => {
                const nowString = now.toISOString().substring(11, 19).replace(/:/g, '');
                return [{
                    time: nowString,
                    snr: 0,
                    freq: txFreq,
                    message: "-> " + message,
                    isTx: true
                }, ...prev].slice(0, 100);
            });
            
            const ctx = audioCtxRef.current;
            if (ctx && ctx.state !== 'suspended') {
                if (typeof (ctx as any).setSinkId === 'function') {
                    (ctx as any).setSinkId(selectedOutputDeviceId).catch((e: any) => console.error("setSinkId fail:", e));
                }
                
                try {
                    // Generate the FT8 waveform for 15 seconds
                    const audioData = encodeFT8(message, { 
                      sampleRate: ctx.sampleRate,
                      baseFrequency: txFreq 
                    });
                    
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
                    };
                } catch (err) {
                    console.error("FT8 Encoding Error:", err);
                    setIsTransmitting(false);
                }
            } else {
                setIsTransmitting(false);
            }
        }
        
        // Clear RX buffer for the new recording period
        rxBufferRef.current = new Float32Array(0);
      } else if (currentPeriod !== periodState.lastPeriod) {
        // Init first run
        periodState.lastPeriod = currentPeriod;
      }

      // 13.0s mark trigger to Decode
      if (secondsInWindow >= 13.0 && !periodState.decodedThisPeriod) {
        periodState.decodedThisPeriod = true;
        const audioData = rxBufferRef.current;
        
        if (audioActive && audioCtxRef.current && audioData.length > 0) {
            if (workerRef.current) {
                const periodStartSeconds = Math.floor(now.getUTCSeconds() / 15) * 15;
                const periodStart = new Date(now.getTime());
                periodStart.setUTCSeconds(periodStartSeconds, 0);
                const nowString = periodStart.toISOString().substring(11, 19).replace(/:/g, '');
                
                workerRef.current.postMessage({
                    audioData,
                    sampleRate: audioCtxRef.current.sampleRate,
                    nowString,
                    decodeDepth
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
  }, [audioActive, drawWaterfall, decodeDepth, txEnabled, txFreq, selectedOutputDeviceId]);

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
          <span className="text-[26px] font-mono font-bold text-green-600 dark:text-[#4caf50] leading-none tracking-tight">
            {formatFrequency(vfoFreq)}
          </span>
        </div>

        <div className="flex flex-col items-center">
          <span className="text-[10px] uppercase tracking-widest text-text-muted mb-1">FT8 Window (15s Sync)</span>
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
        
        {/* PTT Period Toggle */}
        <button
          onClick={() => setTxPeriod(p => p === 0 ? 1 : 0)}
          className={`shrink-0 px-4 py-1.5 rounded text-[11px] font-mono uppercase font-bold border transition-colors ${
            txPeriod === 0 
              ? 'bg-[#0f2e1b] text-green-400 border-green-800 hover:bg-[#154628]' 
              : 'bg-[#3d1f05] text-amber-500 border-amber-700 hover:bg-[#5a2e07]'
          }`}
        >
          Tx: {txPeriod === 0 ? 'Even (:00)' : 'Odd (:15)'}
        </button>
      </div>

      {/* Main Working Environment */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-[400px]">
        
        {/* Left pane: Logs */}
        <section className="lg:col-span-5 flex flex-col gap-3 min-h-0">
          
          {/* Band Activity (Global Log) */}
          <div className="bg-panel border border-border-subtle rounded-lg flex flex-col min-h-[250px] flex-1">
            <div className="bg-header border-b border-border-subtle px-3 py-2 flex justify-between items-center rounded-t-lg">
              <h3 className="text-[11px] font-bold text-text-muted tracking-widest uppercase flex items-center gap-2">
                <Activity size={14} className="text-green-600 dark:text-[#4caf50]"/> 
                Band Activity
                {decodeStats && (
                  <span className={`normal-case tracking-normal ${decodeStats.durationMs > 1500 ? "text-orange-400" : "text-zinc-500"}`}>
                    ({decodeStats.count} stations in {decodeStats.durationMs}ms)
                  </span>
                )}
              </h3>
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
                {rxLog.map((log, i) => (
                  log.isDivider ? (
                    <div key={i} className="flex items-center justify-center py-2 opacity-50">
                       <span className="text-[9px] font-mono tracking-widest text-text-muted">{log.message}</span>
                    </div>
                  ) : (
                  <div 
                    key={i}
                    onClick={() => {
                      const parts = log.message.split(' ');
                      if(parts[0] === 'CQ') setTargetCall(parts[1]); 
                      else setTargetCall(parts[0]);
                      
                      // Auto-set TX period to the OPPOSITE of the caller's period
                      const seconds = parseInt(log.time.substring(4, 6), 10);
                      const callerPeriod = Math.floor(seconds / 15) % 2; // 0 for even, 1 for odd
                      setTxPeriod(callerPeriod === 0 ? 1 : 0);
                    }}
                    className="grid grid-cols-[55px_40px_60px_1fr] gap-2 hover:bg-btn cursor-pointer p-1 rounded transition-colors group text-[11px] items-center"
                  >
                    <span className="text-zinc-500">{log.time}</span>
                    <span className={log.snr > -10 ? 'text-green-400' : 'text-red-400'}>{log.snr}</span>
                    <span className="text-blue-400">{log.freq}Hz</span>
                    <span className="text-text-main group-hover:text-text-highlight font-bold">{log.message}</span>
                  </div>
                  )
                ))}
              </div>
            </div>
          </div>

          {/* QSO Window (Targeted Log) */}
          <div className="bg-qso border border-border-subtle rounded-lg flex flex-col min-h-[250px] flex-1">
            <div className="bg-header border-b border-border-subtle px-3 py-2 flex justify-between items-center rounded-t-lg">
              <h3 className="text-[11px] font-bold text-text-muted tracking-widest uppercase flex items-center gap-2">
                <Activity size={14} className="text-green-600 dark:text-[#4caf50]"/> 
                Active QSO
              </h3>
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
                  let textClass = "text-text-main font-bold";
                  if (log.isTx) textClass = "text-sky-300 font-bold";
                  else if (log.isIncoming) textClass = "text-green-400 font-bold";
                  
                  return log.isDivider ? (
                    <div key={i} className="flex items-center justify-center py-2 opacity-50">
                       <span className="text-[9px] font-mono tracking-widest text-text-muted">{log.message}</span>
                    </div>
                  ) : (
                  <div 
                    key={i}
                    onClick={() => {
                      const parts = log.message.split(' ');
                      if(parts[0] === 'CQ') setTargetCall(parts[1]); 
                      else if (!log.isTx) setTargetCall(parts[0]);

                      // If incoming message, set TX period to OPPOSITE of caller's period
                      if (!log.isTx && log.time && log.time.length >= 6) {
                        const seconds = parseInt(log.time.substring(4, 6), 10);
                        const callerPeriod = Math.floor(seconds / 15) % 2;
                        setTxPeriod(callerPeriod === 0 ? 1 : 0);
                      }
                    }}
                    className="grid grid-cols-[55px_40px_60px_1fr] gap-2 hover:bg-btn cursor-pointer p-1 rounded transition-colors group text-[11px] items-center"
                  >
                    <span className="text-zinc-500">{log.time}</span>
                    <span className={log.isTx ? 'text-zinc-500' : (log.snr > -10 ? 'text-green-400' : 'text-red-400')}>{log.isTx ? '--' : log.snr}</span>
                    <span className="text-blue-400">{log.freq}Hz</span>
                    <span className={`group-hover:text-text-highlight ${textClass}`}>{log.message}</span>
                  </div>
                  )
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Right pane: Waterfall DSP */}
        <section className="lg:col-span-7 bg-white dark:bg-[#050505] border border-border-subtle rounded-lg overflow-hidden flex flex-col relative h-[300px] lg:h-auto">
           <div className="absolute top-0 inset-x-0 bg-black/40 backdrop-blur-sm px-3 py-1 border-b border-border-subtle flex justify-between z-10 pointer-events-none">
            <span className="text-[9px] font-mono tracking-tighter text-green-600 dark:text-[#4caf50]">WATERFALL (200 - 3000 Hz)</span>
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
            {/* TX Frequency Overlay Bar (50 Hz wide) */}
            <div 
               className="absolute top-0 bottom-0 bg-red-500/35 border-x border-red-500/50 pointer-events-none transition-all duration-75"
               style={{ 
                 left: `${((txFreq - 200) / 2800) * 100}%`, 
                 width: `${(50 / 2800) * 100}%`,
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
                <span className="bg-white dark:bg-[#050505] border border-border-subtle rounded px-3 py-1.5 text-xs font-mono text-green-600 dark:text-[#4caf50] uppercase font-bold min-w-[80px] text-center" title="Click to edit in Settings">{myCall}</span>
                <span className="bg-white dark:bg-[#050505] border border-border-subtle rounded px-3 py-1.5 text-xs font-mono text-text-muted uppercase min-w-[60px] text-center" title="Click to edit in Settings">{myGrid}</span>
                <span className="bg-white dark:bg-[#050505] border border-border-subtle rounded px-3 py-1.5 text-xs font-mono text-text-main min-w-[80px] text-center" title="Click to edit in Settings">{txFreq} Hz</span>
              </div>
            </div>
            <div className="flex flex-col">
              <label className="text-[9px] uppercase tracking-widest text-text-muted mb-1">Target Station</label>
              <input type="text" value={targetCall} placeholder="DX_CALL" onChange={e => setTargetCall(e.target.value.toUpperCase())} className="bg-app border border-border-input rounded px-2 py-1 text-xs font-mono w-full max-w-[200px] focus:outline-none focus:border-blue-500 text-text-main uppercase" />
            </div>
          </div>

          <div className="w-full lg:w-auto flex-1 grid grid-cols-2 gap-2 px-0 lg:px-4">
             <button 
                onClick={() => transmitMessage(`CQ ${myCall} ${myGrid}`)}
                disabled={!txEnabled || isTransmitting || isTxQueued}
                className="h-10 bg-btn border border-border-input hover:bg-btn-hover disabled:opacity-50 disabled:hover:bg-btn text-[10px] font-bold rounded uppercase tracking-wider transition-colors flex items-center justify-center gap-1"
              >
                 CQ {myCall}
             </button>
             
             <button 
                onClick={() => transmitMessage(`${targetCall} ${myCall} ${myGrid}`)}
                disabled={!txEnabled || !targetCall || isTransmitting || isTxQueued}
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

          <div className="w-full lg:w-auto flex flex-col items-center justify-center lg:pl-6 lg:border-l border-border-subtle mt-4 lg:mt-0 shrink-0">
            <button 
               onClick={() => setTxEnabled(!txEnabled)}
               className={`w-full lg:w-32 h-16 border rounded flex flex-col items-center justify-center gap-1 group transition-all active:scale-95 ${
                 txEnabled 
                   ? 'bg-[#2a0e0e] border-[#4a1a1a] hover:bg-[#3a1212] text-[#ff4444]'
                   : 'bg-btn border-border-input hover:bg-btn-hover text-text-muted'
               }`}
            >
               <span className="text-[10px] font-bold tracking-widest uppercase">{txEnabled ? 'TX Enabled' : 'Enable TX'}</span>
               <div className={`w-8 h-2 rounded-full relative ${txEnabled ? 'bg-[#4a1a1a]' : 'bg-panel'}`}>
                 <div className={`absolute left-0 top-0 w-3 h-2 rounded-full transition-all ${txEnabled ? 'bg-[#ff4444] shadow-[0_0_8px_#ff4444] translate-x-5' : 'bg-[#3a3d45]'}`}></div>
               </div>
            </button>
            <p className="text-[8px] text-text-muted mt-2 italic text-center w-full lg:w-32">Awaiting VOX sync at :00... :45</p>
          </div>
        </div>
      </footer>

      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-4">
          <div className="bg-panel border border-border-subtle p-6 rounded-lg shadow-2xl w-full max-w-md">
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

              <hr className="border-border-subtle my-2" />
              <h3 className="text-xs font-bold uppercase tracking-widest text-[#8e9299]">CAT Radio Control</h3>
              
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-text-muted">Protocol Mode</label>
                <select 
                  value={catMode}
                  onChange={e => setCatMode(e.target.value as 'manual' | 'kenwood' | 'icom')}
                  className="bg-app border border-border-input text-text-main rounded px-3 py-2 text-xs font-mono w-full focus:outline-none focus:border-[#4caf50]"
                >
                  <option value="manual">Manual (No CAT / iOS)</option>
                  <option value="kenwood">Kenwood / QDX</option>
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
          <div className="bg-panel border border-border-subtle p-6 rounded-lg shadow-2xl w-full max-w-md max-h-[80vh] overflow-y-auto">
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

              <div className="pt-4 mt-4 border-t border-border-subtle">
                <h3 className="font-bold text-green-600 dark:text-[#4caf50] mb-1">Credits & License</h3>
                <p className="mb-2">Created by <strong>Ondřej Koloničný, OK1CDJ</strong>.</p>
                <p className="mb-2">This application utilizes the <a href="https://github.com/e04/ft8ts" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 underline">ft8ts</a> library for FT8 decoding and encoding.</p>
                <p>Licensed under the <strong>GNU General Public License v3.0 (GPL-3.0)</strong>.</p>
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
    </div>
  );
}
