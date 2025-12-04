'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';

type Job = { id: string; type: string; status: string; created_at: string; started_at: string | null; finished_at: string | null; payload: any };

export default function StockScraperPage() {
  const { data: running } = useSWR('stock-scraper:running', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, type, status, created_at, started_at, finished_at, payload')
      .eq('type', 'update_style_stock')
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0] as Job | undefined) ?? null;
  }, { refreshInterval: 5000 });

  const { data: latest } = useSWR('stock-scraper:latest', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, type, status, created_at, started_at, finished_at, payload')
      .eq('type', 'update_style_stock')
      .in('status', ['succeeded','failed','cancelled'])
      .order('finished_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0] as Job | undefined) ?? null;
  }, { refreshInterval: 15000 });

  const jobId = running?.id || null;
  const rootId = (running?.payload as any)?.rootId || running?.id || null;
  
  // Aggregate progress across all batches for this root job
  const { data: progress } = useSWR(rootId ? `stock-scraper:aggregate-progress:${rootId}` : null, async () => {
    if (!rootId) return null;
    
    // Get all jobs for this root (including the root itself)
    const { data: allJobs } = await supabase
      .from('jobs')
      .select('id, status')
      .eq('type', 'update_style_stock')
      .or(`id.eq.${rootId},payload->>rootId.eq.${rootId}`)
      .in('status', ['running', 'succeeded', 'queued']);
    
    if (!allJobs || allJobs.length === 0) return null;
    
    const jobIds = allJobs.map(j => j.id);
    
    // Get all progress logs from all jobs
    const { data: allLogs } = await supabase
      .from('job_logs')
      .select('job_id, msg, data, ts')
      .in('job_id', jobIds)
      .in('msg', ['STEP:update_style_stock_progress', 'STEP:style_stock_filtered', 'STEP:complete', 'STEP:style_stock_total_requested', 'STEP:style_stock_style_done'])
      .order('ts', { ascending: true })
      .limit(5000);
    
    if (!allLogs) return null;
    
    // Find total requested count (from root job's initial log)
    let totalRequested = 0;
    for (const log of allLogs) {
      if (log.job_id === rootId && log.msg === 'STEP:style_stock_total_requested') {
        totalRequested = log.data?.totalRequested || 0;
        break;
      }
    }
    
    // Count total active styles (sum of filtered counts from all batches)
    let totalActive = 0;
    let totalSkippedInactive = 0;
    const seenBatches = new Set<string>();
    for (const log of allLogs) {
      if (log.msg === 'STEP:style_stock_filtered' && !seenBatches.has(log.job_id)) {
        seenBatches.add(log.job_id);
        totalActive += log.data?.activeCount || 0;
        totalSkippedInactive += log.data?.skippedInactive || 0;
      }
    }
    
    // Count completed styles (using style_stock_style_done logs)
    const completedStyles = new Set<string>();
    for (const log of allLogs) {
      if (log.msg === 'STEP:style_stock_style_done' && log.data?.style_no) {
        completedStyles.add(log.data.style_no);
      }
    }
    
    // Get the most recent style being processed
    let currentStyleNo: string | null = null;
    let currentStyleName: string | null = null;
    for (let i = allLogs.length - 1; i >= 0; i--) {
      const log = allLogs[i];
      if (log && log.msg === 'STEP:update_style_stock_progress' && log.data?.style_no) {
        currentStyleNo = log.data.style_no;
        currentStyleName = log.data.style_name || null;
        break;
      }
    }
    
    const completed = completedStyles.size;
    const total = totalActive || 1;
    const percent = Math.min(100, Math.floor((completed / total) * 100));
    
    // Calculate estimated time remaining
    let estimatedSecondsRemaining: number | null = null;
    const firstDoneLog = allLogs.find(l => l.msg === 'STEP:style_stock_style_done');
    if (firstDoneLog && completed > 0) {
      const startTime = new Date(firstDoneLog.ts).getTime();
      const elapsed = Date.now() - startTime;
      const avgTimePerStyle = elapsed / completed;
      const remaining = total - completed;
      estimatedSecondsRemaining = Math.floor((remaining * avgTimePerStyle) / 1000);
    }
    
    return {
      index: completed,
      total: total,
      totalRequested,
      skippedInactive: totalSkippedInactive,
      percent,
      style_no: currentStyleNo,
      style_name: currentStyleName,
      estimatedSecondsRemaining
    };
  }, { refreshInterval: 2000 });

  const { data: processed } = useSWR(jobId ? `stock-scraper:processed:${jobId}` : null, async () => {
    const { data, error } = await supabase
      .from('job_logs')
      .select('msg, data, ts')
      .eq('job_id', jobId!)
      .order('ts', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const list: Array<{ style_no: string; style_name?: string | null; ms?: number; rows?: number; ts: string }> = [];
    const seen = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      if (r.msg === 'STEP:style_stock_style_done' && r.data?.style_no) {
        const key = String(r.data.style_no);
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ style_no: r.data.style_no, style_name: r.data.style_name ?? null, ms: r.data.ms, rows: r.data.rows, ts: r.ts });
        }
      }
    }
    return list.reverse();
  }, { refreshInterval: 2000 });

  const { data: batches } = useSWR(rootId ? `stock-scraper:batches:${rootId}` : null, async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, status, payload')
      .eq('type', 'update_style_stock')
      .in('status', ['queued','running'])
      .contains('payload', { rootId });
    if (error) throw new Error(error.message);
    const total = (data ?? []).length;
    const runningCount = (data ?? []).filter((j: any) => j.status === 'running').length;
    const queuedCount = total - runningCount;
    const currentIdx = Number((running?.payload as any)?.batchIndex || 1);
    const batchTotal = Number((running?.payload as any)?.batchTotal || Math.max(1, total));
    return { total, running: runningCount, queued: queuedCount, currentIdx, batchTotal };
  }, { refreshInterval: 3000 });

  const { data: related } = useSWR(rootId ? `stock-scraper:related:${rootId}` : null, async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, status, created_at, payload')
      .eq('type', 'update_style_stock')
      .contains('payload', { rootId })
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; status: string; created_at: string; payload: any }>;
  }, { refreshInterval: 10000 });
  const [showRelated, setShowRelated] = React.useState(false);
  const [startFrom, setStartFrom] = React.useState<string>('0');
  const [limit, setLimit] = React.useState<string>('25');
  const [singleStyle, setSingleStyle] = React.useState<string>('');

  const { data: styleChoices } = useSWR('stock-scraper:style-dropdown', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier')
      .order('style_no', { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; style_no: string; style_name?: string | null; supplier?: string | null }>;
  }, { refreshInterval: 0 });

  const { data: recent } = useSWR('stock-scraper:recent', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, status, created_at, started_at, finished_at, payload')
      .eq('type', 'update_style_stock')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<Job>;
  }, { refreshInterval: 10000 });

  async function stopJob() {
    if (!jobId) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const token = session.access_token;
    await fetch(`/api/jobs/${jobId}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  }

  function timeAgo(iso?: string | null): string {
    if (!iso) return '';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    const mins = Math.floor(diff / 60); const secs = diff % 60;
    return `${mins}m ${secs}s ago`;
  }

  function formatMs(ms?: number): string {
    if (!ms || ms < 0) return '—';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function formatEstimatedTime(seconds: number): string {
    if (seconds < 60) return `${seconds} seconds`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hours}h ${remainingMins}m`;
  }

  async function enqueueAll() {
    await fetch('/api/cron/update-stock-all', { method: 'POST' });
  }

  async function enqueueSelected() {
    await fetch('/api/cron/update-stock-selected', { method: 'POST' });
  }

  async function enqueueSingleStyle() {
    if (!singleStyle) {
      alert('Select a style number first');
      return;
    }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert('Not signed in');
        return;
      }
      const styleEntry = (styleChoices ?? []).find((s) => String(s.style_no) === singleStyle);
      const styleNo = styleEntry?.style_no || singleStyle;
      if (!styleNo) {
        alert('Selected style missing style number');
        return;
      }
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          type: 'update_style_stock',
          payload: {
            requestedBy: session.user.email,
            styleNos: [styleNo]
          }
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Failed (${res.status})`);
      }
      setSingleStyle('');
      alert(`Enqueued scrape for style ${styleNo}`);
    } catch (e: any) {
      alert(e?.message || 'Failed to enqueue style');
      console.error('[stock-scraper] enqueueSingleStyle error', e);
    }
  }

  async function enqueueWithLimit() {
    const start = parseInt(startFrom, 10);
    const lim = parseInt(limit, 10);
    if (isNaN(start) || start < 0) {
      alert('Start from must be a non-negative number');
      return;
    }
    if (isNaN(lim) || lim < 1) {
      alert('Limit must be a positive number');
      return;
    }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert('Not signed in');
        return;
      }
      // Fetch styles with offset and limit
      const { data: styles, error } = await supabase
        .from('styles')
        .select('style_no')
        .order('updated_at', { ascending: false })
        .range(start, start + lim - 1);
      if (error) throw new Error(error.message);
      const styleNos = ((styles ?? []) as any[]).map((r) => String(r.style_no || '')).filter(Boolean);
      if (styleNos.length === 0) {
        alert(`No styles found in range ${start} to ${start + lim - 1}`);
        return;
      }
      // Enqueue job with these styleNos
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ 
          type: 'update_style_stock', 
          payload: { 
            requestedBy: session.user.email, 
            styleNos: styleNos 
          } 
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Failed (${res.status})`);
      }
      const result = await res.json().catch(() => ({}));
      alert(`Enqueued job for ${styleNos.length} styles (range ${start} to ${start + lim - 1})`);
    } catch (e: any) {
      alert(e?.message || 'Failed to enqueue job');
      console.error('[stock-scraper] enqueueWithLimit error', e);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Stock Scraper</h1>
      </div>

      <section className="rounded-md border p-4">
        <h2 className="mb-2 text-lg font-semibold">Current run</h2>
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <button onClick={enqueueAll} disabled={!!running} className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60">Scrape all</button>
          <button onClick={enqueueSelected} disabled={!!running} className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60">Scrape selected</button>
          <div className="flex items-center gap-2 border rounded-md px-3 py-1.5">
            <label className="text-sm text-gray-600 whitespace-nowrap">Scrape style:</label>
            <select
              value={singleStyle}
              onChange={(e) => setSingleStyle(e.target.value)}
              className="min-w-[220px] rounded border px-2 py-1 text-sm"
              disabled={!!running || !styleChoices}
            >
              <option value="">Select style…</option>
              {(styleChoices ?? []).map((s) => (
                <option key={s.id} value={s.style_no}>
                  {s.style_no}{s.style_name ? ` · ${s.style_name}` : ''}{s.supplier ? ` (${s.supplier})` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={enqueueSingleStyle}
              disabled={!!running || !singleStyle}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
            >
              Scrape style
            </button>
          </div>
          <div className="flex items-center gap-2 border rounded-md px-3 py-1.5">
            <label className="text-sm text-gray-600">Start from:</label>
            <input
              type="number"
              value={startFrom}
              onChange={(e) => setStartFrom(e.target.value)}
              min="0"
              className="w-20 rounded border px-2 py-1 text-sm"
              disabled={!!running}
            />
            <label className="text-sm text-gray-600">Limit:</label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              min="1"
              className="w-20 rounded border px-2 py-1 text-sm"
              disabled={!!running}
            />
            <button 
              onClick={enqueueWithLimit} 
              disabled={!!running} 
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
            >
              Scrape range
            </button>
          </div>
        </div>
        {running ? (
          <div className="space-y-2">
            <div className="text-sm text-gray-600">Job ID: <span className="font-mono">{running.id}</span></div>
            <div className="text-sm">Started: {running.started_at ? new Date(running.started_at).toLocaleString() : '—'} ({timeAgo(running.started_at)})</div>
            {progress ? (
              <div className="space-y-1">
                <div className="text-sm">
                  Progress: {progress.percent}% - <span className="font-semibold">{progress.index}/{progress.total}</span> styles completed
                  {progress.skippedInactive > 0 && <span className="text-xs text-gray-500 ml-2">({progress.skippedInactive} inactive skipped)</span>}
                </div>
                {progress.style_name && (
                  <div className="text-xs text-gray-600">Currently processing: {progress.style_name} ({progress.style_no})</div>
                )}
                <div className="h-2 w-full overflow-hidden rounded bg-gray-100">
                  <div className="h-2 bg-blue-600 transition-all duration-500" style={{ width: `${progress.percent}%` }} />
                </div>
                {progress.estimatedSecondsRemaining !== null && progress.estimatedSecondsRemaining > 0 && (
                  <div className="text-xs text-gray-600">
                    Estimated time remaining: {formatEstimatedTime(progress.estimatedSecondsRemaining)}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-gray-500">Waiting for progress…</div>
            )}
            {batches ? (
              <div className="text-xs text-gray-600">Batches running: {batches.running} (queued: {batches.queued}) — Batch {batches.currentIdx}/{batches.batchTotal}</div>
            ) : null}
            {related && (
              <div className="text-xs text-gray-600">
                Related jobs: {related.length}{' '}
                <button className="underline" onClick={()=>setShowRelated((v)=>!v)}>{showRelated ? 'Hide' : 'Show'}</button>
              </div>
            )}
            {showRelated && related && related.length > 0 && (
              <div className="max-h-40 overflow-auto rounded border bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="p-1 text-left border-b">ID</th>
                      <th className="p-1 text-left border-b">Status</th>
                      <th className="p-1 text-left border-b">Batch</th>
                      <th className="p-1 text-left border-b">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {related.map((j)=> (
                      <tr key={j.id}>
                        <td className="p-1 border-b font-mono">{j.id}</td>
                        <td className="p-1 border-b">{j.status}</td>
                        <td className="p-1 border-b">{(j.payload?.batchIndex ?? 1)} / {(j.payload?.batchTotal ?? '?')}</td>
                        <td className="p-1 border-b whitespace-nowrap">{new Date(j.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div>
              <button onClick={stopJob} className="rounded-md border border-red-600 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">Stop job</button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-500">No job running.</div>
        )}
      </section>

      <section className="rounded-md border p-4">
        <h2 className="mb-2 text-lg font-semibold">Latest completed run</h2>
        {latest ? (
          <LatestRun jobId={latest.id} finishedAt={latest.finished_at} />
        ) : (
          <div className="text-sm text-gray-500">No recent runs.</div>
        )}
      </section>

      {processed && processed.length > 0 && (
        <section className="rounded-md border p-4">
          <h2 className="mb-2 text-lg font-semibold">Processed in current run</h2>
          <div className="divide-y">
            {processed.map((p, i) => (
              <div key={i} className="flex items-center justify-between py-1 text-sm">
                <div>{p.style_name || p.style_no}</div>
                <div className="text-xs text-gray-600">{p.rows ?? 0} rows • {formatMs(p.ms)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-md border p-4">
        <h2 className="mb-2 text-lg font-semibold">Recent Update Style Stock runs</h2>
        {recent && recent.length > 0 ? (
          <div className="divide-y">
            {recent.map((j) => (
              <div key={j.id} className="py-2">
                <div className="flex items-center justify-between text-sm">
                  <div className="font-mono text-xs">{j.id}</div>
                  <div className="text-xs text-gray-600">{j.status}</div>
                </div>
                <div className="text-xs text-gray-600">Started: {j.started_at ? new Date(j.started_at).toLocaleString() : '—'}{j.finished_at ? ` • Duration: ${formatMs(new Date(j.finished_at).getTime() - new Date(j.started_at || j.created_at).getTime())}` : ''}</div>
                <JobStylesList jobId={j.id} />
                <JobChangesList jobId={j.id} />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-500">No runs yet.</div>
        )}
      </section>
    </div>
  );
}

function LatestRun({ jobId, finishedAt }: { jobId: string; finishedAt: string | null }) {
  const { data } = useSWR(`stock-scraper:latest-result:${jobId}`, async () => {
    const { data, error } = await supabase
      .from('job_results')
      .select('summary, data, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0] as any) ?? null;
  });
  const rows = Number((data?.data?.totalRows as any) || 0);
  return (
    <div className="space-y-1">
      <div className="text-sm">Finished: {finishedAt ? new Date(finishedAt).toLocaleString() : '—'}</div>
      <div className="text-sm">Rows upserted: {rows}</div>
      <div className="text-xs text-gray-500">Summary: {data?.summary || '—'}</div>
    </div>
  );
}

function JobStylesList({ jobId }: { jobId: string }) {
  const { data } = useSWR(`stock-scraper:styles:${jobId}`, async () => {
    const { data, error } = await supabase
      .from('job_logs')
      .select('msg, data, ts')
      .eq('job_id', jobId)
      .order('ts', { ascending: true })
      .limit(2000);
    if (error) throw new Error(error.message);
    const out: Array<{ style_no: string; style_name?: string | null }> = [];
    const seen = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      if (r.msg === 'STEP:style_stock_style_done' && r.data?.style_no) {
        const key = String(r.data.style_no);
        if (!seen.has(key)) { seen.add(key); out.push({ style_no: r.data.style_no, style_name: r.data.style_name ?? null }); }
      }
    }
    return out;
  }, { refreshInterval: 10000 });
  if (!data) return <div className="text-xs text-gray-500">Loading styles…</div>;
  if (data.length === 0) return <div className="text-xs text-gray-500">No styles parsed yet.</div>;
  return (
    <div className="mt-1">
      <div className="text-xs text-gray-600 mb-1">Touched styles: {data.length}</div>
      <div className="max-h-40 overflow-auto rounded border bg-white">
        <ul className="divide-y text-xs">
          {data.map((s, i) => (
            <li key={i} className="px-2 py-1">{s.style_no}{s.style_name ? ` · ${s.style_name}` : ''}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function JobChangesList({ jobId }: { jobId: string }) {
  const { data } = useSWR(`stock-scraper:changes:${jobId}`, async () => {
    const { data, error } = await supabase
      .from('job_logs')
      .select('msg, data, ts')
      .eq('job_id', jobId)
      .eq('msg', 'STEP:style_stock_changes')
      .order('ts', { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows: Array<{ style_no: string; style_name?: string | null; sample?: any[]; count?: number; ts: string }> = [];
    for (const r of (data ?? []) as any[]) {
      rows.push({ style_no: r.data?.style_no, style_name: r.data?.style_name ?? null, sample: r.data?.sample ?? [], count: r.data?.count ?? 0, ts: r.ts });
    }
    return rows;
  }, { refreshInterval: 10000 });
  if (!data || data.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-medium mb-1">Changes</div>
      <div className="max-h-60 overflow-auto rounded border bg-white">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-1 text-left border-b">Style</th>
              <th className="p-1 text-left border-b">Color</th>
              <th className="p-1 text-left border-b">Section</th>
              <th className="p-1 text-left border-b">Row</th>
              <th className="p-1 text-left border-b">Size</th>
              <th className="p-1 text-right border-b">From</th>
              <th className="p-1 text-right border-b">To</th>
            </tr>
          </thead>
          <tbody>
            {data.flatMap((d) => (d.sample || []).map((c, i) => (
              <tr key={`${d.style_no}-${i}`}>
                <td className="p-1 border-b whitespace-nowrap">{d.style_name || d.style_no}</td>
                <td className="p-1 border-b whitespace-nowrap">{c.color}</td>
                <td className="p-1 border-b whitespace-nowrap">{c.section}</td>
                <td className="p-1 border-b whitespace-nowrap">{c.row_label}</td>
                <td className="p-1 border-b whitespace-nowrap">{c.size}</td>
                <td className="p-1 border-b text-right">{c.from}</td>
                <td className="p-1 border-b text-right">{c.to}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


