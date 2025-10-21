'use client';
import React, { useEffect } from 'react';

export function Toast({ open, pct, elapsedSec, done, onClose, label, messages }: { open: boolean; pct: number; elapsedSec: number; done: boolean; onClose: () => void; label?: string; messages?: string[] }) {
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
          <div className="text-sm font-medium text-slate-900 truncate">{label || 'Working…'}</div>
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
            setJobId(j.id as string);
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
              setJobId(j.id as string);
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

  // Fetch recent job logs for the active job to show human messages
  React.useEffect(() => {
    if (!jobId) return;
    let mounted = true;
    async function fetchLogs() {
      try {
        const { createClientComponentClient } = await import('@supabase/auth-helpers-nextjs');
        const supabase = createClientComponentClient();
        const { data: logs } = await supabase
          .from('job_logs')
          .select('msg, ts')
          .eq('job_id', jobId)
          .order('ts', { ascending: false })
          .limit(10);
        if (!mounted) return;
        const mapMsg = (m: string) => {
          const dict: Record<string, string> = {
            'STEP:begin_deep': 'Starting deep scrape…',
            'STEP:topseller_ready': 'Topseller page ready',
            'STEP:salespersons_total': 'Reading salespersons…',
            'STEP:salesperson_start': 'Scraping salesperson…',
            'STEP:salesperson_done': 'Salesperson done',
            'STEP:invoiced_begin': 'Loading invoiced lines…',
            'STEP:invoiced_ready': 'Invoiced lines ready',
            'STEP:styles_begin': 'Scraping styles…',
            'STEP:styles_rows': 'Parsed styles index',
            'STEP:style_stock_begin': 'Updating style stock…',
            'STEP:style_stock_rows': 'Parsed style stock rows',
            'STEP:deep_styles_begin': 'Deep scraping materials…',
            'STEP:deep_styles_no_color_box': 'No materials found for a style',
            'STEP:complete': 'Completed'
          };
          return dict[m] || m;
        };
        const msgs = (logs ?? []).map((l: any) => mapMsg((l.msg || '').toString()));
        setMessages(msgs);
      } catch {}
    }
    const iv = setInterval(fetchLogs, 2000);
    fetchLogs();
    return () => { mounted = false; clearInterval(iv); };
  }, [jobId]);

  return { open, pct, elapsedSec, done, label, messages, close: () => setOpen(false) } as const;
}

export function ToastStack() {
  const { open, pct, elapsedSec, done, label, messages, close } = useRunningJobsToast();
  return <Toast open={open} pct={pct} elapsedSec={elapsedSec} done={done} onClose={close} label={label} messages={messages} />;
}


