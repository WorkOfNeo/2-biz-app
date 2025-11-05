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
  const { data: progress } = useSWR(jobId ? `stock-scraper:progress:${jobId}` : null, async () => {
    const { data, error } = await supabase
      .from('job_logs')
      .select('msg, data, ts')
      .eq('job_id', jobId!)
      .order('ts', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ msg: string; data: any; ts: string }>;
    for (const r of rows) {
      if (r.msg === 'STEP:update_style_stock_progress') return r.data as { index: number; total: number; style_no?: string };
      if (r.msg === 'STEP:complete') return { index: 1, total: 1 };
    }
    return null;
  }, { refreshInterval: 1500 });

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

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Stock Scraper</h1>
      </div>

      <section className="rounded-md border p-4">
        <h2 className="mb-2 text-lg font-semibold">Current run</h2>
        {running ? (
          <div className="space-y-2">
            <div className="text-sm text-gray-600">Job ID: <span className="font-mono">{running.id}</span></div>
            <div className="text-sm">Started: {running.started_at ? new Date(running.started_at).toLocaleString() : '—'} ({timeAgo(running.started_at)})</div>
            {progress ? (
              <div className="space-y-1">
                <div className="text-sm">Progress: {progress.index}/{progress.total}{progress.style_no ? ` (style ${progress.style_no})` : ''}</div>
                <div className="h-2 w-full overflow-hidden rounded bg-gray-100">
                  <div className="h-2 bg-blue-600" style={{ width: `${Math.min(100, Math.floor((progress.index / Math.max(1, progress.total)) * 100))}%` }} />
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500">Waiting for progress…</div>
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


