'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { ProgressBar } from '../../../components/ProgressBar';

type ExportRow = { id: string; kind: string; title: string | null; path: string; public_url: string | null; created_at: string };

export default function StatisticsExportsPage() {
  const { data } = useSWR('exports:all', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as ExportRow[];
  }, { refreshInterval: 10000 });

  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as { s1?: string; s2?: string }) ?? {};
  });

  const [jobId, setJobId] = React.useState<string | null>(null as any);
  const [progress, setProgress] = React.useState<{ index: number; total: number } | null>(null as any);
  const [running, setRunning] = React.useState(false as any);

  React.useEffect(() => {
    let timer: any;
    if (jobId) {
      setRunning(true);
      timer = setInterval(async () => {
        try {
          const { data: logs } = await supabase
            .from('job_logs')
            .select('msg, data')
            .eq('job_id', jobId)
            .order('ts', { ascending: false })
            .limit(50);
          for (const l of (logs ?? []) as any[]) {
            if (l.msg === 'STEP:export_general_progress' && l.data) {
              setProgress({ index: Number(l.data.index || 0), total: Number(l.data.total || 0) });
              break;
            }
            if (l.msg === 'STEP:complete') {
              setRunning(false);
              break;
            }
          }
        } catch {}
      }, 1500);
    }
    return () => { if (timer) clearInterval(timer); };
  }, [jobId]);

  async function enqueueGeneralReactPdf() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf', requestedBy: session.user.email, s1: saved?.s1, s2: saved?.s2 } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Statistics</div>
          <h1 className="text-xl font-semibold">Exports</h1>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50" onClick={enqueueGeneralReactPdf}>Export General (React PDF · per salesperson)</button>
        </div>
      </div>
      {running && (
        <div className="rounded-md border p-3">
          <div className="text-sm font-medium mb-1">Generating…</div>
          <div className="max-w-sm">
            <ProgressBar value={progress?.total ? Math.round((Math.min(progress.index, progress.total) / progress.total) * 100) : 5} />
          </div>
          <div className="text-xs text-gray-600 mt-1">{progress ? `${progress.index}/${progress.total}` : 'Starting…'}</div>
        </div>
      )}

      <div className="rounded-md border overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">When</th>
              <th className="p-2 text-left border-b">Kind</th>
              <th className="p-2 text-left border-b">Title</th>
              <th className="p-2 text-left border-b">Path</th>
              <th className="p-2 text-left border-b">Link</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="p-2 border-b whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td className="p-2 border-b">{r.kind}</td>
                <td className="p-2 border-b">{r.title ?? '—'}</td>
                <td className="p-2 border-b font-mono text-[12px]">{r.path}</td>
                <td className="p-2 border-b">{r.public_url ? <a href={r.public_url} target="_blank" rel="noreferrer" download className="text-blue-700 underline">Download</a> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


