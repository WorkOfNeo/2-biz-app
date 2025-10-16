'use client';
import React, { useEffect } from 'react';

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
  // Long-running animation heuristic: advance to 90% over time, then jump to 100% when done
  const displayPct = done ? 100 : Math.max(pct, Math.min(90, elapsedSec * 2));
  return (
    <div className="fixed bottom-3 right-3 z-50 w-72 rounded-md border bg-white shadow">
      <div className="p-3 text-sm flex items-center gap-2">
        <div className={"h-3 w-3 rounded-full " + (done ? 'bg-green-600' : 'bg-slate-400 animate-pulse')}></div>
        <div className="flex-1">Updating statistics… <span className="text-xs text-gray-500">{mm}:{ss.toString().padStart(2,'0')}</span></div>
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
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  React.useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const { createClientComponentClient } = await import('@supabase/auth-helpers-nextjs');
        const supabase = createClientComponentClient();
        const { data: jobs } = await supabase
          .from('jobs')
          .select('id,status,created_at')
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
            setElapsedSec(0);
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = setInterval(() => setElapsedSec((v) => v + 1), 1000);
          } else {
            // advance progress slowly up to 90%
            setPct((v) => (v < 90 ? Math.min(90, v + 2) : v));
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

  return { open, pct, elapsedSec, done, close: () => setOpen(false) } as const;
}

export function ToastStack() {
  const { open, pct, elapsedSec, done, close } = useRunningJobsToast();
  return <Toast open={open} pct={pct} elapsedSec={elapsedSec} done={done} onClose={close} />;
}


