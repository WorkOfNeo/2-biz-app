'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { ChevronRight, ChevronDown, MoreHorizontal } from 'lucide-react';

type ExportRow = { id: string; kind: string; title: string | null; path: string; public_url: string | null; created_at: string; comment: string | null };

// Prompt for comment
function promptComment(): Promise<string | null> {
  return new Promise((resolve) => {
    const comment = window.prompt('Enter a comment for this export (optional):');
    resolve(comment || null);
  });
}

export default function StatisticsExportsPage() {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { data } = useSWR('exports:all', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, meta, created_at, comment')
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
  const [elapsed, setElapsed] = React.useState(0 as any);
  const [jobDone, setJobDone] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Record<string, Set<string>>>({});
  const [zipProgress, setZipProgress] = React.useState<Record<string, { done: number; total: number } | null>>({});

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
      setElapsed(0);
      const t = setInterval(() => setElapsed((v: number) => v + 1), 1000);
      timer = setInterval(async () => {
        try {
          const { data: logs } = await supabase
            .from('job_logs')
            .select('msg, data')
            .eq('job_id', jobId)
            .order('ts', { ascending: false })
            .limit(50);
          for (const l of (logs ?? []) as any[]) {
            if ((l.msg === 'STEP:export_general_progress' || l.msg === 'STEP:export_overview_progress' || l.msg === 'STEP:export_countries_progress') && l.data) {
              setProgress({ index: Number(l.data.index || 0), total: Number(l.data.total || 0) });
              break;
            }
            if (l.msg === 'STEP:complete') {
              setRunning(false); setJobId(null); setProgress(null); setJobDone(true);
              setTimeout(() => setJobDone(false), 4000);
              break;
            }
          }
          // Also check job status as a fallback to clear the spinner
          const { data: jobRow } = await supabase.from('jobs').select('status').eq('id', jobId).maybeSingle();
          if ((jobRow as any)?.status === 'succeeded' || (jobRow as any)?.status === 'failed' || (jobRow as any)?.status === 'cancelled') {
            setRunning(false); setJobId(null); setProgress(null); setJobDone(true);
            setTimeout(() => setJobDone(false), 3000);
          }
        } catch {}
      }, 1500);
      return () => { if (timer) clearInterval(timer); clearInterval(t); };
    }
    return () => { if (timer) clearInterval(timer); };
  }, [jobId]);

  async function enqueueGeneralReactPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf', requestedBy: session.user.email, s1: saved?.s1, s2: saved?.s2, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function enqueueOverviewPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_overview', payload: { mode: 'overview_react_pdf', requestedBy: session.user.email, s1: saved?.s1, s2: saved?.s2, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function enqueueCountriesPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_overview', payload: { mode: 'countries_react_pdf', requestedBy: session.user.email, s1: saved?.s1, s2: saved?.s2, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function enqueueTopStylesPdf() {
    const comment = await promptComment();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const body = { type: 'export_top_styles', payload: { requestedBy: session.user.email, comment } };
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    setJobId(js.jobId);
  }

  async function createJob(body: any, comment?: string | null) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    // Add comment to payload if provided
    if (comment !== undefined && body.payload) {
      body.payload.comment = comment;
    }
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    return js.jobId as string;
  }

  async function waitForJob(jobId: string) {
    // Poll jobs table until done
    for (let i = 0; i < 120; i++) { // up to ~3 minutes
      try {
        const { data } = await supabase.from('jobs').select('status').eq('id', jobId).maybeSingle();
        const st = (data as any)?.status as string | undefined;
        if (st === 'succeeded' || st === 'failed' || st === 'cancelled') return st;
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
    return 'timeout';
  }

  async function enqueueAllExportsSequential() {
    if (running || jobId) return;
    // Prompt for comment once for all exports
    const comment = await promptComment();
    try {
      setRunning(true);
      setProgress(null);
      // 1) General per salesperson (React PDF)
      let id = await createJob({ type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf' } }, comment);
      setJobId(id);
      await waitForJob(id);
      // 2) Overview PDF
      id = await createJob({ type: 'export_overview', payload: { mode: 'overview_react_pdf' } }, comment);
      setJobId(id);
      await waitForJob(id);
      // 3) Countries PDF
      id = await createJob({ type: 'export_overview', payload: { mode: 'countries_react_pdf' } }, comment);
      setJobId(id);
      await waitForJob(id);
      // 4) Top 10 Styles PDF
      id = await createJob({ type: 'export_top_styles', payload: {} }, comment);
      setJobId(id);
      await waitForJob(id);
      // 5) Stock Lists PDF(s)
      id = await createJob({ type: 'export_stock_list', payload: {} }, comment);
      setJobId(id);
      await waitForJob(id);
      setJobId(null);
      setRunning(false);
      setJobDone(true);
      setTimeout(() => setJobDone(false), 4000);
    } catch (e) {
      setRunning(false);
    }
  }

  function toggleSelect(exportId: string, filePath: string) {
    setSelected((prev) => {
      const copy: Record<string, Set<string>> = { ...prev };
      const set = new Set(copy[exportId] ? Array.from(copy[exportId]) : []);
      if (set.has(filePath)) set.delete(filePath); else set.add(filePath);
      copy[exportId] = set;
      return copy;
    });
  }

  function toggleSelectAll(exportId: string, filePaths: string[], on: boolean) {
    setSelected((prev) => {
      const copy: Record<string, Set<string>> = { ...prev };
      copy[exportId] = on ? new Set(filePaths) : new Set();
      return copy;
    });
  }

  function isSelected(exportId: string, filePath: string): boolean {
    return Boolean(selected[exportId] && selected[exportId].has(filePath));
  }

  async function downloadSelectedAsZip(exportId: string, files: Array<{ path: string; name?: string }>) {
    const chosen = files.filter((f) => selected[exportId]?.has(f.path));
    if (chosen.length === 0) return;
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    setZipProgress((p) => ({ ...p, [exportId]: { done: 0, total: chosen.length } }));
    for (const f of chosen) {
      try {
        const { data: blob, error } = await supabase.storage.from('exports').download(f.path);
        if (!error && blob) {
          const filename = f.name ? `${f.name}.pdf` : (f.path.split('/').pop() || 'file.pdf');
          zip.file(filename, blob as unknown as Blob);
        }
      } catch {}
      setZipProgress((p) => {
        const cur = p[exportId] || { done: 0, total: chosen.length };
        return { ...p, [exportId]: { done: Math.min(cur.done + 1, cur.total), total: cur.total } };
      });
    }
    const out = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(out);
    const a = document.createElement('a');
    a.href = url; a.download = 'selected.pdf.zip';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setZipProgress((p) => ({ ...p, [exportId]: null }));
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

  async function downloadChildWithFallback(filePath?: string | null, publicUrl?: string | null, zipPath?: string | null) {
    // Try direct storage first; do not alert here so fallbacks can run
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
    // Then public URL if present
    if (publicUrl) {
      try {
        const ready = await waitForUrlReady(publicUrl);
        if (ready) { window.open(publicUrl, '_blank', 'noopener'); return; }
      } catch {}
    }
    // Finally, fall back to ZIP extraction if available
    if (zipPath) {
      try {
        const { data: zipBlob, error } = await supabase.storage.from('exports').download(zipPath);
        if (error || !zipBlob) throw error || new Error('Zip download failed');
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(zipBlob as unknown as Blob);
        const wanted = filePath ? (filePath.split('/').pop() || '') : '';
        let entry = wanted ? zip.file(new RegExp(`${wanted.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`)) : null;
        if (!entry || entry.length === 0) {
          // fallback: first PDF
          entry = zip.file(/\.pdf$/i);
        }
        if (entry && entry.length > 0) {
          const first = entry[0] as any;
          if (first) {
            const content = await first.async('blob');
            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url; a.download = (first.name?.split('/').pop()) || 'file.pdf';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            return;
          }
        }
      } catch {}
    }
    alert('File is not ready yet. Please try again in a moment.');
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Statistics</div>
          <h1 className="text-xl font-semibold">Exports</h1>
        </div>
        <div className="flex items-center gap-2 relative">
          <button
            className="relative rounded-md border px-2 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60 inline-flex items-center gap-1"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={running}
          >
            <MoreHorizontal className="h-4 w-4" />
            Actions
          </button>
          {menuOpen && (
            <div className="absolute right-[140px] top-full mt-1 w-64 rounded border bg-white shadow z-10">
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60"
                onClick={() => { enqueueGeneralReactPdf(); setMenuOpen(false); }}
                disabled={running}
              >
                Export General (React PDF · per salesperson)
              </button>
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60"
                onClick={() => { enqueueOverviewPdf(); setMenuOpen(false); }}
                disabled={running}
              >
                Export Overview (PDF)
              </button>
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60"
                onClick={() => { enqueueCountriesPdf(); setMenuOpen(false); }}
                disabled={running}
              >
                Export Countries (PDF)
              </button>
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60"
                onClick={() => { enqueueTopStylesPdf(); setMenuOpen(false); }}
                disabled={running}
              >
                Export Top 10 Styles (PDF)
              </button>
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60"
                onClick={async () => {
                  try {
                    const comment = await promptComment();
                    const { data: { session } } = await supabase.auth.getSession();
                    if (!session) throw new Error('Not signed in');
                    const token = session.access_token;
                    await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'export_stock_list', payload: { comment } }) });
                  } finally { setMenuOpen(false); }
                }}
                disabled={running}
              >
                Export Stock List (Lists)
              </button>
            </div>
          )}
          <button
            className="relative rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
            onClick={enqueueAllExportsSequential}
            disabled={running}
          >
            Run All Exports
          </button>
          <div className="ml-2 min-w-[180px] text-xs text-gray-700 flex items-center gap-2">
            {running && (
              <>
                <span className="h-3 w-3 rounded-full border-2 border-slate-300 border-t-slate-900 animate-spin" />
                <span>Generating… {elapsed}s{progress ? ` (${progress.index}/${progress.total})` : ''}</span>
              </>
            )}
            {!running && jobDone && (
              <span className="inline-flex items-center gap-1 text-green-700">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-7.5 9.5a.75.75 0 01-1.127.03l-3.5-4a.75.75 0 111.14-.976l2.918 3.335 6.943-8.792a.75.75 0 011.051-.149z" clipRule="evenodd" /></svg>
                Job complete
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="rounded-md border overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">When</th>
              <th className="p-2 text-left border-b">Kind</th>
              <th className="p-2 text-left border-b">Title</th>
              <th className="p-2 text-left border-b">Comment</th>
              <th className="p-2 text-left border-b">Link</th>
              <th className="p-2 text-right border-b"> </th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r: any) => {
              const files = (r.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null }> | undefined) ?? [];
              const all = r.meta?.all as { path?: string | null; publicUrl?: string | null } | undefined;
              const hasChildren = Array.isArray(files) && files.length > 0;
              return (
                <React.Fragment key={r.id}>
                  <tr>
                    <td className="p-2 border-b whitespace-nowrap">{timeAgo(r.created_at)}</td>
                    <td className="p-2 border-b">{r.kind}</td>
                    <td className="p-2 border-b">
                      <div className="flex items-center gap-2">
                        <span>{r.title ?? '—'}</span>
                        {r.kind === 'general_salesmen_pdfs' && r.meta?.seasons?.s1 && (
                          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                            {r.meta.seasons.s1} vs {r.meta.seasons.s2}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-2 border-b text-sm text-gray-600 max-w-xs truncate" title={r.comment || undefined}>
                      {r.comment || '—'}
                    </td>
                    <td className="p-2 border-b">{r.public_url ? (
                      <button
                        className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50"
                        onClick={() => { r.path ? downloadPath(r.path, r.public_url) : window.open(r.public_url, '_blank', 'noopener'); }}
                      >Download</button>
                    ) : '—'}</td>
                    <td className="p-2 border-b text-right w-[44px]">
                      {hasChildren ? (
                        <button
                          className="rounded border px-2 py-0.5 text-xs hover:bg-slate-50"
                          onClick={() => setOpenId((prev) => (prev === r.id ? null : r.id))}
                          aria-label={openId === r.id ? 'Collapse' : 'Expand'}
                        >{openId === r.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>
                      ) : null}
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
                          {files.length > 0 && (
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className="text-sm font-medium">Selection</div>
                                <label className="inline-flex items-center gap-1 text-xs">
                                  {(() => {
                                    const allPaths = files.map((f:any) => f.path);
                                    const allOn = (selected[r.id]?.size ?? 0) === files.length;
                                    return (
                                      <>
                                        <input
                                          type="checkbox"
                                          className="h-3 w-3"
                                          checked={allOn}
                                          onChange={(e) => toggleSelectAll(r.id, allPaths, e.target.checked)}
                                        />
                                        <span>Select all</span>
                                      </>
                                    );
                                  })()}
                                </label>
                              </div>
                              <div className="flex items-center gap-3">
                                {zipProgress[r.id] && (
                                  <div className="text-xs text-gray-600">Zipping {zipProgress[r.id]!.done}/{zipProgress[r.id]!.total}</div>
                                )}
                                <button
                                  className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
                                  onClick={() => downloadSelectedAsZip(r.id, files.map((f:any)=>({ path: f.path, name: f.name })))}
                                  disabled={(selected[r.id]?.size ?? 0) === 0}
                                >Download selected as ZIP</button>
                              </div>
                            </div>
                          )}
                          {files.map((f: any, i: number) => (
                            <div key={i} className="flex items-center justify-between">
                              <div className="text-sm flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="h-3 w-3"
                                  checked={isSelected(r.id, f.path)}
                                  onChange={() => toggleSelect(r.id, f.path)}
                                />
                                <span>{f.name}</span>
                              </div>
                              <div>
                                {f.publicUrl || f.path ? (
                                  <button className="rounded-md border px-2 py-1 text-xs hover:bg-slate-50" onClick={() => downloadChildWithFallback(f.path, f.publicUrl, r.path)}>Download</button>
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


