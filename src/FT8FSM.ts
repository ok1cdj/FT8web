export interface FT8DecodedMessage {
    time: string;
    snr: number;
    freq: number;
    message: string;
    isDivider?: boolean;
    isTx?: boolean;
    isIncoming?: boolean;
}

export interface FSMConfig {
    myCall?: string;
    myGrid?: string;
    myPeriod?: number; // 0 = Even, 1 = Odd
    maxRetries?: number;
    directReportCall?: boolean;
    finalMessageMode?: 'RR73' | 'RRR';
    currentState?: string;
    targetCall?: string | null;
    targetGrid?: string | null;
    targetReport?: string | null;
    isTxEnabled?: boolean;
}

export interface QueuedCaller {
    callsign: string;
    grid: string | null;
    distance: number;
    report?: string | null;
    receivedSnr?: number;
}

export interface QSOData {
    call: string;
    grid: string | null;
    rst_sent: string | null;
    rst_rcvd: string | null;
}

export default class FT8FSM {
    public myCall: string;
    public myGrid: string;
    public myPeriod: number;
    public maxRetries: number;
    public directReportCall: boolean;
    public finalMessageMode: 'RR73' | 'RRR';
    
    public currentState: string;
    public targetCall: string | null;
    public targetGrid: string | null;
    public targetReport: string | null;
    public myReceivedReport: string | null;
    public retryCount: number;
    public hasTransmittedThisQso: boolean;
    public callerQueue: QueuedCaller[];
    public isTxEnabled: boolean;

    // Callback hooks
    public onAppendGlobalLog: (line: string) => void = () => {};
    public onAppendQsoLog: (msg: string, isTx: boolean, isDivider: boolean) => void = () => {};
    public onTransmit: (msg: string) => void = () => {};
    public onStateChange: (state: string, targetCall: string | null, queue: QueuedCaller[]) => void = () => {};
    public onLogQSO: (qso: QSOData) => void = () => {};

    constructor(config: FSMConfig = {}) {
        this.myCall = config.myCall || "OK1AAA";
        this.myGrid = config.myGrid || "JN79";
        this.myPeriod = config.myPeriod !== undefined ? config.myPeriod : 0;
        this.maxRetries = config.maxRetries || 4;
        this.directReportCall = config.directReportCall || false;
        this.finalMessageMode = config.finalMessageMode || 'RR73';
        
        this.currentState = config.currentState || 'IDLE';
        this.targetCall = config.targetCall || null;
        this.targetGrid = config.targetGrid || null;
        this.targetReport = config.targetReport || null;
        this.myReceivedReport = null;
        this.retryCount = 0;
        this.hasTransmittedThisQso = false;
        this.callerQueue = [];
        this.isTxEnabled = config.isTxEnabled || false;
    }

    /**
     * True when `call` can be packed as a standard FT8 Type-1 callsign.
     * Mirrors parseCallsign() in @e04/ft8ts (pack_jt77.ts): a /R or /P suffix is
     * allowed, but any other '/' (a compound call like OE/OK1CDJ) or an unusual
     * call-area-digit position makes it non-standard and forces Type-4 (hashed)
     * encoding, which cannot carry a grid or a numeric signal report.
     */
    private isStandardCall(raw: string | null): boolean {
        let call = (raw || '').trim().toUpperCase();
        if (call.endsWith('/R')) call = call.slice(0, -2);
        if (call.endsWith('/P')) call = call.slice(0, -2);

        const isLetter = (c: string) => c >= 'A' && c <= 'Z';
        const isDigit = (c: string) => c >= '0' && c <= '9';

        // Find the call-area digit (last digit in the call, not at index 0).
        let iarea = -1;
        for (let i = call.length - 1; i >= 1; i--) {
            if (isDigit(call[i] ?? '')) { iarea = i; break; }
        }
        if (iarea < 1) return false;

        let npdig = 0, nplet = 0;
        for (let i = 0; i < iarea; i++) {
            if (isDigit(call[i] ?? '')) npdig++;
            if (isLetter(call[i] ?? '')) nplet++;
        }
        let nslet = 0;
        for (let i = iarea + 1; i < call.length; i++) {
            if (isLetter(call[i] ?? '')) nslet++;
        }
        return iarea >= 1 && iarea <= 2 && nplet >= 1 && npdig < iarea && nslet <= 3;
    }

