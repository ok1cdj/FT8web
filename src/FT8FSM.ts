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

        let txString: string | null = null;
        let completeQso = false;

        switch (this.currentState) {
            case 'IDLE':
                break;
            case 'CQ_SENDING':
                txString = `CQ ${this.myCall} ${(this.myGrid || '').substring(0, 4)}`;
                break;
            case 'REPLY_SENDING':
                txString = `${this.targetCall} ${this.myCall} ${(this.myGrid || '').substring(0, 4)}`.trim();
                break;
            case 'SENDING_REPORT':
                const repVal = this.targetReport || '-12';
                txString = `${this.targetCall} ${this.myCall} ${repVal}`;
                break;
            case 'SENDING_R_REPORT':
                const repValR = this.targetReport || '-12';
                const rPrefix = repValR.startsWith('R') ? '' : 'R';
                txString = `${this.targetCall} ${this.myCall} ${rPrefix}${repValR}`;
                break;
            case 'SENDING_RRR':
                txString = `${this.targetCall} ${this.myCall} RRR`;
                break;
            case 'SENDING_RR73':
                txString = `${this.targetCall} ${this.myCall} RR73`;
                completeQso = true;
                break;
            case 'SENDING_73':
                txString = `${this.targetCall} ${this.myCall} 73`;
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
                if (this.targetCall) {
                    this.onLogQSO({
                        call: this.targetCall,
                        grid: this.targetGrid,
                        rst_sent: this.targetReport,
                        rst_rcvd: this.myReceivedReport
                    });
                }
                
                // Immediately pick up the next queued caller, or go back to IDLE
                if (this.callerQueue.length > 0) {
                     const next = this.callerQueue.shift()!;
                     this.targetCall = next.callsign;
                     this.targetGrid = next.grid;
                     this.myReceivedReport = next.report || null;
                     const snr = next.receivedSnr ?? (Math.floor(Math.random() * 15) - 20);
                     const formattedSnr = snr >= 0
                         ? `+${String(snr).padStart(2, '0')}`
                         : `-${String(Math.abs(snr)).padStart(2, '0')}`;
                     this.targetReport = formattedSnr;
                     // If caller already sent us a report, skip grid exchange and go straight to R-report
                     this.currentState = next.report != null ? 'SENDING_R_REPORT' : 'SENDING_REPORT';
                     this.retryCount = 0;
                     this.hasTransmittedThisQso = false;
                     this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                } else {
                     this.resetToIdle();
                }
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
            
            const involvesMe = line.includes(this.myCall);
            const involvesTarget = this.targetCall && line.includes(this.targetCall);
            
            if (involvesMe || involvesTarget) {
                if (!qsoDividerAppended) {
                    this.onAppendQsoLog(divider, false, true);
                    qsoDividerAppended = true;
                }
                this.onAppendQsoLog(`<- ${line}`, false, false);
            }

            // Stateful message evaluation
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const addressee = parts[0].replace(/[<>]/g, '');
                const sender = parts[1].replace(/[<>]/g, '');
                const msgContent = parts.slice(2).join(' ').trim();

                if (addressee === this.myCall) {
                    if (sender === this.targetCall) {
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

                        if (hasRR73 || hasRRR || has73) {
                            if (hasRR73 || hasRRR) {
                                // We received RR73 or RRR -> reply with 73 for one period.
                                this.currentState = 'SENDING_73';
                                this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                            } else {
                                // Plain 73 -> QSO is finished, stop here (do not send RR73).
                                this.onAppendQsoLog(`[QSO COMPLETE w/ ${this.targetCall}]`, false, true);
                                if (this.targetCall) {
                                    this.onLogQSO({
                                        call: this.targetCall,
                                        grid: this.targetGrid,
                                        rst_sent: this.targetReport,
                                        rst_rcvd: this.myReceivedReport
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
                                    this.currentState = next.report != null ? 'SENDING_R_REPORT' : 'SENDING_REPORT';
                                    this.retryCount = 0;
                                    this.hasTransmittedThisQso = false;
                                    this.onStateChange(this.currentState, this.targetCall, this.callerQueue);
                                } else {
                                    this.resetToIdle();
                                }
                            }
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
                        incomingCallers.push({ callsign: sender, grid, distance, report, receivedSnr });
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

            this.currentState = 'SENDING_REPORT';
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
