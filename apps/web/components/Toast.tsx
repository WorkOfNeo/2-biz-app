'use client';
import { useEffect } from 'react';

export function Toast({ open, pct, elapsedSec, done, onClose }: { open: boolean; pct: number; elapsedSec: number; done: boolean; onClose: () => void }) {
  useEffect(() => {
    if (done) {
      const t = setTimeout(onClose, 1500);
      return () => clearTimeout(t);
    }
  }, [done]);
  if (!open) return null;
  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  return (
    <div className="fixed bottom-3 right-3 z-50 w-72 rounded-md border bg-white shadow">
      <div className="p-3 text-sm flex items-center gap-2">
        <div className={"h-3 w-3 rounded-full " + (done ? 'bg-green-600' : 'bg-slate-400 animate-pulse')}></div>
        <div className="flex-1">Updating statistics… <span className="text-xs text-gray-500">{mm}:{ss.toString().padStart(2,'0')}</span></div>
        {done && <button className="text-xs text-gray-500" onClick={onClose}>Close</button>}
      </div>
      <div className="px-3 pb-3">
        <div className="h-1 w-full rounded bg-gray-200 overflow-hidden">
          <div className="h-full bg-slate-900" style={{ width: Math.max(0, Math.min(100, pct)) + '%' }} />
        </div>
      </div>
    </div>
  );
}


