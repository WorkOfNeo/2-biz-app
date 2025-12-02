'use client';
import React from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../../../lib/supabaseClient';

type JobRow = { id: string; type: string; status: string; finished_at: string | null; started_at: string | null; created_at: string };
type JobResult = { job_id: string; summary?: string | null; data?: any; created_at: string };

const JOB_DESCRIPTIONS: Record<string, string> = {
  scrape_styles:
    'Scrape Styles: Crawls SPY styles to discover and update styles (number, name, links) and pre-seeds color headers for later stock control.',
  deep_scrape_styles:
    'Deep Scrape Styles: Visits each style Materials tab, reads season selects and color boxes, then maps which colors belong to which seasons. Automatically inserts/deletes style_color_seasons links to keep them in sync with SPY.',
  update_style_stock:
    'Update Style Stock: Visits selected styles Stat & Stock tab, respects style/color scrape toggles and inactive flags, parses Stock/Sold/Purchase/Dedicated, bulk-upserts rows and runs in fan-out batches.',
  scrape_customers:
    'Scrape Customers: Imports customers from SPY (company, city, country, salesperson). Updates optional fields like phone, priority and links when available.',
  scrape_statistics:
    'Scrape Statistics: Deep mode processes per-salesperson totals and invoices for a season; Per-size snapshot captures size-level statistics used in dashboards.',
  export_overview:
    'Export Overview: Generates React-PDF exports (General per salesperson and combined ZIP), uploads to Supabase Storage and records entries in exports.',
  scrape_top_styles:
    'Scrape Top 10 Styles: Collects top-performing styles (and optionally color variants) and stores results for Top 10 dashboards.',
  export_top_styles:
    'Export Top 10 Styles: Builds PDF exports for Top styles based on stored results and uploads them to Storage.',
  scrape_eans:
    'Scrape EANs: Visits each style EAN tab (#tab=ean), parses Color/Size/EAN, maps to style_colors, flushes and reimports the EAN table.',
  fix_invoices:
    'Fix Invoices: Reconciles season_id on invoices by matching invoice_date to season date ranges. Supports dry run and apply.'
};

function Truncated({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  const max = 140;
  const needs = text.length > max;
  const shown = expanded || !needs ? text : text.slice(0, max) + '…';
  return (
    <div className="mt-1 text-[12px] text-gray-600">
      <span>{shown}</span>
      {needs && (
        <button className="ml-1 underline text-blue-700" onClick={onToggle}>
          {expanded ? 'View less' : 'View more'}
        </button>
      )}
    </div>
  );
}

// Component for displaying unified progress across multiple batch jobs
function UnifiedBatchProgress({ jobs }: { jobs: Array<{ id: string; type: string; started_at: string; payload: any }> }) {
  // Fetch latest logs for all batch jobs
  const jobIds = jobs.map(j => j.id);
  const { data: allLogs } = useSWR(
    ['batch:logs', jobIds.join(',')],
    async () => {
      if (jobIds.length === 0) return [];
      const { data, error } = await supabase
        .from('job_logs')
        .select('job_id, msg, data, ts')
        .in('job_id', jobIds)
        .order('ts', { ascending: false })
        .limit(jobIds.length * 2); // Get latest 2 logs per job
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ job_id: string; msg: string; data: any; ts: string }>;
    },
    { refreshInterval: 1000 }
  );

  // Get the most recent progress log for each job
  const progressByJob = new Map<string, any>();
  for (const log of (allLogs ?? [])) {
    if (!progressByJob.has(log.job_id) && log.msg?.includes('progress')) {
      progressByJob.set(log.job_id, log.data || {});
    }
  }

  // Aggregate progress across all batches
  let totalIndex = 0;
  let totalTotal = 0;
  let oldestStartTime = jobs[0]?.started_at;
  
  for (const job of jobs) {
    const progress = progressByJob.get(job.id) || {};
    totalIndex += Number(progress.index || 0);
    totalTotal += Number(progress.total || 0);
    if (job.started_at < oldestStartTime) oldestStartTime = job.started_at;
  }

  const percent = totalTotal > 0 ? Math.round((totalIndex / totalTotal) * 100) : 0;
  
  // Calculate ETA
  const elapsedMs = Date.now() - new Date(oldestStartTime).getTime();
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const remainingItems = totalTotal - totalIndex;
  const itemsPerMin = totalIndex > 0 ? totalIndex / (elapsedMs / 60000) : 0;
  const etaMin = itemsPerMin > 0 ? Math.ceil(remainingItems / itemsPerMin) : 0;

  const mainJob = jobs[0];
  const batchCount = jobs.length;

  return (
    <div className="rounded-lg border bg-blue-50 border-blue-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 bg-blue-600 rounded-full animate-pulse" />
          <span className="text-sm font-semibold text-blue-900">
            {JOB_DESCRIPTIONS[mainJob.type]?.split(':')[0] || mainJob.type} - Running
          </span>
          {batchCount > 1 && (
            <span className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded">
              {batchCount} batches
            </span>
          )}
        </div>
        <span className="text-xs text-blue-700">
          Started {new Date(oldestStartTime).toLocaleTimeString()}
        </span>
      </div>
      <div className="text-sm text-blue-800 mb-3">
        {totalIndex}/{totalTotal} styles ({percent}%)
        {etaMin > 0 && (
          <span className="ml-2 text-blue-600">
            • ETA: {etaMin < 60 ? `${etaMin}m` : `${Math.floor(etaMin / 60)}h ${etaMin % 60}m`}
          </span>
        )}
        {elapsedMin > 0 && (
          <span className="ml-2 text-xs text-blue-500">
            (Elapsed: {elapsedMin}m)
          </span>
        )}
      </div>
      <div className="relative h-2 bg-blue-200 rounded-full overflow-hidden">
        <div 
          className="absolute inset-0 bg-blue-600 transition-all duration-500 ease-out" 
          style={{ width: `${percent}%` }} 
        />
        <div 
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-30"
          style={{ 
            animation: 'shimmer 2s infinite',
            backgroundSize: '200% 100%'
          }}
        />
      </div>
    </div>
  );
}

