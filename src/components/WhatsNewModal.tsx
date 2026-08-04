import React from 'react';
import { X, Sparkles, Wrench } from 'lucide-react';
import type { ChangelogEntry } from '../changelog';

interface WhatsNewModalProps {
  entries: ChangelogEntry[];
  onClose: () => void;
}

/**
 * "What's New" dialog. Matches the app's Settings/About modal styling. Shown once
 * per new release (see the wiring in App.tsx). Lists the new features and bug
 * fixes for each release the user has not seen yet.
 */
export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ entries, onClose }) => {
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-4">
      <div className="bg-panel border border-border-subtle p-6 rounded-lg shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-text-main">
            <Sparkles size={16} className="text-green-600 dark:text-[#4caf50]" />
            What's New
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-main">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6 text-xs text-text-main leading-relaxed">
          {entries.map((entry) => (
            <div key={entry.date}>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="font-bold text-text-main">{entry.title}</span>
                <span className="ml-auto text-[10px] text-text-muted font-mono">{entry.date}</span>
              </div>

              {entry.features && entry.features.length > 0 && (
                <div className="mb-3">
                  <h3 className="flex items-center gap-1.5 font-bold text-text-main mb-1">
                    <Sparkles size={12} className="text-green-600 dark:text-[#4caf50]" />
                    New features
                  </h3>
                  <ul className="list-disc pl-5 space-y-1 text-text-muted">
                    {entry.features.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}

              {entry.fixes && entry.fixes.length > 0 && (
                <div>
                  <h3 className="flex items-center gap-1.5 font-bold text-text-main mb-1">
                    <Wrench size={12} className="text-text-muted" />
                    Bug fixes
                  </h3>
                  <ul className="list-disc pl-5 space-y-1 text-text-muted">
                    {entry.fixes.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <span className="text-[10px] text-text-muted font-mono truncate">
            Build: {__COMMIT_HASH__} · {__BUILD_TIME__}
          </span>
          <button
            onClick={onClose}
            className="bg-green-600 dark:bg-[#4caf50] hover:bg-green-600 text-black px-6 py-2 rounded text-xs font-bold uppercase tracking-widest shrink-0"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
