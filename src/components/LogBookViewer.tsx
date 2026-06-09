import React, { useEffect, useState } from 'react';
import { logBook, QSO } from '../LogBook';

export function LogBookViewer({ maxEntries }: { maxEntries: number }) {
    const [qsos, setQsos] = useState<QSO[]>([]);
    const [deletingId, setDeletingId] = useState<number | null>(null);

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
        await logBook.deleteQSO(id);
        setDeletingId(null);
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
                    className="bg-btn border border-border-input hover:bg-btn-hover hover:border-[#4caf50] hover:text-[#4caf50] text-[10px] font-bold px-3 py-1 rounded uppercase tracking-wider text-text-main transition-colors shadow-sm cursor-pointer"
                >
                    Export ADIF
                </button>
            </div>
            <div className="overflow-y-auto flex-1 text-xs px-3 pb-3 h-48 custom-scrollbar">
                {qsos.length === 0 ? (
                    <div className="text-center text-text-muted mt-8 italic text-[11px]">No QSOs logged yet.</div>
                ) : (
                    <div className="w-full">
                        <div className="sticky top-0 bg-panel text-text-muted text-[10px] uppercase tracking-wider grid grid-cols-[130px_70px_50px_40px_40px_60px_1fr] gap-2 pb-2 mb-1 border-b border-border-subtle z-10 font-bold text-left">
                            <div className="text-left">Date/Time (UTC)</div>
                            <div className="text-left">Call</div>
                            <div className="text-left">Band</div>
                            <div className="text-left">Sent</div>
                            <div className="text-left">Rcvd</div>
                            <div className="text-left">Grid</div>
                            <div className="text-right pr-2">Action</div>
                        </div>
                        <div className="flex flex-col">
                            {qsos.map(qso => (
                                <div key={qso.id} className="grid grid-cols-[130px_70px_50px_40px_40px_60px_1fr] gap-2 py-1.5 border-b border-border-subtle/30 hover:bg-btn transition-colors items-center text-[11px] text-left">
                                    <div className="font-mono text-text-muted truncate text-left">{qso.qso_date} {qso.time_on}</div>
                                    <div className="font-bold text-sky-600 dark:text-sky-400 truncate tracking-wide text-left">{qso.call}</div>
                                    <div className="text-text-muted text-left">{qso.band}</div>
                                    <div className="text-green-600 dark:text-[#4caf50] font-mono text-left">{qso.rst_sent}</div>
                                    <div className="text-red-650 dark:text-red-450 font-mono text-left">{qso.rst_rcvd}</div>
                                    <div className="text-zinc-600 dark:text-zinc-400 font-mono tracking-wider text-left">{qso.gridsquare || '-'}</div>
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
                                        )}
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
