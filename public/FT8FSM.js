export default class FT8FSM {
    constructor(config = {}) {
        // User Configurations
        this.myCall = config.myCall || "OK1AAA";
        this.myGrid = config.myGrid || "JN79";
        this.myPeriod = config.myPeriod !== undefined ? config.myPeriod : 0;
        this.maxRetries = config.maxRetries || 4;
        this.directReportCall = config.directReportCall || false;
        this.finalMessageMode = config.finalMessageMode || 'RR73';
        
        // Runtime Context Variables
        this.currentState = config.currentState || 'IDLE';
        this.targetCall = config.targetCall || null;
        this.targetGrid = config.targetGrid || null;
        this.targetReport = config.targetReport || null;
        this.retryCount = 0;
        this.callerQueue = [];
        this.isTxEnabled = config.isTxEnabled || false;

        // Callback hooks for the main app UI and Transceiver
        this.onAppendGlobalLog = (msg) => {};
        this.onAppendQsoLog = (msg, isTx, isDivider) => {};
        this.onTransmit = (msg) => {};
    }

    /**
     * Helper: Convert Maidenhead Grid Locator to Lat/Lon
     */
    _gridToLatLon(str) {
        if (!str || str.length < 4) return null;
        str = str.toUpperCase();
        let lon = (str.charCodeAt(0) - 65) * 20 - 180 + parseInt(str[2]) * 2 + 1;
        let lat = (str.charCodeAt(1) - 65) * 10 - 90 + parseInt(str[3]) * 1 + 0.5;
        if (isNaN(lat) || isNaN(lon)) return null;
        return {lat, lon};
    }

    /**
     * Helper: Haversine distance in km between two grid locators
     */
    calculateDistance(grid1, grid2) {
        let p1 = this._gridToLatLon(grid1);
        let p2 = this._gridToLatLon(grid2);
        if (!p1 || !p2) return 0;
        
        const R = 6371; // Earth radius in km
        const dLat = (p2.lat - p1.lat) * Math.PI / 180;
        const dLon = (p2.lon - p1.lon) * Math.PI / 180;
        const lat1 = p1.lat * Math.PI / 180;
        const lat2 = p2.lat * Math.PI / 180;

        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2); 
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
        return Math.round(R * c);
    }

    /**
     * Clear context to IDLE safe state
     */
    resetToIdle() {
        this.currentState = 'IDLE';
        this.targetCall = null;
        this.targetGrid = null;
        this.targetReport = null;
        this.retryCount = 0;
    }

    /**
     * Triggered externally at exactly :00, :15, :30, :45 of every minute UTC.
     */
    onPeriodStart(currentUtcSecond) {
        if (!this.isTxEnabled) return;

        // Check if we are allowed to TX in the current slot
        let periodIndex = Math.floor(currentUtcSecond / 15) % 2;
        if (periodIndex !== this.myPeriod) return;

        let txString = null;
        let completeQso = false;

        switch(this.currentState) {
            case 'IDLE':
                break;
            case 'CQ_SENDING':
                txString = `CQ ${this.myCall} ${this.myGrid}`;
                break;
            case 'REPLY_SENDING':
                // Replying to someone else's CQ
                if (this.directReportCall && this.targetReport) {
                    txString = `${this.targetCall} ${this.myCall} ${this.targetReport}`;
                } else {
                    txString = `${this.targetCall} ${this.myCall} ${this.myGrid || ''}`.trim();
                }
                break;
            case 'REPORT_SENDING':
                // Confirming report receipt and finishing QSO
                if (this.finalMessageMode === 'RR73') {
                    txString = `${this.targetCall} ${this.myCall} RR73`;
                    completeQso = true; // RR73 closes it immediately upon TX
                } else {
                    txString = `${this.targetCall} ${this.myCall} RRR`;
                }
                break;
            case '73_SENDING':
                txString = `${this.targetCall} ${this.myCall} 73`;
                completeQso = true;
                break;
        }

        // Trigger hooks
        if (txString) {
            this.onTransmit(txString);
            this.onAppendQsoLog(`-> ${txString}`, true, false);
            
            // Advance logic if we sent final closure
            if (completeQso) {
                this.onAppendQsoLog(`[QSO COMPLETE w/ ${this.targetCall}]`, false, true);
                
                // Immediately pick up the next queued caller, or go back to IDLE
                if (this.callerQueue.length > 0) {
                     const next = this.callerQueue.shift();
                     this.targetCall = next.callsign;
                     this.targetGrid = next.grid;
                     this.currentState = 'REPORT_SENDING';
                     this.retryCount = 0;
                } else {
                     this.resetToIdle();
                }
            }
        }
    }

    /**
     * Triggered around 13.0 seconds into the slot with batch decodes.
     */
    onPeriodDecodeReady(decodedLinesArray) {
        const nowStr = new Date().toISOString().substring(11, 19);
        const divider = `--- ${nowStr} UTC ---`;
        let qsoDividerAppended = false;
        
        let targetResponded = false;
        let incomingCallers = [];

        // 1. Parse and Route raw lines
        decodedLinesArray.forEach(line => {
            this.onAppendGlobalLog(line);
            
            let involvesMe = line.includes(this.myCall);
            let involvesTarget = this.targetCall && line.includes(this.targetCall);
            
            if (involvesMe || involvesTarget) {
                if (!qsoDividerAppended) {
                    this.onAppendQsoLog(divider, false, true);
                    qsoDividerAppended = true;
                }
                this.onAppendQsoLog(`<- ${line}`, false, false);
            }

            // Stateful message evaluation
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2 && parts[0] === this.myCall) {
                const caller = parts[1];
                const msg = parts.slice(2).join(' ');
                
                if (caller === this.targetCall) {
                    // Current target responded
                    targetResponded = true;
                    this.retryCount = 0;

                    // Analyze response phase
                    if (msg.includes('RR73') || msg.includes('73') || msg.includes('RRR')) {
                         if (this.currentState === 'REPORT_SENDING' && this.finalMessageMode === 'RRR') {
                             this.currentState = '73_SENDING';
                         } else if (this.currentState === '73_SENDING' || this.currentState === 'REPORT_SENDING') {
                             this.onAppendQsoLog(`[QSO COMPLETE w/ ${this.targetCall}]`, false, true);
                             this.resetToIdle();
                         }
                    } 
                    else if (msg.includes('-') || msg.includes('+')) {
                         // Target sent us a signal report
                         this.targetReport = msg.replace('R', '');
                         if (this.currentState === 'REPLY_SENDING') {
                              this.currentState = 'REPORT_SENDING';
                         }
                    } 
                    else {
                         // Target sent their grid locator
                         this.targetGrid = msg;
                         if (this.currentState === 'CQ_SENDING') {
                              this.currentState = 'REPORT_SENDING';
                         }
                    }
                } 
                else if (this.currentState === 'IDLE' || this.currentState === 'CQ_SENDING') {
                    // An unknown station is calling me. Park them in temporary array.
                    const gridMatch = msg.match(/^[A-Z]{2}[0-9]{2}/);
                    let grid = gridMatch ? gridMatch[0] : null;
                    let distance = this.calculateDistance(this.myGrid, grid);
                    incomingCallers.push({ callsign: caller, grid, distance });
                }
            }
        });

        // 2. Queueing & Pile-up Handling
        if ((this.currentState === 'IDLE' || this.currentState === 'CQ_SENDING') && incomingCallers.length > 0) {
            
            // Add unique callers to persistent queue
            incomingCallers.forEach(c => {
                 if (!this.callerQueue.find(q => q.callsign === c.callsign)) {
                     this.callerQueue.push(c);
                 }
            });
            
            // Sort Descending by DX Distance
            this.callerQueue.sort((a, b) => b.distance - a.distance);
            
            // Pop highest priority station to work immediately
            const topCaller = this.callerQueue.shift();
            this.targetCall = topCaller.callsign;
            this.targetGrid = topCaller.grid;
            this.currentState = 'REPORT_SENDING'; 
            this.retryCount = 0;
        }

        // 3. Retry Counters for Timeout Path
        else if (this.targetCall && this.currentState !== 'IDLE') {
            if (!targetResponded) {
                this.retryCount++;
                if (this.retryCount >= this.maxRetries) {
                    this.onAppendQsoLog(`[QSO ABORTED: TIMEOUT]`, false, true);
                    
                    // Failsafe clear queue on timeout to avoid hanging onto stale pileups indefinitely
                    this.callerQueue = [];
                    this.resetToIdle();
                }
            }
        }
    }
}
