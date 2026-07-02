import React, { useEffect, useState } from 'react';
import { logBook, QSO } from '../LogBook';
import { CloudLogService } from '../services/CloudLogService';
import { dxccService } from '../services/DxccService';

export function LogBookViewer({ 
    maxEntries, 
    wavelogEnabled, 
    wavelogUrl, 
    wavelogApiKey,
    wavelogStationProfileId
}: { 
    maxEntries: number, 
    wavelogEnabled: boolean, 
    wavelogUrl: string, 
    wavelogApiKey: string,
    wavelogStationProfileId: string
}) {
    const [qsos, setQsos] = useState<QSO[]>([]);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
    const [inlineSyncingIds, setInlineSyncingIds] = useState<Record<number, boolean>>({});
    const [editingQso, setEditingQso] = useState<QSO | null>(null);
    const [filterCall, setFilterCall] = useState('');
    const [filterBand, setFilterBand] = useState('');
    const [filterMode, setFilterMode] = useState('');

    const handleSingleQsoSync = async (qso: QSO) => {
        if (!qso.id) return;
        setInlineSyncingIds(prev => ({ ...prev, [qso.id!]: true }));
        try {
            const success = await CloudLogService.pushSingleQSO(qso, {
                wavelogEnabled,
                wavelogUrl,
                wavelogApiKey,
                wavelogStationProfileId
            });
            if (success) {
                await logBook.updateQSO({ ...qso, synced: true });
                await fetchQsos();
                window.dispatchEvent(new Event('qso-logged'));
                console.log(`[Wavelog Sync] Manual single sync of QSO ID ${qso.id} succeeded.`);
            } else {
                console.error(`[Wavelog Sync] Manual single sync of QSO ID ${qso.id} failed. Feel free to inspect the console logs above.`);
            }
        } catch (err) {
            console.error('Failed to manually sync single QSO', err);
        } finally {
            setInlineSyncingIds(prev => {
                const copy = { ...prev };
                delete copy[qso.id!];
                return copy;
            });
        }
    };

    const handleDeleteAll = async () => {
        try {
            await logBook.clearLogBook();
            setConfirmDeleteAll(false);
            await fetchQsos();
            window.dispatchEvent(new Event('qso-logged'));
        } catch (err) {
            console.error('Failed to wipe logbook', err);
        }
    };

    const fetchQsos = async () => {
        try {
            const data = await logBook.getAllQSOs();
            setQsos(data);
        } catch (e) {
            console.error("Failed to load QSOs", e);
        }
    };

    const hasFilter = filterCall.trim() !== '' || filterBand !== '' || filterMode !== '';

    const filteredQsos = hasFilter
        ? qsos.filter(q => {
            if (filterCall.trim() && !q.call.toUpperCase().includes(filterCall.trim().toUpperCase())) return false;
            if (filterBand && q.band !== filterBand) return false;
            if (filterMode && q.mode !== filterMode) return false;
            return true;
        })
        : qsos.slice(0, maxEntries);

    useEffect(() => {
        fetchQsos();
        // Periodically refresh the logbook list, or after interaction
        const interval = setInterval(fetchQsos, 5000);
        // Expose fetchQsos globally so App.tsx can trigger a forced refresh
        (window as any).refreshQsoLogbookUi = fetchQsos;
        return () => {
            clearInterval(interval);
            delete (window as any).refreshQsoLogbookUi;
        };
    }, [maxEntries]);

    const handleDelete = async (id: number) => {
        await logBook.deleteQSO(id);
        setDeletingId(null);
        await fetchQsos();
        window.dispatchEvent(new Event('qso-logged'));
    };

    const handleEditSave = async () => {
        if (!editingQso?.id) return;
        await logBook.updateQSO({ ...editingQso, synced: false });
        setEditingQso(null);
        await fetchQsos();
        window.dispatchEvent(new Event('qso-logged'));
    };

    const handleExport = async () => {
        await logBook.exportToADIF();
    };

    const handleSync = async () => {
        setIsSyncing(true);
        await CloudLogService.syncOfflineQueue({ wavelogEnabled, wavelogUrl, wavelogApiKey, wavelogStationProfileId });
        await fetchQsos();
        window.dispatchEvent(new Event('qso-logged'));
        setIsSyncing(false);
    };

    const unsyncedCount = qsos.filter(q => q.synced === false).length;

    return (
        <div className="logbook-vessel flex flex-col bg-panel border gap-2 border-border-subtle rounded mt-2 px-1">
            <div className="flex justify-between items-center shrink-0 py-2 pt-3 px-3">
                <div className="flex items-center gap-3">
                    <h3 className="text-xs font-bold text-text-main uppercase tracking-widest text-[#4caf50]">QSO Logbook</h3>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                    {wavelogEnabled ? (
                        <button 
                            onClick={handleSync}
                            disabled={isSyncing || unsyncedCount === 0}
                            className={`text-[10px] font-bold px-3 py-1.5 rounded uppercase tracking-wider transition-colors shadow-sm cursor-pointer border ${
                                unsyncedCount > 0 
                                ? 'bg-amber-500/10 border-amber-500/40 text-amber-500 hover:bg-amber-500 hover:text-white hover:border-amber-500' 
                                : 'bg-btn border-border-input text-text-muted opacity-50 cursor-not-allowed'
                            }`}
                            title={unsyncedCount > 0 ? `Sync ${unsyncedCount} unsynced QSOs to Wavelog` : 'All QSOs are Synced'}
                        >
                            {isSyncing ? 'Syncing...' : `Sync All (${unsyncedCount})`}
                        </button>
                    ) : (
                        <button 
                            disabled
                            className="bg-btn border border-border-input text-text-muted opacity-40 text-[10px] font-bold px-3 py-1.5 rounded uppercase tracking-wider cursor-not-allowed"
                            title="Enable Wavelog Cloud Sync in configuration settings to sync"
                        >
                            Sync All
                        </button>
                    )}
                    <button 
                        onClick={handleExport}
                        className="bg-btn border border-border-input hover:bg-btn-hover hover:border-[#4caf50] hover:text-[#4caf50] text-[10px] font-bold px-3 py-1.5 rounded uppercase tracking-wider text-text-main transition-colors shadow-sm cursor-pointer"
                    >
                        Export ADIF
                    </button>
                    <div className="relative inline-block">
                        {qsos.length > 0 ? (
                            confirmDeleteAll ? (
                                <div className="flex items-center gap-1 bg-red-600/10 border border-red-500/30 rounded px-1.5 py-0.5">
                                    <span className="text-[9px] text-red-500 font-bold uppercase mr-1">Confirm Wipe?</span>
                                    <button 
                                        onClick={handleDeleteAll}
                                        className="bg-red-600 hover:bg-red-700 text-white font-bold px-1.5 py-0.5 rounded text-[9px] uppercase cursor-pointer"
                                    >
                                        Yes
                                    </button>
                                    <button 
                                        onClick={() => setConfirmDeleteAll(false)}
                                        className="bg-btn border border-border-input text-text-main px-1.5 py-0.5 rounded text-[9px] uppercase cursor-pointer"
                                    >
                                        No
                                    </button>
                                </div>
                            ) : (
                                <button 
                                    onClick={() => setConfirmDeleteAll(true)}
                                    className="bg-btn border border-red-500/20 hover:bg-red-600 hover:text-white hover:border-red-600 text-red-500 text-[10px] font-bold px-3 py-1.5 rounded uppercase tracking-wider transition-colors shadow-sm cursor-pointer"
                                    title="Delete all local QSOs permanently"
                                >
                                    Wipe Log
                                </button>
                            )
                        ) : (
                            <button 
                                disabled
                                className="bg-btn border border-red-500/10 text-red-500 opacity-40 text-[10px] font-bold px-3 py-1.5 rounded uppercase tracking-wider cursor-not-allowed"
                                title="Logbook is already empty"
                            >
                                Wipe Log
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 px-3 pb-2 shrink-0 flex-wrap">
                <div className="relative">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                        type="text"
                        placeholder="Search call..."
                        value={filterCall}
                        onChange={e => setFilterCall(e.target.value)}
                        className="bg-btn border border-border-input rounded pl-6 pr-2 py-1 text-[11px] text-text-main outline-none focus:border-[#4caf50] transition-colors w-32 uppercase placeholder:normal-case placeholder:text-text-muted"
                    />
                </div>
                <select
                    value={filterBand}
                    onChange={e => setFilterBand(e.target.value)}
                    className="bg-btn border border-border-input rounded px-2 py-1 text-[11px] text-text-main outline-none focus:border-[#4caf50] transition-colors cursor-pointer"
                >
                    <option value="">All Bands</option>
                    {['160m','80m','60m','40m','30m','20m','17m','15m','12m','10m','6m','2m'].map(b => (
                        <option key={b} value={b}>{b}</option>
                    ))}
                </select>
                <select
                    value={filterMode}
                    onChange={e => setFilterMode(e.target.value)}
                    className="bg-btn border border-border-input rounded px-2 py-1 text-[11px] text-text-main outline-none focus:border-[#4caf50] transition-colors cursor-pointer"
                >
                    <option value="">All Modes</option>
                    <option value="FT8">FT8</option>
                    <option value="FT4">FT4</option>
                </select>
                {hasFilter && (
                    <button
                        onClick={() => { setFilterCall(''); setFilterBand(''); setFilterMode(''); }}
                        className="text-[10px] font-bold px-2 py-1 rounded uppercase tracking-wider bg-btn border border-border-input text-text-muted hover:text-text-main hover:bg-btn-hover transition-colors cursor-pointer"
                    >
                        Clear
                    </button>
                )}
                {hasFilter && (
                    <span className="text-[10px] text-text-muted ml-auto">{filteredQsos.length} result{filteredQsos.length !== 1 ? 's' : ''}</span>
                )}
            </div>
            <div className="overflow-y-auto flex-1 text-xs px-3 pb-3 h-48 custom-scrollbar">
                {qsos.length === 0 ? (
                    <div className="text-center text-text-muted mt-8 italic text-[11px]">No QSOs logged yet.</div>
                ) : filteredQsos.length === 0 ? (
                    <div className="text-center text-text-muted mt-8 italic text-[11px]">No QSOs match the current filter.</div>
                ) : (
                    <div className="w-full">
                        <div className="sticky top-0 bg-panel text-text-muted text-[10px] uppercase tracking-wider grid grid-cols-[130px_100px_50px_40px_40px_40px_60px_120px_1fr] gap-2 pb-2 mb-1 border-b border-border-subtle z-10 font-bold text-left">
                            <div className="text-left">Date/Time (UTC)</div>
                            <div className="text-left">Call</div>
                            <div className="text-left">Band</div>
                            <div className="text-left">Mode</div>
                            <div className="text-left">Sent</div>
                            <div className="text-left">Rcvd</div>
                            <div className="text-left">Grid</div>
                            <div className="text-left hidden sm:block">DXCC</div>
                            <div className="text-right pr-2">Action</div>
                        </div>
                        <div className="flex flex-col">
                            {filteredQsos.map(qso => (
                                <div key={qso.id} className="grid grid-cols-[130px_100px_50px_40px_40px_40px_60px_120px_1fr] gap-2 py-1.5 border-b border-border-subtle/30 hover:bg-btn transition-colors items-center text-[11px] text-left">
                                    <div className="font-mono text-text-muted truncate text-left">{qso.qso_date} {qso.time_on}</div>
                                    <div className="font-bold text-sky-600 dark:text-sky-400 truncate tracking-wide text-left flex items-center gap-1.5 min-w-0">
                                        <span className="truncate">{qso.call}</span>
                                        {wavelogEnabled && (
                                            <span
                                                className={`text-[10px] select-none shrink-0 ${qso.synced ? 'text-green-500' : 'text-zinc-500 opacity-40'}`}
                                                title={qso.synced ? "Uploaded to Wavelog / Synced" : "Pending Cloud Upload"}
                                            >
                                                ☁️
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-text-muted text-left">{qso.band}</div>
                                    <div className={`font-mono font-bold text-left text-[10px] ${qso.mode === 'FT4' ? 'text-orange-400' : 'text-blue-400'}`}>{qso.mode || 'FT8'}</div>
                                    <div className="text-green-600 dark:text-[#4caf50] font-mono text-left">{qso.rst_sent}</div>
                                    <div className="text-red-650 dark:text-red-450 font-mono text-left">{qso.rst_rcvd}</div>
                                    <div className="text-zinc-600 dark:text-zinc-400 font-mono tracking-wider text-left">{qso.gridsquare || '-'}</div>
                                    <div className="text-zinc-500 dark:text-zinc-400 text-left text-[10px] hidden sm:block truncate" title={qso.dxcc ? dxccService.getByAdifCode(qso.dxcc)?.name : undefined}>
                                        {qso.dxcc ? (() => { const e = dxccService.getByAdifCode(qso.dxcc!); return e ? (e.name.length > 14 ? e.name.substring(0, 13) + '…' : e.name) : '-'; })() : '-'}
                                    </div>
                                    <div className="text-right flex items-center justify-end pr-2 gap-1.5">
                                        {deletingId === qso.id ? (
                                            <div className="flex gap-1">
                                                <button 
                                                    onClick={() => handleDelete(qso.id!)}
                                                    className="bg-red-600 hover:bg-red-700 text-white font-bold px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider transition-colors cursor-pointer"
                                                >
                                                    Yes
                                                </button>
                                                <button 
                                                    onClick={() => setDeletingId(null)}
                                                    className="bg-btn hover:bg-btn-hover border border-border-input text-text-main px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider transition-colors cursor-pointer"
                                                >
                                                    No
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5">
                                                <button
                                                    onClick={() => setEditingQso({ ...qso })}
                                                    className="text-zinc-400 hover:text-blue-400 hover:bg-blue-500/10 p-1 rounded transition-colors group flex items-center justify-center transform active:scale-95 cursor-pointer"
                                                    title="Edit QSO"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-70 group-hover:opacity-100">
                                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                                    </svg>
                                                </button>
                                                {wavelogEnabled && (
                                                    <button 
                                                        onClick={() => handleSingleQsoSync(qso)}
                                                        disabled={inlineSyncingIds[qso.id!]}
                                                        className={`p-1 rounded transition-colors group flex items-center justify-center transform active:scale-95 cursor-pointer text-amber-500 hover:bg-amber-500/10 ${inlineSyncingIds[qso.id!] ? 'animate-pulse opacity-60' : ''}`}
                                                        title="Force Single Sync/Upload this QSO to Wavelog"
                                                    >
                                                        {inlineSyncingIds[qso.id!] ? (
                                                            <svg className="animate-spin text-amber-500" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                                                            </svg>
                                                        ) : (
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-70 group-hover:opacity-100">
                                                                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                                                                <path d="M12 11.5V19" />
                                                                <path d="m15 15-3-3-3 3" />
                                                            </svg>
                                                        )}
                                                    </button>
                                                )}
                                                <button 
                                                    onClick={() => setDeletingId(qso.id!)}
                                                    className="text-red-500 hover:text-red-400 hover:bg-red-500/10 p-1 rounded transition-colors group flex items-center justify-center transform active:scale-95 cursor-pointer"
                                                    title="Delete QSO"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-70 group-hover:opacity-100">
                                                        <line x1="18" y1="6" x2="6" y2="18"></line>
                                                        <line x1="6" y1="6" x2="18" y2="18"></line>
                                                    </svg>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        {editingQso && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-panel border border-border-subtle rounded-lg shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
                        <h2 className="text-sm font-bold uppercase tracking-widest text-text-main">Edit QSO</h2>
                        <button onClick={() => setEditingQso(null)} className="text-text-muted hover:text-text-main transition-colors cursor-pointer">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>
                    <div className="px-5 py-4 grid grid-cols-2 gap-3">
                        {([
                            { key: 'call', label: 'Callsign', type: 'text', placeholder: 'AA1BB' },
                            { key: 'qso_date', label: 'Date (UTC)', type: 'text', placeholder: 'YYYYMMDD' },
                            { key: 'time_on', label: 'Time (UTC)', type: 'text', placeholder: 'HHMMSS' },
                            { key: 'band', label: 'Band', type: 'text', placeholder: '20m' },
                            { key: 'freq', label: 'Freq (MHz)', type: 'number', placeholder: '14.074' },
                            { key: 'rst_sent', label: 'RST Sent', type: 'text', placeholder: '-10' },
                            { key: 'rst_rcvd', label: 'RST Rcvd', type: 'text', placeholder: '-07' },
                            { key: 'gridsquare', label: 'Grid', type: 'text', placeholder: 'JO70' },
                        ] as { key: keyof QSO; label: string; type: string; placeholder: string }[]).map(({ key, label, type, placeholder }) => (
                            <div key={key} className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase tracking-wider text-text-muted">{label}</label>
                                <input
                                    type={type}
                                    step={type === 'number' ? 0.001 : undefined}
                                    placeholder={placeholder}
                                    value={editingQso[key] as string | number ?? ''}
                                    onChange={e => setEditingQso(prev => prev ? { ...prev, [key]: type === 'number' ? parseFloat(e.target.value) : e.target.value } : null)}
                                    className="bg-btn border border-border-input rounded px-2 py-1 text-xs text-text-main outline-none focus:border-[#4caf50] transition-colors"
                                />
                            </div>
                        ))}
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] uppercase tracking-wider text-text-muted">Mode</label>
                            <select
                                value={editingQso.mode ?? 'FT8'}
                                onChange={e => setEditingQso(prev => prev ? { ...prev, mode: e.target.value } : null)}
                                className="bg-btn border border-border-input rounded px-2 py-1 text-xs text-text-main outline-none focus:border-[#4caf50] transition-colors cursor-pointer"
                            >
                                <option value="FT8">FT8</option>
                                <option value="FT4">FT4</option>
                            </select>
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                            <label className="text-[10px] uppercase tracking-wider text-text-muted">DXCC Entity</label>
                            <div className="bg-btn border border-border-input rounded px-2 py-1 text-xs text-text-muted select-none">
                                {(() => {
                                    const entity = editingQso.dxcc
                                        ? dxccService.getByAdifCode(editingQso.dxcc)
                                        : (dxccService.loaded ? dxccService.lookup(editingQso.call) : null);
                                    return entity ? `${entity.name} (${entity.primaryPrefix})` : '—';
                                })()}
                            </div>
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                            <label className="text-[10px] uppercase tracking-wider text-text-muted">DXCC Entity</label>
                            <div className="bg-btn border border-border-input rounded px-2 py-1 text-xs text-text-muted select-none">
                                {editingQso.dxcc
                                    ? (dxccService.getByAdifCode(editingQso.dxcc)?.name ?? `ADIF #${editingQso.dxcc}`)
                                    : (dxccService.loaded ? (dxccService.lookup(editingQso.call)?.name ?? '—') : '—')}
                            </div>
                        </div>
                    </div>
                    <div className="flex justify-end gap-2 px-5 py-4 border-t border-border-subtle">
                        <button
                            onClick={() => setEditingQso(null)}
                            className="px-4 py-1.5 rounded text-xs font-bold uppercase tracking-wider bg-btn border border-border-input text-text-muted hover:text-text-main hover:bg-btn-hover transition-colors cursor-pointer"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleEditSave}
                            className="px-4 py-1.5 rounded text-xs font-bold uppercase tracking-wider bg-[#4caf50]/10 border border-[#4caf50]/40 text-[#4caf50] hover:bg-[#4caf50] hover:text-white hover:border-[#4caf50] transition-colors cursor-pointer"
                        >
                            Save
                        </button>
                    </div>
                </div>
            </div>
        )}
        </div>
    );
}