// Component for displaying a single running job's progress
function RunningJobProgress({ job }: { job: { id: string; type: string; started_at: string } }) {
  // Fetch latest log for this specific job
  const { data: latestLog } = useSWR(
    ['job:log', job.id],
    async () => {
      const { data, error } = await supabase
        .from('job_logs')
        .select('msg, data, ts')
        .eq('job_id', job.id)
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as { msg: string; data: any; ts: string } | null;
    },
    { refreshInterval: 1000 }
  );

  return (
    <div className="rounded-lg border bg-blue-50 border-blue-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 bg-blue-600 rounded-full animate-pulse" />
          <span className="text-sm font-semibold text-blue-900">
            {JOB_DESCRIPTIONS[job.type]?.split(':')[0] || job.type} - Running
          </span>
        </div>
        <span className="text-xs text-blue-700">
          {latestLog?.data?.percent ? `${latestLog.data.percent}% - ` : ''}
          {latestLog?.data?.index && latestLog?.data?.total 
            ? `${latestLog.data.index}/${latestLog.data.total} - ` 
            : ''}
          Started {new Date(job.started_at).toLocaleTimeString()}
        </span>
      </div>
      {latestLog && (
        <div className="text-sm text-blue-800 mb-3">
          {latestLog.msg || 'Processing...'}
          {latestLog.data && typeof latestLog.data === 'object' && Object.keys(latestLog.data).length > 0 && (
            <span className="ml-2 text-xs text-blue-600">
              {Object.entries(latestLog.data)
                .filter(([k]) => !['index', 'total', 'percent'].includes(k))
                .slice(0, 3)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ')}
            </span>
          )}
        </div>
      )}
      <div className="relative h-2 bg-blue-200 rounded-full overflow-hidden">
        <div 
          className="absolute inset-0 bg-blue-600 transition-all duration-500 ease-out" 
          style={{ width: `${Math.min(100, Math.max(0, latestLog?.data?.percent ?? 0))}%` }} 
        />
        <div 
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-30"
          style={{ 
            animation: 'shimmer 2s infinite',
            backgroundSize: '200% 100%'
          }}
        />
      </div>
    </div>
  );
}

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
    } else if (type === 'deep_scrape_styles') {
      if (typeof data.updated === 'number') metrics.push({ label: 'Styles processed', value: data.updated });
      if (typeof data.colorLinksInserted === 'number') metrics.push({ label: 'Season-color links added', value: data.colorLinksInserted });
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
  const [expandDesc, setExpandDesc] = React.useState<Record<string, boolean>>({});
  const [seqRunning, setSeqRunning] = React.useState(false);

  // Fetch currently running jobs (support multiple workers)
  const { data: runningJobs } = useSWR('jobs:running', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, type, status, started_at, payload')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(20); // Support up to 20 concurrent workers/batches
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; type: string; status: string; started_at: string; payload: any }>;
  }, { refreshInterval: 2000 });

  async function createJob(body: any) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in');
    const token = session.access_token;
    const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const js = await res.json();
    return js.jobId as string;
  }
  async function waitForJob(jobId: string) {
    // Poll jobs table until done (up to ~3 minutes)
    for (let i = 0; i < 120; i++) {
      try {
        const { data } = await supabase.from('jobs').select('status').eq('id', jobId).maybeSingle();
        const st = (data as any)?.status as string | undefined;
        if (st === 'succeeded' || st === 'failed' || st === 'cancelled') return st;
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
    return 'timeout';
  }
  async function runAllExportsSequential() {
    if (seqRunning) return;
    try {
      setSeqRunning(true);
      // 1) General per salesperson (React PDF)
      let id = await createJob({ type: 'export_overview', payload: { mode: 'general_salesmen_react_pdf' } });
      await waitForJob(id);
      // 2) Overview PDF
      id = await createJob({ type: 'export_overview', payload: { mode: 'overview_react_pdf' } });
      await waitForJob(id);
      // 3) Countries PDF
      id = await createJob({ type: 'export_overview', payload: { mode: 'countries_react_pdf' } });
      await waitForJob(id);
      // 4) Top 10 Styles PDF
      id = await createJob({ type: 'export_top_styles', payload: {} });
      await waitForJob(id);
    } finally {
      setSeqRunning(false);
    }
  }

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

      {/* Running Jobs Progress Bars - Grouped by rootId for batch jobs */}
      {runningJobs && runningJobs.length > 0 && (() => {
        // Group jobs by rootId (for batch operations) or show individually
        const groupedJobs = new Map<string, typeof runningJobs>();
        const standaloneJobs: typeof runningJobs = [];
        
        for (const job of runningJobs) {
          const rootId = job.payload?.rootId as string | undefined;
          if (rootId) {
            // This is part of a batch operation
            const existing = groupedJobs.get(rootId) || [];
            existing.push(job);
            groupedJobs.set(rootId, existing);
          } else {
            // Standalone job
            standaloneJobs.push(job);
          }
        }

        const totalGroups = groupedJobs.size + standaloneJobs.length;
        
        return (
          <div className="space-y-3">
            <div className="text-sm font-semibold text-gray-700">
              Running Jobs ({totalGroups})
            </div>
            {/* Display grouped batch jobs */}
            {Array.from(groupedJobs.values()).map((batchJobs) => (
              <UnifiedBatchProgress key={batchJobs[0].id} jobs={batchJobs} />
            ))}
            {/* Display standalone jobs */}
            {standaloneJobs.map((job) => (
              <RunningJobProgress key={job.id} job={job} />
            ))}
          </div>
        );
      })()}

      {/* Jobs list divided into Scrapes and Exports */}
      <div className="rounded-md border bg-white">
        <div className="p-3 text-sm font-semibold">Jobs</div>
        <div className="border-t">
          {[
            {
              title: 'Scrapes',
              items: [
                { type: 'scrape_styles', label: 'Scrape Styles', actions: [{ label: 'Run', payload: {} }] },
                { type: 'deep_scrape_styles', label: 'Deep Scrape Styles (Seasons)', actions: [{ label: 'Run', payload: {} }] },
                { type: 'update_style_stock', label: 'Update Style Stock', actions: [{ label: 'Run (Selected)', payload: {} }, { label: 'Run (All)', payload: { mode: 'all' } }] },
                { type: 'scrape_customers', label: 'Scrape Customers', actions: [{ label: 'Run', payload: {} }] },
                { type: 'scrape_statistics', label: 'Scrape Statistics', actions: [{ label: 'Run Deep', payload: { toggles: { deep: true } } }, { label: 'Per-size Snapshot', payload: { kind: 'per_size' } }] },
                { type: 'scrape_top_styles', label: 'Scrape Top 10 Styles', actions: [{ label: 'Run', payload: {} }] },
                { type: 'scrape_eans', label: 'Scrape EANs', actions: [{ label: 'Run', payload: {} }] },
                { type: 'fix_invoices', label: 'Fix Invoices', actions: [{ label: 'Dry run', payload: { dryRun: true } }, { label: 'Apply', payload: { dryRun: false } }] }
              ]
            },
            {
              title: 'Exports',
              items: [
                { type: 'export_overview', label: 'Export General per Salesperson', actions: [{ label: 'Run', payload: { mode: 'general_salesmen_react_pdf' } }] },
                { type: 'export_overview', label: 'Export Overview', actions: [{ label: 'Run', payload: { mode: 'overview_react_pdf' } }] },
                { type: 'export_overview', label: 'Export Countries', actions: [{ label: 'Run', payload: { mode: 'countries_react_pdf' } }] },
                { type: 'export_top_styles', label: 'Export Top 10 Styles', actions: [{ label: 'Run', payload: {} }] },
                { type: 'export_all', label: 'Export All', actions: [{ label: 'Run', payload: {} }] }
              ]
            }
          ].map((section) => (
            <div key={section.title} className="border-t first:border-t-0">
              <div className="px-3 py-2 text-xs font-semibold text-gray-600 bg-gray-50">{section.title}</div>
              <ul className="divide-y">
                {section.items.map((f) => (
                  <li key={f.type} className="px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{f.label}</div>
                        {JOB_DESCRIPTIONS[f.type] && (
                          <Truncated
                            text={JOB_DESCRIPTIONS[f.type] ?? ''}
                            expanded={!!expandDesc[f.type]}
                            onToggle={() => setExpandDesc((m) => ({ ...m, [f.type]: !m[f.type] }))}
                          />
                        )}
                        <div className="mt-1 text-[11px] text-gray-500 font-mono">{f.type}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {f.type === 'export_all' ? (
                          <button
                            disabled={seqRunning}
                            onClick={runAllExportsSequential}
                            className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                          >Run</button>
                        ) : (
                          f.actions.map((a, i) => (
                            <button
                              key={i}
                              disabled={enq!==null}
                              onClick={() => enqueue(f.type, a.payload || {})}
                              className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                            >{a.label}</button>
                          ))
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="p-3 text-xs">
          <Link href="/settings/runs" className="underline text-blue-700">View runs</Link>
        </div>
      </div>
    </div>
  );
}


