import React, { useEffect, useState } from 'react';
import { logBook, QSO } from '../LogBook';

export function LogBookViewer({ maxEntries }: { maxEntries: number }) {
    const [qsos, setQsos] = useState<QSO[]>([]);

    const fetchQsos = async () => {
        try {
            const data = await logBook.getAllQSOs();
            setQsos(data.slice(0, maxEntries));
        } catch (e) {
            console.error("Failed to load QSOs", e);
        }
    };

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
        if (!confirm("Delete this QSO?")) return;
        await logBook.deleteQSO(id);
        fetchQsos();
    };

    const handleExport = async () => {
        await logBook.exportToADIF();
    };

    return (
        <div className="logbook-vessel flex flex-col bg-panel border gap-2 border-border-subtle rounded mt-2 px-1">
            <div className="flex justify-between items-center shrink-0 py-2 pt-3 px-3">
                <h3 className="text-xs font-bold text-text-main uppercase tracking-widest text-[#4caf50]">QSO Logbook</h3>
                <button 
                    onClick={handleExport}
                    className="bg-btn border border-border-input hover:bg-btn-hover hover:border-[#4caf50] hover:text-[#4caf50] text-[10px] font-bold px-3 py-1 rounded uppercase tracking-wider text-text-muted transition-colors shadow-sm"
                >
                    Export ADIF
                </button>
            </div>
            <div className="overflow-y-auto flex-1 text-xs px-3 pb-3 h-48 custom-scrollbar">
                {qsos.length === 0 ? (
                    <div className="text-center text-text-muted mt-8 italic text-[11px]">No QSOs logged yet.</div>
                ) : (
                    <div className="w-full">
                        <div className="sticky top-0 bg-panel text-text-muted text-[10px] uppercase tracking-wider grid grid-cols-[1fr_50px_40px_30px_30px_50px_40px] gap-2 pb-2 mb-1 border-b border-border-subtle z-10 font-bold">
                            <div>Date/Time (UTC)</div>
                            <div>Call</div>
                            <div>Band</div>
                            <div>Sent</div>
                            <div>Rcvd</div>
                            <div>Grid</div>
                            <div className="text-right">Action</div>
                        </div>
                        <div className="flex flex-col">
                            {qsos.map(qso => (
                                <div key={qso.id} className="grid grid-cols-[1fr_50px_40px_30px_30px_50px_40px] gap-2 py-1.5 border-b border-border-subtle/30 hover:bg-[#2a2d35] transition-colors items-center text-[11px]">
                                    <div className="font-mono text-text-muted truncate">{qso.qso_date} {qso.time_on}</div>
                                    <div className="font-bold text-sky-400 truncate tracking-wide">{qso.call}</div>
                                    <div className="text-text-muted">{qso.band}</div>
                                    <div className="text-text-main font-mono text-[#4caf50]">{qso.rst_sent}</div>
                                    <div className="text-text-main font-mono text-red-400">{qso.rst_rcvd}</div>
                                    <div className="text-zinc-500 font-mono tracking-wider">{qso.gridsquare || '-'}</div>
                                    <div className="text-right flex items-center justify-end">
                                        <button 
                                            onClick={() => handleDelete(qso.id!)}
                                            className="text-red-500 hover:text-red-400 hover:bg-red-500/10 p-1 rounded transition-colors group flex items-center justify-center transform active:scale-95"
                                            title="Delete QSO"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-70 group-hover:opacity-100">
                                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                                <line x1="6" y1="6" x2="18" y2="18"></line>
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
