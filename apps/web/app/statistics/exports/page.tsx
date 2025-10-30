'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { ChevronRight, ChevronDown } from 'lucide-react';

type ExportRow = { id: string; kind: string; title: string | null; path: string; public_url: string | null; created_at: string };

export default function StatisticsExportsPage() {
  const { data } = useSWR('exports:all', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, meta, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  }, { refreshInterval: 10000 });

  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.value as { s1?: string; s2?: string }) ?? {};
  });

  const [jobId, setJobId] = React.useState<string | null>(null as any);
  const [progress, setProgress] = React.useState<{ index: number; total: number } | null>(null as any);
  const [running, setRunning] = React.useState(false as any);
  const [tempRows, setTempRows] = React.useState<any[]>([]);
  const [openId, setOpenId] = React.useState<string | null>(null);

  function timeAgo(iso: string): string {
    const d = new Date(iso).getTime();
    const diff = Math.floor((Date.now() - d) / 1000);
    const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
      [60, 'second'],
      [60, 'minute'],
      [24, 'hour'],
      [7, 'day'],
      [4.34524, 'week'],
      [12, 'month'],
      [Number.POSITIVE_INFINITY, 'year']
    ];
    let unit: Intl.RelativeTimeFormatUnit = 'second';
    let value = -diff; // past -> negative
    let acc = diff;
    for (let i = 0, n = diff; i < units.length; i++) {
      const pair = units[i];
      if (!pair) break;
      const [step, u] = pair;
      if (n < step) { unit = u; value = -Math.round(acc); break; }
      n = Math.floor(n / step);
      acc = n;
      unit = u;
      value = -Math.round(acc);
    }
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    return rtf.format(value as number, unit);
  }

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
            if (l.msg === 'STEP:complete') { setRunning(false); setJobId(null); setProgress(null); // temp row removed via effect below
              break; }
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
    // Insert a temp row at top
    setTempRows((prev) => [{ id: `temp-${js.jobId}`, kind: 'general_salesmen_zip', title: 'General · Salesmen', path: '', public_url: null, created_at: new Date().toISOString(), __temp: true }, ...prev]);
  }

  // Remove temp row when a corresponding export arrives
  React.useEffect(() => {
    if (!running && tempRows.length > 0) {
      // If we detect an exports row with kind general_salesmen_zip newer than job start, remove temp
      const found = (data ?? []).some((r: any) => r.kind === 'general_salesmen_zip');
      if (found) setTempRows([]);
    }
  }, [running, data, tempRows.length]);

  async function downloadPath(path: string) {
    try {
      const { data: file, error } = await supabase.storage.from('exports').download(path);
      if (error || !file) throw error || new Error('Download failed');
      const blobUrl = URL.createObjectURL(file as unknown as Blob);
      const a = document.createElement('a');
      a.href = blobUrl; a.download = path.split('/').pop() || 'file.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      alert('File is not ready yet. Please try again in a moment.');
    }
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
      <div className="rounded-md border overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b"> </th>
              <th className="p-2 text-left border-b">When</th>
              <th className="p-2 text-left border-b">Kind</th>
              <th className="p-2 text-left border-b">Title</th>
              <th className="p-2 text-left border-b">Link</th>
              <th className="p-2 text-right border-b"> </th>
            </tr>
          </thead>
          <tbody>
            {[...tempRows, ...(data ?? [])].map((r: any) => {
              const files = (r.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null }> | undefined) ?? [];
              const all = r.meta?.all as { path?: string | null; publicUrl?: string | null } | undefined;
              const hasChildren = Array.isArray(files) && files.length > 0;
              return (
                <React.Fragment key={r.id}>
                  <tr>
                    <td className="p-2 border-b whitespace-nowrap w-[44px]">
                      {hasChildren ? (
                        <button
                          className="rounded border px-2 py-0.5 text-xs hover:bg-slate-50"
                          onClick={() => setOpenId((prev) => (prev === r.id ? null : r.id))}
                          aria-label={openId === r.id ? 'Collapse' : 'Expand'}
                        >{openId === r.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>
                      ) : null}
                    </td>
                    <td className="p-2 border-b whitespace-nowrap">{timeAgo(r.created_at)}</td>
                    <td className="p-2 border-b">{r.kind}</td>
                    <td className="p-2 border-b">{r.title ?? '—'}</td>
                    <td className="p-2 border-b">{r.public_url ? (
                      <button
                        className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50"
                        onClick={() => { r.path ? downloadPath(r.path) : window.open(r.public_url, '_blank', 'noopener'); }}
                      >Download ZIP</button>
                    ) : '—'}</td>
                    <td className="p-2 border-b text-right">
                      {r.__temp && (
                        <span className="text-xs text-slate-600">Processing{progress?.total ? ` · ${progress.index}/${progress.total}` : ''}</span>
                      )}
                    </td>
                  </tr>
                  {hasChildren && openId === r.id && (
                    <tr>
                      <td className="p-2 border-b bg-gray-50" colSpan={6}>
                        <div className="mt-1 space-y-1">
                          {all?.publicUrl && (
                            <div className="flex items-center justify-between">
                              <div className="text-sm font-medium">All (combined)</div>
                              <button className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => { all.path ? downloadPath(all.path) : window.open(all.publicUrl!, '_blank', 'noopener'); }}>Download</button>
                            </div>
                          )}
                          {files.map((f: any, i: number) => (
                            <div key={i} className="flex items-center justify-between">
                              <div className="text-sm">{f.name}</div>
                              <div>
                                {f.publicUrl || f.path ? (
                                  <button className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => { f.path ? downloadPath(f.path) : window.open(f.publicUrl!, '_blank', 'noopener'); }}>Download</button>
                                ) : (
                                  <span className="text-xs text-gray-500">(pending)</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


