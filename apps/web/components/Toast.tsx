'use client';
import React, { useEffect } from 'react';

export function Toast({ open, pct, elapsedSec, done, onClose, label }: { open: boolean; pct: number; elapsedSec: number; done: boolean; onClose: () => void; label?: string }) {
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
  return (
    <div className="fixed bottom-3 right-3 z-50 w-72 rounded-md border bg-white shadow">
      <div className="p-3 text-sm flex items-center gap-2">
        <div className={"h-3 w-3 rounded-full " + (done ? 'bg-green-600' : 'bg-slate-400 animate-pulse')}></div>
        <div className="flex-1">{label || 'Working…'} <span className="text-xs text-gray-500">{mm}:{ss.toString().padStart(2,'0')}</span></div>
        {done && <button className="text-xs text-gray-500" onClick={onClose}>Close</button>}
      </div>
      <div className="px-3 pb-3">
        <div className="h-1 w-full rounded bg-gray-200 overflow-hidden">
          <div className="h-full bg-slate-900 transition-[width] duration-700 ease-out" style={{ width: displayPct + '%' }} />
        </div>
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
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const baseMsRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const { createClientComponentClient } = await import('@supabase/auth-helpers-nextjs');
        const supabase = createClientComponentClient();
        const { data: jobs } = await supabase
          .from('jobs')
          .select('id,status,created_at,started_at,type')
          .in('status', ['queued','running'])
          .order('created_at', { ascending: false })
          .limit(1);
        const running = (jobs ?? []).length > 0;
        if (!mounted) return;
        if (running) {
          if (!open) {
            setOpen(true);
            setDone(false);
            setPct(15);
            const j = (jobs as any[])[0];
            const startMs = new Date(j.started_at || j.created_at).getTime();
            baseMsRef.current = startMs;
            setElapsedSec(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
            const t = (j.type || '').toString();
            const map = (x: string) => x
              .replace(/_/g, ' ')
              .replace(/^scrape statistics$/i, 'Scrape statistics')
              .replace(/^scrape styles$/i, 'Scrape styles')
              .replace(/^update style stock$/i, 'Scrape stock')
              .replace(/^export overview$/i, 'Export overview')
              .replace(/^deep scrape styles$/i, 'Deep scrape styles')
              .replace(/^scrape customers$/i, 'Scrape customers')
              .replace(/\b\w/g, (m) => m.toUpperCase());
            setLabel(map(t) || 'Working…');
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = setInterval(() => {
              if (baseMsRef.current) {
                setElapsedSec(Math.max(0, Math.floor((Date.now() - baseMsRef.current) / 1000)));
              } else {
                setElapsedSec((v) => v + 1);
              }
            }, 1000);
          } else {
            // advance progress slowly up to 90%
            setPct((v) => (v < 90 ? Math.min(90, v + 2) : v));
            const j = (jobs as any[])[0];
            if (baseMsRef.current) {
              // keep elapsed in sync in case of tab throttling
              setElapsedSec(Math.max(0, Math.floor((Date.now() - baseMsRef.current) / 1000)));
            }
            if (j?.type) {
              const t = (j.type || '').toString();
              const map = (x: string) => x
                .replace(/_/g, ' ')
                .replace(/^scrape statistics$/i, 'Scrape statistics')
                .replace(/^scrape styles$/i, 'Scrape styles')
                .replace(/^update style stock$/i, 'Scrape stock')
                .replace(/^export overview$/i, 'Export overview')
                .replace(/^deep scrape styles$/i, 'Deep scrape styles')
                .replace(/^scrape customers$/i, 'Scrape customers')
                .replace(/\b\w/g, (m) => m.toUpperCase());
              setLabel(map(t) || 'Working…');
            }
          }
        } else if (open) {
          setPct(100);
          setDone(true);
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          setTimeout(() => setOpen(false), 1500);
        }
      } catch {}
    }
    const iv = setInterval(poll, 2000);
    poll();
    return () => { mounted = false; clearInterval(iv); if (timerRef.current) clearInterval(timerRef.current); };
  }, [open]);

  return { open, pct, elapsedSec, done, label, close: () => setOpen(false) } as const;
}

export function ToastStack() {
  const { open, pct, elapsedSec, done, label, close } = useRunningJobsToast();
  return <Toast open={open} pct={pct} elapsedSec={elapsedSec} done={done} onClose={close} label={label} />;
}


