'use client';

import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { ProgressBar } from '../../../components/ProgressBar';

type ExportRow = { id: string; kind: string; title: string | null; path: string | null; public_url: string | null; meta?: any; created_at: string };

export default function DownloadsPage() {
  const KINDS = ['general_salesmen_pdfs', 'overview_pdf', 'countries_pdf', 'top_styles_pdf'] as const;
  const LABELS: Record<(typeof KINDS)[number], string> = {
    general_salesmen_pdfs: 'General',
    overview_pdf: 'Overview',
    countries_pdf: 'Countries',
    top_styles_pdf: 'Top 10 Styles'
  };

  const { data, mutate } = useSWR('downloads:latest', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, meta, created_at')
      .in('kind', KINDS as unknown as string[])
      .order('created_at', { ascending: false })
      .limit(60);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ExportRow[];
    const latestByKind = new Map<string, ExportRow>();
    for (const r of rows) {
      if (!latestByKind.has(r.kind)) latestByKind.set(r.kind, r);
    }
    // Return in fixed order
    return KINDS.map((k) => latestByKind.get(k as string) || null);
  }, { refreshInterval: 8000 });

  const [running, setRunning] = React.useState(false);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [curStep, setCurStep] = React.useState(0); // 0..4
  const [stepProgress, setStepProgress] = React.useState<{ index: number; total: number } | null>(null);

  React.useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(async () => {
      try {
        const { data: logs } = await supabase
          .from('job_logs')
          .select('msg, data')
          .eq('job_id', jobId)
          .order('ts', { ascending: false })
          .limit(50);
        for (const l of (logs ?? []) as any[]) {
          if ((l.msg === 'STEP:export_general_progress' || l.msg === 'STEP:export_overview_progress' || l.msg === 'STEP:export_countries_progress') && l.data) {
            setStepProgress({ index: Number(l.data.index || 0), total: Number(l.data.total || 0) });
            break;
          }
          if (l.msg === 'STEP:complete') {
            setStepProgress(null);
            break;
          }
        }
      } catch {}
    }, 1200);
    return () => clearInterval(timer);
  }, [jobId]);

  function overallPct(): number {
    const base = (curStep / 4) * 100; // completed steps
    if (!stepProgress) return Math.min(99, base);
    const { index, total } = stepProgress;
    const frac = total ? Math.min(1, index / total) : 0.2;
    const within = frac * (100 / 4);
    return Math.min(99, base + within);
  }

  async function createJob(body: any) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    return js.jobId as string;
  }

  async function waitForJob(id: string) {
    for (let i = 0; i < 120; i++) {
      try {
        const { data } = await supabase.from('jobs').select('status').eq('id', id).maybeSingle();
        const st = (data as any)?.status as string | undefined;
        if (st === 'succeeded' || st === 'failed' || st === 'cancelled') return st;
      } catch {}
      await new Promise(r => setTimeout(r, 1200));
    }
    return 'timeout';
  }

  async function makeAllPdfs() {
    if (running || jobId) return;
    try {
      setRunning(true);
      setCurStep(0);
      setStepProgress(null);
      // 1) General per salesperson
      let id = await createJob({ type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf' } });
      setJobId(id); setCurStep(0);
      await waitForJob(id);
      mutate();
      // 2) Overview
      id = await createJob({ type: 'export_overview', payload: { mode: 'overview_react_pdf' } });
      setJobId(id); setCurStep(1);
      await waitForJob(id);
      mutate();
      // 3) Countries
      id = await createJob({ type: 'export_overview', payload: { mode: 'countries_react_pdf' } });
      setJobId(id); setCurStep(2);
      await waitForJob(id);
      mutate();
      // 4) Top 10 Styles
      id = await createJob({ type: 'export_top_styles', payload: {} });
      setJobId(id); setCurStep(3);
      await waitForJob(id);
      mutate();
    } catch (e) {
      // swallow
    } finally {
      setJobId(null);
      setCurStep(4);
      setStepProgress(null);
      setRunning(false);
      mutate();
    }
  }

  async function waitForUrlReady(url: string, attempts = 8, delayMs = 750): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (res.ok) return true;
      } catch {}
      await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
  }

  async function downloadPath(path: string, publicUrl?: string | null) {
    try {
      const { data: file, error } = await supabase.storage.from('exports').download(path);
      if (error || !file) throw error || new Error('Download failed');
      const blobUrl = URL.createObjectURL(file as unknown as Blob);
      const a = document.createElement('a');
      a.href = blobUrl; a.download = path.split('/').pop() || 'file.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      if (publicUrl) {
        try {
          const ready = await waitForUrlReady(publicUrl);
          if (ready) { window.open(publicUrl, '_blank', 'noopener'); return; }
        } catch {}
      }
      alert('File is not ready yet. Please try again in a moment.');
    }
  }

  async function downloadChildWithFallback(filePath?: string | null, publicUrl?: string | null) {
    if (filePath) {
      try {
        const { data: file, error } = await supabase.storage.from('exports').download(filePath);
        if (!error && file) {
          const blobUrl = URL.createObjectURL(file as unknown as Blob);
          const a = document.createElement('a');
          a.href = blobUrl; a.download = filePath.split('/').pop() || 'file.pdf';
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(blobUrl);
          return;
        }
      } catch {}
    }
    if (publicUrl) {
      try {
        const ready = await waitForUrlReady(publicUrl);
        if (ready) { window.open(publicUrl, '_blank', 'noopener'); return; }
      } catch {}
    }
    alert('File is not ready yet. Please try again in a moment.');
  }

  const latest = (data ?? []) as (ExportRow | null)[];
  const [openGeneral, setOpenGeneral] = React.useState(false);

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">Statistics</div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Downloads</h1>
        <div className="flex items-center gap-3">
          <button
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
            onClick={makeAllPdfs}
            disabled={running}
          >Make PDF's</button>
          {running && (
            <div className="flex items-center gap-2 min-w-[240px]">
              <div className="w-56"><ProgressBar value={overallPct()} /></div>
              <div className="text-xs text-gray-600">{Math.round(overallPct())}%</div>
            </div>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-500">Showing latest file per type</div>
      <div className="rounded-md border overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">Type</th>
              <th className="p-2 text-left border-b">When</th>
              <th className="p-2 text-left border-b">Link</th>
            </tr>
          </thead>
          <tbody>
            {KINDS.map((k, idx) => {
              const r = latest[idx];
              if (!r) return (
                <tr key={k}>
                  <td className="p-2 border-b whitespace-nowrap">{LABELS[k]}</td>
                  <td className="p-2 border-b text-gray-400">—</td>
                  <td className="p-2 border-b text-gray-400">No file</td>
                </tr>
              );
              const files = (r.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null }> | undefined) ?? [];
              const when = new Date(r.created_at).toLocaleString('da-DK');
              return (
                <React.Fragment key={r.id}>
                  <tr>
                    <td className="p-2 border-b whitespace-nowrap">{LABELS[r.kind as (typeof KINDS)[number]] || r.kind}</td>
                    <td className="p-2 border-b">{when}</td>
                    <td className="p-2 border-b">
                      {r.kind === 'general_salesmen_pdfs' ? (
                        <button className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => setOpenGeneral((v) => !v)}>{openGeneral ? 'Hide files' : 'Show files'}</button>
                      ) : r.public_url ? (
                        <button className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => { r.path ? downloadPath(r.path!, r.public_url) : window.open(r.public_url!, '_blank', 'noopener'); }}>Download</button>
                      ) : '—'}
                    </td>
                  </tr>
                  {r.kind === 'general_salesmen_pdfs' && openGeneral && files.map((f, i) => (
                    <tr key={i}>
                      <td className="p-2 border-b pl-6" colSpan={2}>{f.name}</td>
                      <td className="p-2 border-b">
                        {(f.publicUrl || f.path) ? (
                          <button className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => downloadChildWithFallback(f.path, f.publicUrl)}>Download</button>
                        ) : (
                          <span className="text-xs text-gray-500">(pending)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}



