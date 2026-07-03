export interface DxccEntity {
    name: string;
    adifCode: number;
    cqZone: number;
    ituZone: number;
    continent: string;
    primaryPrefix: string;
}

const NON_ENTITY = new Set(['P', 'M', 'MM', 'AM', 'QRP', 'QRPP', 'LH', 'ANT']);

class DxccService {
    private prefixMap = new Map<string, DxccEntity>();
    private adifCodeMap = new Map<number, DxccEntity>();
    private cache = new Map<string, DxccEntity | null>();
    public loaded = false;

    async load(url = '/cty.dat'): Promise<void> {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.parseCtyDat(await res.text());
            this.cache.clear();
            this.loaded = true;
        } catch (e) {
            console.warn('[DxccService] Failed to load cty.dat:', e);
        }
    }

    private parseCtyDat(text: string): void {
        const lines = text.split('\n');
        let current: DxccEntity | null = null;

        for (const raw of lines) {
            const line = raw.trimEnd();
            if (!line) continue;

            if (!/^\s/.test(line)) {
                // Header line — not indented
                const parts = line.split(':');
                if (parts.length < 9) continue;
                const primaryPrefix = parts[7].trim();
                const adifCode = parseInt(parts[8].trim(), 10);
                current = {
                    name: parts[0].trim(),
                    cqZone: parseInt(parts[1].trim(), 10),
                    ituZone: parseInt(parts[2].trim(), 10),
                    continent: parts[3].trim(),
                    primaryPrefix,
                    adifCode: isNaN(adifCode) ? 0 : adifCode,
                };
                this.prefixMap.set(primaryPrefix, current);
                if (current.adifCode > 0) {
                    this.adifCodeMap.set(current.adifCode, current);
                }
            } else if (current) {
                // Continuation line — comma-separated prefixes, ends with ';'
                const tokens = line.replace(/;$/, '').split(',');
                for (const token of tokens) {
                    const t = token.trim();
                    if (!t) continue;
                    // Strip leading = (exact-match marker) and trailing (...)[...] zone overrides
                    const normalized = t
                        .replace(/^=/, '')
                        .replace(/[\[(][^\]\)]*[\]\)]/g, '')
                        .trim()
                        .toUpperCase();
                    if (normalized && /^[A-Z0-9]+$/.test(normalized)) {
                        this.prefixMap.set(normalized, current);
                    }
                }
            }
        }
    }

    lookup(callsign: string): DxccEntity | null {
        const key = callsign.toUpperCase();
        if (this.cache.has(key)) return this.cache.get(key)!;
        const result = this.resolve(key);
        this.cache.set(key, result);
        return result;
    }

    private resolve(callsign: string): DxccEntity | null {
        const upper = callsign.replace(/[^A-Z0-9/]/g, '');
        if (!upper.includes('/')) return this.resolvePrefix(upper);

        const parts = upper.split('/').filter(p => p && !NON_ENTITY.has(p));
        // Shorter part first — portable prefix convention (V4 in OK1CDJ/V4)
        parts.sort((a, b) => a.length - b.length);
        for (const part of parts) {
            const entity = this.resolvePrefix(part);
            if (entity) return entity;
        }
        return null;
    }

    private resolvePrefix(call: string): DxccEntity | null {
        for (let len = Math.min(call.length, 7); len >= 1; len--) {
            const entity = this.prefixMap.get(call.substring(0, len));
            if (entity) return entity;
        }
        return null;
    }

    getByAdifCode(code: number): DxccEntity | null {
        return this.adifCodeMap.get(code) ?? null;
    }
}

export const dxccService = new DxccService();
