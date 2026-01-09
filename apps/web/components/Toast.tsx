'use client';
import React, { useEffect } from 'react';

export function Toast({ open, pct, elapsedSec, done, onClose, label, messages, jobId }: { open: boolean; pct: number; elapsedSec: number; done: boolean; onClose: () => void; label?: string; messages?: string[]; jobId?: string | null }) {
  useEffect(() => {
    if (done) {
      const t = setTimeout(onClose, 1500);
      return () => clearTimeout(t);
    }
  }, [done]);
  if (!open) return null;
  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  // Long-running animation heuristic: advance to 90% over time, then jump to 100% when done
  const displayPct = done ? 100 : Math.max(pct, Math.min(90, elapsedSec * 2));
  // Circular progress values
  const size = 44; // px
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const progress = (done ? 100 : displayPct) / 100;
  const dash = Math.max(0.0001, c * progress);
  const gap = c - dash;
  return (
    <div className="fixed bottom-3 right-3 z-50 w-80 rounded-md border bg-white shadow">
      <div className="p-3 flex items-start gap-3">
        <div className="relative" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle cx={size/2} cy={size/2} r={r} stroke="#e5e7eb" strokeWidth={stroke} fill="none" />
            <circle
              cx={size/2}
              cy={size/2}
              r={r}
              stroke={done ? '#16a34a' : '#0f172a'}
              strokeWidth={stroke}
              fill="none"
              strokeDasharray={`${dash} ${gap}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${size/2} ${size/2})`}
              className={done ? '' : 'transition-[stroke-dasharray] duration-700 ease-out'}
            />
          </svg>
          {!done && <div className="absolute inset-0 grid place-items-center text-[10px] text-gray-500">{Math.round(displayPct)}%</div>}
          {done && <div className="absolute inset-0 grid place-items-center text-[10px] text-green-600">100%</div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-slate-900 truncate flex items-center gap-2">
            <span>{label || 'Working…'}</span>
            {jobId && (
              <a className="text-xs text-blue-700 hover:underline" href={`/admin/jobs/${jobId}`} target="_blank" rel="noreferrer">Open job</a>
            )}
          </div>
          <div className="text-xs text-gray-500">Elapsed {mm}:{ss.toString().padStart(2,'0')}</div>
          {messages && messages.length > 0 && (
            <div className="mt-1 text-xs text-gray-600 max-h-24 overflow-auto">
              <ul className="list-disc pl-4 space-y-0.5">
                {messages.slice(0, 4).map((m, i) => (
                  <li key={i} className="truncate" title={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {done && <button className="text-xs text-gray-500" onClick={onClose}>Close</button>}
      </div>
    </div>
  );
}

type SimpleToastType = 'success' | 'error' | 'info';
type SimpleToastMsg = { id: string; message: string; type: SimpleToastType };

export function useSimpleToasts() {
  const [items, setItems] = React.useState<SimpleToastMsg[]>([]);

  React.useEffect(() => {
    let mounted = true;
    function onToast(e: any) {
      try {
        const d = (e?.detail || {}) as { message?: string; type?: SimpleToastType };
        const message = String(d.message || '').trim();
        if (!message) return;
        const type: SimpleToastType = (d.type || 'info') as SimpleToastType;
        const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const msg: SimpleToastMsg = { id, message, type };
        setItems((prev) => [msg, ...prev].slice(0, 3));
        setTimeout(() => {
          if (!mounted) return;
          setItems((prev) => prev.filter((x) => x.id !== id));
        }, 2800);
      } catch {}
    }
    if (typeof window !== 'undefined') window.addEventListener('toast', onToast as any);
    return () => {
      mounted = false;
      if (typeof window !== 'undefined') window.removeEventListener('toast', onToast as any);
    };
  }, []);

  return { items, dismiss: (id: string) => setItems((prev) => prev.filter((x) => x.id !== id)) } as const;
}

export function SimpleToastStack() {
  const { items, dismiss } = useSimpleToasts();
  if (!items || items.length === 0) return null;
  return (
    <div className="fixed top-3 right-3 z-50 flex w-[22rem] flex-col gap-2">
      {items.map((t) => {
        const cls =
          t.type === 'success'
            ? 'border-green-200 bg-green-50 text-green-800'
            : t.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-slate-200 bg-white text-slate-900';
        return (
          <div key={t.id} className={`rounded-md border shadow-sm ${cls}`}>
            <div className="flex items-start gap-2 p-3">
              <div className="flex-1 text-sm">{t.message}</div>
              <button className="text-xs opacity-70 hover:opacity-100" onClick={() => dismiss(t.id)}>
                Close
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function useRunningJobsToast() {
  const [open, setOpen] = React.useState(false);
  const [pct, setPct] = React.useState(0);
  const [elapsedSec, setElapsedSec] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const [label, setLabel] = React.useState<string>('Working…');
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<string[]>([]);

  React.useEffect(() => {
    let mounted = true;
    function onKickoff(e: any) {
      try {
        const d = (e?.detail || {}) as { jobId?: string; label?: string };
        setOpen(true);
        setDone(false);
        setPct(20);
        setLabel(d.label || 'Job started');
        setJobId(d.jobId || null);
        setElapsedSec(0);
        setMessages([]);
        setTimeout(() => { if (mounted) setOpen(false); }, 2500);
      } catch {}
    }
    if (typeof window !== 'undefined') window.addEventListener('job-started', onKickoff as any);
    return () => { mounted = false; if (typeof window !== 'undefined') window.removeEventListener('job-started', onKickoff as any); };
  }, []);

  return { open, pct, elapsedSec, done, label, messages, jobId, close: () => setOpen(false) } as const;
}

export function ToastStack() {
  const { open, pct, elapsedSec, done, label, messages, jobId, close } = useRunningJobsToast();
  return (
    <>
      <SimpleToastStack />
      <Toast open={open} pct={pct} elapsedSec={elapsedSec} done={done} onClose={close} label={label} messages={messages} jobId={jobId} />
    </>
  );
}


