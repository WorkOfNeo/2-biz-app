'use client';
import React from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';

type JobRow = { id: string; type: string; status: string; finished_at: string | null; started_at: string | null; created_at: string };
type JobResult = { job_id: string; summary?: string | null; data?: any; created_at: string };

async function fetchOverview() {
  // Fetch latest succeeded jobs (cap 200) then pick last per type
  const { data: jobs } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'succeeded')
    .order('finished_at', { ascending: false })
    .limit(200);
  const list = (jobs ?? []) as JobRow[];
  const byType = new Map<string, JobRow>();
  for (const j of list) {
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
    return { type, job: j, lastWhen: when, summary, metrics };
  }).sort((a, b) => (new Date(b.lastWhen || '').getTime()) - (new Date(a.lastWhen || '').getTime()));
  return { items };
}

export default function JobsOverviewPage() {
  const { data } = useSWR('jobs:overview', fetchOverview, { refreshInterval: 10000 });
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
              <div className="text-sm font-semibold">{it.type.replace(/_/g,' ').replace(/\b\w/g, (m: string) => m.toUpperCase())}</div>
              <div className="text-xs text-gray-600">{it.lastWhen ? new Date(it.lastWhen).toLocaleString() : '—'}</div>
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
            <div className="mt-3 text-xs">
              <Link href="/settings/runs" className="underline text-blue-700">View runs</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


