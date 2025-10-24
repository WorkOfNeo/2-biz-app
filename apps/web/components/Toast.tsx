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
  return <Toast open={open} pct={pct} elapsedSec={elapsedSec} done={done} onClose={close} label={label} messages={messages} jobId={jobId} />;
}


