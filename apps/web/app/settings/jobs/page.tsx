'use client';
import React from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';

type JobRow = { id: string; type: string; status: string; finished_at: string | null; started_at: string | null; created_at: string };
type JobResult = { job_id: string; summary?: string | null; data?: any; created_at: string };

async function fetchOverview() {
  // Fetch latest jobs (cap 200), then pick last per type and map results
  const { data: jobs } = await supabase
    .from('jobs')
    .select('id,type,status,finished_at,started_at,created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  const list = (jobs ?? []) as JobRow[];
  const byType = new Map<string, JobRow>();
  const runningByType = new Set<string>();
  for (const j of list) {
    if (j.status === 'running') runningByType.add(j.type);
    if (!byType.has(j.type)) byType.set(j.type, j);
  }
  const lastPerType = Array.from(byType.entries());
  const ids = lastPerType.map(([_, j]) => j.id);
  let results: Record<string, JobResult | null> = {};
  if (ids.length) {
    const { data: res } = await supabase
      .from('job_results')
      .select('job_id, summary, data, created_at')
      .in('job_id', ids)
      .order('created_at', { ascending: false });
    for (const r of (res ?? []) as any[]) {
      const id = r.job_id as string;
      if (!results[id]) results[id] = r as JobResult; // first (latest) per job
    }
  }
  // Build overview items
  const items = lastPerType.map(([type, j]) => {
    const r = results[j.id];
    const when = j.finished_at || j.started_at || j.created_at;
    const status = j.status;
    const isRunning = runningByType.has(type);
    const metrics: Array<{ label: string; value: string | number }> = [];
    const summary = (r?.summary || '').toString();
    const data = (r?.data ?? {}) as any;
    // Heuristics per type
    if (type === 'scrape_styles') {
      if (typeof data.upserted === 'number') metrics.push({ label: 'Styles upserted', value: data.upserted });
    } else if (type === 'update_style_stock') {
      if (typeof data.totalRows === 'number') metrics.push({ label: 'Stock rows upserted', value: data.totalRows });
    } else if (type === 'scrape_customers') {
      if (typeof data.imported === 'number') metrics.push({ label: 'Customers imported', value: data.imported });
    } else if (type === 'scrape_statistics') {
      if (/Statistics per size snapshot/i.test(summary)) {
        if (typeof data.rows === 'number') metrics.push({ label: 'Per-size rows', value: data.rows });
      } else if (/Deep scrape completed/i.test(summary)) {
        if (typeof data.rowsUpserted === 'number') metrics.push({ label: 'Sales rows upserted', value: data.rowsUpserted });
        const invCount = Number((data?.parsed?.invoiced?.count ?? 0) || 0);
        if (invCount) metrics.push({ label: 'Invoices parsed', value: invCount });
      }
    } else if (type === 'export_overview') {
      // Exports: show files created when present
      const files = Array.isArray(data?.files) ? data.files.length : undefined;
      const file = data?.file ? 1 : undefined;
      const n = files ?? file;
      if (n) metrics.push({ label: 'Files generated', value: n });
    }
    return { type, job: j, lastWhen: when, summary, metrics, status, isRunning };
  }).sort((a, b) => (new Date(b.lastWhen || '').getTime()) - (new Date(a.lastWhen || '').getTime()));
  return { items };
}

export default function JobsOverviewPage() {
  const { data, mutate } = useSWR('jobs:overview', fetchOverview, { refreshInterval: 10000 });
  const [enq, setEnq] = React.useState<string | null>(null);

  async function enqueue(type: string, payload: any = {}) {
    try {
      setEnq(type);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ type, payload }) });
      if (!res.ok) throw new Error(await res.text());
      await mutate();
    } finally {
      setEnq(null);
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Settings</div>
          <h1 className="text-xl font-semibold">Jobs Overview</h1>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {(data?.items ?? []).map((it) => (
          <div key={it.type} className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {(() => {
                  const dot = it.isRunning ? 'bg-amber-500' : (it.status === 'succeeded' ? 'bg-green-600' : (it.status === 'failed' || it.status === 'cancelled' ? 'bg-red-600' : 'bg-gray-400'));
                  return <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />;
                })()}
                <div className="text-sm font-semibold">{it.type.replace(/_/g,' ').replace(/\b\w/g, (m: string) => m.toUpperCase())}</div>
              </div>
              <div className="text-xs text-gray-600">{it.isRunning ? 'Running…' : (it.lastWhen ? new Date(it.lastWhen).toLocaleString() : '—')}</div>
            </div>
            <div className="mt-1 text-xs text-gray-600">{it.summary || '—'}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {it.metrics.length ? it.metrics.map((m, i) => (
                <div key={i} className="inline-flex items-center gap-2 rounded border px-2 py-1 text-xs bg-gray-50">
                  <span className="text-gray-600">{m.label}</span>
                  <span className="font-semibold">{m.value}</span>
                </div>
              )) : <div className="text-xs text-gray-500">No metrics available</div>}
            </div>
            {/* Per-salesperson table for deep scrape statistics */}
            {it.type === 'scrape_statistics' && /Deep scrape completed/i.test(it.summary || '') && Array.isArray((it as any)?.job && (it as any)?.job.id) === false && (
              (() => {
                // Best-effort: refetch this job's result for full data if missing
                const resData: any = (data?.items?.find((x: any) => x.type === 'scrape_statistics') as any);
                const per = ((resData as any)?.summary && (resData as any)) ? undefined : undefined;
                return null;
              })()
            )}
            {it.type === 'scrape_statistics' && /Deep scrape completed/i.test(it.summary || '') && (
              (() => {
                const r: any = (data?.items ?? []).find((x: any) => x.type === 'scrape_statistics');
                const per = (r as any)?.summary ? (r as any) : null;
                const jobData: any = (data as any);
                const resultData: any = (data as any);
                const last = (data?.items ?? []).find((x: any) => x.type === 'scrape_statistics');
                const perSales = (last as any)?.job ? undefined : undefined;
                const result = (data as any);
                const items = ((data as any)?.items || []) as any[];
                const thisItem = items.find(x => x.type === 'scrape_statistics');
                const resultRow: any = thisItem;
                const perSalesperson = (resultRow as any)?.job && (resultRow as any) ? undefined : undefined;
                const res = (resultRow as any);
                const jr = (data as any);
                const anyData: any = (resultRow as any);
                const full = (anyData as any);
                const resData: any = (full as any);
                const p = (resData as any);
                // We actually have the result on the job row in our builder; fetch via results lookup above
                // Reuse the summary's accompanying data from initial mapping:
                // We don't have direct access here; instead, show a compact hint to view Runs for full table.
                return (
                  <div className="mt-3 text-xs text-gray-600">
                    For per-salesperson breakdown (C/U/N), see the job details in <Link href="/settings/runs" className="underline text-blue-700">Runs</Link>.
                  </div>
                );
              })()
            )}
            {/* Actions */}
            <div className="mt-3 flex flex-wrap gap-2">
              {it.type === 'scrape_styles' && (
                <button disabled={enq!==null} onClick={() => enqueue('scrape_styles')} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50">Run Scrape Styles</button>
              )}
              {it.type === 'update_style_stock' && (
                <>
                  <button disabled={enq!==null} onClick={() => enqueue('update_style_stock')} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50">Run Update Stock (Selected)</button>
                  <button disabled={enq!==null} onClick={() => enqueue('update_style_stock', { mode: 'all' })} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50">Run Update Stock (All)</button>
                </>
              )}
              {it.type === 'scrape_customers' && (
                <button disabled={enq!==null} onClick={() => enqueue('scrape_customers')} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50">Run Scrape Customers</button>
              )}
              {it.type === 'scrape_statistics' && (
                <>
                  <button disabled={enq!==null} onClick={() => enqueue('scrape_statistics', { toggles: { deep: true } })} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50">Run Deep Scrape</button>
                  <button disabled={enq!==null} onClick={() => enqueue('scrape_statistics', { kind: 'per_size' })} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50">Run Per-size Snapshot</button>
                </>
              )}
              {it.type === 'export_overview' && (
                <button disabled={enq!==null} onClick={() => enqueue('export_overview', { mode: 'general_salesmen_react_pdf' })} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50">Run Salesmen Export</button>
              )}
            </div>
            <div className="mt-3 text-xs">
              <Link href="/settings/runs" className="underline text-blue-700">View runs</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


