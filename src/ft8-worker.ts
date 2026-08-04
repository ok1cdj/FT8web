import { decodeFT8, decodeFT4, HashCallBook } from '@e04/ft8ts';

// Maintain state across decoding cycles (for non-standard callsign parts, etc.)
const hashCallBook = new HashCallBook();

self.onmessage = (e: MessageEvent) => {
  // Prime the hash book with known callsigns (our own call, previously worked
  // compound calls) so hashed/non-standard callsigns resolve immediately instead
  // of showing as "<...>" until the far end re-primes the hash. Persistence lives
  // on the main thread (workers have no localStorage); it replays the list here.
  if (e.data && e.data.type === 'INIT_HASHES') {
    const calls: string[] = Array.isArray(e.data.calls) ? e.data.calls : [];
    for (const c of calls) {
      if (typeof c === 'string' && c.trim()) hashCallBook.save(c);
    }
    return;
  }

  const { audioData, sampleRate, nowString, decodeDepth = 2, mode = 'FT8' } = e.data;

  try {
    const startTime = performance.now();
    const decoder = mode === 'FT4' ? decodeFT4 : decodeFT8;
    const results = decoder(audioData, {
       sampleRate,
       hashCallBook,
       depth: decodeDepth,
       freqLow: 200,
       freqHigh: 3000
    });
    const endTime = performance.now();
    const durationMs = Math.round(endTime - startTime);
    
    if (results && results.length > 0) {
        const formatted = results.map((r: any) => ({
            time: nowString,
            snr: Math.round(r.snr),
            freq: Math.round(r.freq),
            message: r.msg
        }));
        self.postMessage({ type: 'DECODED', payload: formatted, durationMs, count: results.length });
    } else {
        self.postMessage({ type: 'DECODED', payload: [], durationMs, count: 0 });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', error: err.message || 'Unknown processing error' });
  }
};