    /** Strip <> brackets, whitespace and case so two callsign tokens can be compared. */
    private normalizeCall(raw: string | null): string {
        return (raw || '').replace(/[<>]/g, '').trim().toUpperCase();
    }

    /** Whitespace/bracket/case-insensitive callsign equality. */
    private callsMatch(a: string | null, b: string | null): boolean {
        const na = this.normalizeCall(a);
        const nb = this.normalizeCall(b);
        return na !== '' && na === nb;
    }

    /** True when BOTH sides are non-standard — unsupported in v1 (cannot exchange). */
    private bothNonStandard(): boolean {
        return !this.isStandardCall(this.myCall) && !this.isStandardCall(this.targetCall);
    }

    /**
     * Render a callsign for a QSO message. Standard calls are sent verbatim; a
     * non-standard (compound) call is sent as its hash `<CALL>` so the message
     * packs as a normal Type-1 frame that can carry a grid or a signal report.
     * The full compound call travels only in the CQ (Type 4), which seeds the
     * hash on every receiver so these `<CALL>` references resolve.
     */
    private renderCall(call: string | null): string {
        if (this.isStandardCall(call)) return (call || '').trim();
        return `<${this.normalizeCall(call)}>`;
    }

    /**
     * Log the current QSO and either pick up the next queued caller or return to
     * IDLE. Shared by the RX "plain 73 received" path and the TX "sent RR73/73"
     * path so the completion logic lives in one place.
     */
    private logCurrentQsoAndAdvance(): void {
        if (this.targetCall) {
            this.onLogQSO({
                call: this.targetCall,
                grid: this.targetGrid,
                rst_sent: this.targetReport,
                rst_rcvd: this.myReceivedReport,
            });
        }

        if (this.callerQueue.length > 0) {
            const next = this.callerQueue.shift()!;
            this.targetCall = next.callsign;
            this.targetGrid = next.grid;
            this.myReceivedReport = next.report || null;
            const snr = next.receivedSnr ?? -12;
            const formattedSnr = snr >= 0
                ? `+${String(snr).padStart(2, '0')}`
                : `-${String(Math.abs(snr)).padStart(2, '0')}`;
            this.targetReport = formattedSnr;
            // If the caller already sent us a report, skip the grid exchange and go
            // straight to the R-report; otherwise start the normal report handshake.
            this.currentState = next.report != null ? 'SENDING_R_REPORT' : 'SENDING_REPORT';
            this.retryCount = 0;
            this.hasTransmittedThisQso = false;
            this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
        } else {
            this.resetToIdle();
        }
    }

    private _gridToLatLon(str: string | null) {
        if (!str || str.length < 4) return null;
        str = str.toUpperCase();
        const lon = (str.charCodeAt(0) - 65) * 20 - 180 + parseInt(str[2], 10) * 2 + 1;
        const lat = (str.charCodeAt(1) - 65) * 10 - 90 + parseInt(str[3], 10) * 1 + 0.5;
        if (isNaN(lat) || isNaN(lon)) return null;
        return { lat, lon };
    }

