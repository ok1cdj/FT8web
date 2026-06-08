import { decodeFT8, HashCallBook } from '@e04/ft8ts';

// Maintain state across decoding cycles (for non-standard callsign parts, etc.)
const hashCallBook = new HashCallBook();

self.onmessage = (e: MessageEvent) => {
  const { audioData, sampleRate, nowString, decodeDepth = 2 } = e.data;
  
  try {
    const results = decodeFT8(audioData, { 
       sampleRate,
       hashCallBook,
       depth: decodeDepth,
       freqLow: 200,
       freqHigh: 3000
    });
    
    if (results && results.length > 0) {
        const formatted = results.map((r: any) => ({
            time: nowString,
            snr: Math.round(r.snr),
            freq: Math.round(r.freq),
            message: r.msg
        }));
        self.postMessage({ type: 'DECODED', payload: formatted });
    } else {
        self.postMessage({ type: 'DECODED', payload: [] });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', error: err.message || 'Unknown processing error' });
  }
};