    public calculateDistance(grid1: string | null, grid2: string | null): number {
        const p1 = this._gridToLatLon(grid1);
        const p2 = this._gridToLatLon(grid2);
        if (!p1 || !p2) return 0;
        
        const R = 6371; // Earth radius in km
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLon = (p2.lon - p1.lon) * Math.PI / 180;
        const lat1 = p1.lat * Math.PI / 180;
        const lat2 = p2.lat * Math.PI / 180;

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2); 
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
        return Math.round(R * c);
    }

    public updateState(newState: string, targetCall: string | null = this.targetCall) {
        if (targetCall !== this.targetCall || newState === 'REPLY_SENDING' || newState === 'SENDING_REPORT') {
            this.retryCount = 0;
            this.hasTransmittedThisQso = false;
        }
        this.currentState = newState;
        this.targetCall = targetCall;
        this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
    }

    public resetToIdle() {
        this.currentState = 'IDLE';
        this.targetCall = null;
        this.targetGrid = null;
        this.targetReport = null;
        this.myReceivedReport = null;
        this.retryCount = 0;
        this.hasTransmittedThisQso = false;
        this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
    }

    /**
     * Triggered externally at every period boundary. currentPeriod is the
     * absolute period index (0, 1, 2, …) computed by the timing loop using
     * the correct period length for the active mode (15 s for FT8, 7.5 s for FT4).
     */
    public onPeriodStart(currentPeriod: number) {
        if (!this.isTxEnabled) return;

        // Check if we are allowed to TX in the current slot
        const periodIndex = currentPeriod % 2;
        if (periodIndex !== this.myPeriod) return;

        // v1 does not support QSOs where BOTH calls are non-standard: FT8 cannot
        // carry two hashed callsigns in one message, so the message would fall back
        // to free text. Skip transmitting rather than emit garbage. (CQ only ever
        // involves our own call, so it is unaffected.)
        if (this.currentState !== 'IDLE' && this.currentState !== 'CQ_SENDING' && this.bothNonStandard()) {
            this.onAppendQsoLog(`[SKIP: both calls non-standard — unsupported]`, false, true);
            this.resetToIdle();
            return;
        }

        let txString: string | null = null;
        let completeQso = false;

        switch (this.currentState) {
            case 'IDLE':
                break;
            case 'CQ_SENDING':
                // The CQ is the only message that carries the compound call in full
                // (Type 4) — it seeds our hash on every receiver. A Type-4 CQ cannot
                // carry a grid, so drop it for a non-standard call.
                txString = this.isStandardCall(this.myCall)
                    ? `CQ ${this.myCall} ${(this.myGrid || '').substring(0, 4)}`.trim()
                    : `CQ ${this.myCall}`;
                break;
            case 'REPLY_SENDING':
                if (!this.isStandardCall(this.myCall)) {
                    // Answering a CQ with a compound call: our FIRST transmission must
                    // carry our call IN FULL so the far end learns its hash. A hashed
                    // <ourcall> here would be unresolvable to them — they have never
                    // heard us (unlike when we call CQ, which seeds the hash). This
                    // packs as a Type-4 frame (the standard target is hashed, our call
                    // rides in full) and cannot carry a grid. Once they reply — proving
                    // they learned us — the RX side advances us to the report handshake.
                    txString = `<${this.normalizeCall(this.targetCall)}> ${this.myCall.trim()}`;
                } else if (this.directReportCall) {
                    // User opted to skip the grid (TX1) and send the report directly.
                    txString = `${this.renderCall(this.targetCall)} ${this.renderCall(this.myCall)} ${this.targetReport || '-12'}`;
                    this.currentState = 'SENDING_REPORT';
                    this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                } else {
                    txString = `${this.renderCall(this.targetCall)} ${this.renderCall(this.myCall)} ${(this.myGrid || '').substring(0, 4)}`.trim();
                }
                break;
            case 'SENDING_REPORT': {
                const repVal = this.targetReport || '-12';
                txString = `${this.renderCall(this.targetCall)} ${this.renderCall(this.myCall)} ${repVal}`;
                break;
            }
            case 'SENDING_R_REPORT': {
                const repValR = this.targetReport || '-12';
                const rPrefix = repValR.startsWith('R') ? '' : 'R';
                txString = `${this.renderCall(this.targetCall)} ${this.renderCall(this.myCall)} ${rPrefix}${repValR}`;
                break;
            }
            case 'SENDING_RRR':
                txString = `${this.renderCall(this.targetCall)} ${this.renderCall(this.myCall)} RRR`;
                break;
            case 'SENDING_RR73':
                txString = `${this.renderCall(this.targetCall)} ${this.renderCall(this.myCall)} RR73`;
                completeQso = true;
                break;
            case 'SENDING_73':
                txString = `${this.renderCall(this.targetCall)} ${this.renderCall(this.myCall)} 73`;
                completeQso = true;
                break;
        }

        // Trigger hooks
        if (txString) {
            this.onTransmit(txString);
            this.onAppendQsoLog(`-> ${txString}`, true, false);
            this.hasTransmittedThisQso = true;
            
            // Advance logic if we sent final closure
            if (completeQso) {
                this.onAppendQsoLog(`[QSO COMPLETE w/ ${this.targetCall}]`, false, true);
                this.logCurrentQsoAndAdvance();
            }
        }
    }

    /**
     * Triggered around 13.0 seconds into the slot with batch decodes.
     */
    public onPeriodDecodeReady(decodedMessagesArray: FT8DecodedMessage[], decodedPeriodIndex?: number) {
        const nowStr = new Date().toISOString().substring(11, 19);
        const divider = `--- ${nowStr} UTC ---`;
        let qsoDividerAppended = false;
        
        let targetResponded = false;
        const incomingCallers: QueuedCaller[] = [];

        // 1. Parse and Route raw lines
        decodedMessagesArray.forEach(msgObj => {
            const line = msgObj.message;
            this.onAppendGlobalLog(line);

            // Whole-token, bracket/case-insensitive matching (a raw substring test
            // would false-match e.g. OK1CDJ inside OK1CDJX or a grid like JO70).
            const parts = line.trim().split(/\s+/);
            const addressee = this.normalizeCall(parts[0]);
            const sender = parts.length >= 2 ? this.normalizeCall(parts[1]) : '';
            const msgContent = parts.slice(2).join(' ').trim();

            // A hashed callsign the decoder cannot resolve yet shows as "<...>".
            // Mid-QSO, a message from our target addressed to an unresolved hash is
            // almost certainly aimed at us (the far end hasn't learned our call).
            const addresseeUnresolved = addressee === '...';
            const senderIsTarget = this.callsMatch(sender, this.targetCall);
            const addressedToMe = this.callsMatch(addressee, this.myCall)
                || (addresseeUnresolved && senderIsTarget && this.currentState !== 'IDLE');

            const involvesMe = addressedToMe || parts.some(p => this.callsMatch(p, this.myCall));
            const involvesTarget = !!this.targetCall && parts.some(p => this.callsMatch(p, this.targetCall));

            if (involvesMe || involvesTarget) {
                if (!qsoDividerAppended) {
                    this.onAppendQsoLog(divider, false, true);
                    qsoDividerAppended = true;
                }
                this.onAppendQsoLog(`<- ${line}`, false, false);
            }

            // Stateful message evaluation
            if (parts.length >= 2) {
                if (addressedToMe) {
                    if (senderIsTarget) {
                        targetResponded = true;
                        this.retryCount = 0;

                        const upperContent = msgContent.toUpperCase();

                        // 1. Check if they sent a final closure (73, RR73, RRR).
                        // Match whole tokens, NOT substrings: a grid locator whose
                        // digits are 73 (e.g. FN73, EM73, DM73) contains the substring
                        // "73" and would otherwise be mistaken for an end-of-QSO "73".
                        // \b73\b does not match inside "FN73" or "RR73" (no boundary
                        // between two word chars), so each closure is detected cleanly.
                        const hasRR73 = /\bRR73\b/.test(upperContent);
                        const hasRRR = /\bRRR\b/.test(upperContent);
                        const has73 = /\b73\b/.test(upperContent);

                        if (hasRR73 || hasRRR) {
                            // We received RR73 or RRR -> reply with 73 for one period.
                            this.currentState = 'SENDING_73';
                            this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                        }
                        else if (has73) {
                            // Plain 73 -> QSO is finished, stop here (do not send RR73).
                            this.onAppendQsoLog(`[QSO COMPLETE w/ ${this.targetCall}]`, false, true);
                            this.logCurrentQsoAndAdvance();
                        }
                        // 2. Check if they sent a signal report (e.g. -12, +04, R-12, R+04)
                        else if (/R?[+-]\d+/.test(upperContent)) {
                            const match = upperContent.match(/R?([+-]\d+)/);
                            if (match) {
                                this.myReceivedReport = match[1];
                            }

                            if (this.currentState === 'REPLY_SENDING') {
                                const actualSnr = msgObj.snr !== undefined ? Math.round(msgObj.snr) : -12;
                                const formattedSnr = actualSnr >= 0 
                                    ? `+${String(actualSnr).padStart(2, '0')}` 
                                    : `-${String(Math.abs(actualSnr)).padStart(2, '0')}`;
                                this.targetReport = formattedSnr;

                                this.currentState = 'SENDING_R_REPORT';
                                this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                            }
                            else if (this.currentState === 'SENDING_REPORT') {
                                if (this.finalMessageMode === 'RR73') {
                                    this.currentState = 'SENDING_RR73';
                                } else {
                                    this.currentState = 'SENDING_RRR';
                                }
                                this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                            }
                        }
                        // 3. Otherwise treat as grid locator or other content in reply to CQ
                        else {
                            const gridMatch = upperContent.match(/^[A-Z]{2}[0-9]{2}/);
                            if (gridMatch && gridMatch[0] !== 'RR73') {
                                this.targetGrid = gridMatch[0];
                                if (this.currentState === 'CQ_SENDING' || this.currentState === 'IDLE') {
                                    const actualSnr = msgObj.snr !== undefined ? Math.round(msgObj.snr) : -12;
                                    const formattedSnr = actualSnr >= 0 
                                        ? `+${String(actualSnr).padStart(2, '0')}` 
                                        : `-${String(Math.abs(actualSnr)).padStart(2, '0')}`;
                                    this.targetReport = formattedSnr;

                                    this.currentState = 'SENDING_REPORT';
                                    this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                                }
                            }
                        }
                    } 
                    else if (
                        this.currentState === 'IDLE' ||
                        this.currentState === 'CQ_SENDING' ||
                        this.currentState === 'SENDING_RRR' ||
                        this.currentState === 'SENDING_RR73' ||
                        this.currentState === 'SENDING_73'
                    ) {
                        const upperContent = msgContent.toUpperCase();
                        const gridMatch = upperContent.match(/^[A-Z]{2}[0-9]{2}/);
                        const grid = (gridMatch && gridMatch[0] !== 'RR73') ? gridMatch[0] : null;
                        const distance = this.calculateDistance(this.myGrid, grid);
                        const reportMatch = upperContent.match(/R?([+-]\d+)/);
                        const report = reportMatch ? reportMatch[1] : null;
                        const receivedSnr = msgObj.snr !== undefined ? Math.round(msgObj.snr) : undefined;
                        // Skip callers whose call we can't resolve yet (unresolved hash
                        // or empty) — we cannot address a reply to "<...>".
                        if (sender && sender !== '...') {
                            incomingCallers.push({ callsign: sender, grid, distance, report, receivedSnr });
                        }
                    }
                }
            }
        });

        // 2. Queueing & Pile-up Handling
        const isLateQso = this.currentState === 'SENDING_RRR'
            || this.currentState === 'SENDING_RR73'
            || this.currentState === 'SENDING_73';

        // During late-QSO states: queue callers but never switch immediately —
        // the existing QSO must finish first via completeQso or the has73 path.
        if (isLateQso && incomingCallers.length > 0) {
            incomingCallers.forEach(c => {
                if (!this.callerQueue.find(q => q.callsign === c.callsign)) {
                    this.callerQueue.push(c);
                }
            });
            this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
        }

        if ((this.currentState === 'IDLE' || this.currentState === 'CQ_SENDING') && incomingCallers.length > 0) {
            incomingCallers.forEach(c => {
                 if (!this.callerQueue.find(q => q.callsign === c.callsign)) {
                     this.callerQueue.push(c);
                 }
            });

            this.callerQueue.sort((a, b) => b.distance - a.distance);

            const topCaller = this.callerQueue.shift()!;
            this.targetCall = topCaller.callsign;
            this.targetGrid = topCaller.grid;
            this.myReceivedReport = topCaller.report || null;

            const snr = topCaller.receivedSnr ?? -12;
            const formattedSnr = snr >= 0
                ? `+${String(snr).padStart(2, '0')}`
                : `-${String(Math.abs(snr)).padStart(2, '0')}`;
            this.targetReport = formattedSnr;

            // If the caller already sent us a report, skip the grid exchange.
            this.currentState = topCaller.report != null ? 'SENDING_R_REPORT' : 'SENDING_REPORT';
            this.retryCount = 0;
            this.hasTransmittedThisQso = false;
            this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
        }

        // 3. Retry Counters for Timeout Path
        else if (this.targetCall && this.currentState !== 'IDLE') {
            if (!targetResponded) {
                const isRxPeriod = decodedPeriodIndex !== undefined 
                    ? decodedPeriodIndex !== this.myPeriod 
                    : true;

                if (isRxPeriod && this.hasTransmittedThisQso) {
                    this.retryCount++;
                    if (this.retryCount >= this.maxRetries) {
                        this.onAppendQsoLog(`[QSO ABORTED: TIMEOUT]`, false, true);
                        this.callerQueue = [];
                        this.resetToIdle();
                    }
                }
            }
        }
    }
}
