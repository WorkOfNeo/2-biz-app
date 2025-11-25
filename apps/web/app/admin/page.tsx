/* eslint-disable @next/next/no-img-element */
'use client';
import useSWR from 'swr';
import { supabase } from '../../lib/supabaseClient';
import type { JobRow } from '@shared/types';

type ExportRow = { id: string; kind: string; title: string | null; public_url: string | null; path: string; job_id: string | null; created_at: string; meta: any };

async function fetchRunningJob(): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const list = (data as JobRow[]) || [];
  return list[0] || null;
}

async function fetchLastJob(type: JobRow['type']): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('type', type)
    .eq('status', 'succeeded')
    .order('finished_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const list = (data as JobRow[]) || [];
  return list[0] || null;
}

async function fetchStatsSummary(jobId: string): Promise<{ created: number; updated: number; when: string } | null> {
  const { data, error } = await supabase
    .from('job_results')
    .select('summary, data, created_at')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  const rows = (data as Array<{ summary: string; data: any; created_at: string }>) || [];
  const deep = rows.find(r => (r.summary || '').toLowerCase().includes('deep scrape'));
  const target = deep || rows[0];
  if (!target) return null;
  try {
    const per = ((target.data as any)?.perSalesperson as Array<{ created: number; updated: number }> | undefined) || [];
    const created = per.reduce((a, r) => a + (Number(r.created || 0) || 0), 0);
    const updated = per.reduce((a, r) => a + (Number(r.updated || 0) || 0), 0);
    return { created, updated, when: target.created_at };
  } catch {
    return null;
  }
}

async function fetchStockChanges(jobId: string): Promise<{ stylesChanged: number; when: string } | null> {
  const { data, error } = await supabase
    .from('style_stock_movements')
    .select('style_no, created_at')
    .eq('job_id', jobId);
  if (error) throw new Error(error.message);
  const rows = (data as Array<{ style_no: string; created_at: string }>) || [];
  const set = new Set(rows.map(r => r.style_no));
  const when = rows[0]?.created_at || '';
  return { stylesChanged: set.size, when };
}

async function fetchLatestExports(): Promise<ExportRow[]> {
  const { data, error } = await supabase
    .from('exports')
    .select('id, kind, title, public_url, path, job_id, created_at, meta')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data as any[]) as ExportRow[];
}

function Card({ title, children, right }: { title: string; children?: any; right?: any }) {
  return (
    <div className="border rounded-md p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        {right ? <div>{right}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: string | number | JSX.Element; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between py-1 border-b last:border-b-0">
      <div className="text-sm text-slate-600">{label}</div>
      <div className="text-sm font-medium">{value}</div>
      {sub ? <div className="ml-2 text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}

export default function AdminPage() {
  const { data: runningJob } = useSWR('admin-running-job', fetchRunningJob, { refreshInterval: 3000 });
  const { data: lastStatsJob } = useSWR('admin-last-stats', () => fetchLastJob('scrape_statistics'), { refreshInterval: 10000 });
  const { data: lastStockJob } = useSWR('admin-last-stock', () => fetchLastJob('update_style_stock'), { refreshInterval: 10000 });
  const statsJobId = lastStatsJob?.id || null;
  const stockJobId = lastStockJob?.id || null;
  const { data: statsSummary } = useSWR(statsJobId ? `stats-summary-${statsJobId}` : null, () => fetchStatsSummary(statsJobId!), { refreshInterval: 15000 });
  const { data: stockChanges } = useSWR(stockJobId ? `stock-changes-${stockJobId}` : null, () => fetchStockChanges(stockJobId!), { refreshInterval: 15000 });
  const { data: exportsList } = useSWR('admin-latest-exports', fetchLatestExports, { refreshInterval: 20000 });

  const latestByKind = (() => {
    const map = new Map<string, ExportRow>();
    for (const r of (exportsList || [])) {
      if (!map.has(r.kind)) map.set(r.kind, r);
    }
    return map;
  })();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="space-y-4">
        <Card title="Messages">
          <div className="text-sm text-slate-500">No messages.</div>
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Current Job Progress">
          {runningJob ? (
            <div className="text-sm space-y-1">
              <Row label="Type" value={String(runningJob.type).replace(/_/g, ' ')} />
              <Row label="Started" value={runningJob.started_at ? new Date(runningJob.started_at).toLocaleString() : '—'} />
              <Row label="Attempts" value={`${runningJob.attempts}/${runningJob.max_attempts}`} />
              <Row label="Status" value={<span className="px-2 py-0.5 rounded text-white" style={{ background: '#2980b9' }}>running</span>} />
            </div>
          ) : (
            <div className="text-sm text-slate-500">No job is currently running.</div>
          )}
        </Card>

        <Card title="Scrape Statistics">
          <div className="text-sm space-y-1">
            <Row label="Last run" value={lastStatsJob?.finished_at ? new Date(lastStatsJob.finished_at).toLocaleString() : '—'} />
            <Row label="Created" value={statsSummary ? statsSummary.created : '—'} />
            <Row label="Updated" value={statsSummary ? statsSummary.updated : '—'} />
          </div>
        </Card>

        <Card title="Scrape Stock">
          <div className="text-sm space-y-1">
            <Row label="Last run" value={lastStockJob?.finished_at ? new Date(lastStockJob.finished_at).toLocaleString() : '—'} />
            <Row label="Styles changed" value={stockChanges ? stockChanges.stylesChanged : '—'} />
          </div>
        </Card>

        <Card title="Exports">
          <div className="grid grid-cols-1 gap-2">
            {Array.from(latestByKind.values()).length === 0 ? (
              <div className="text-sm text-slate-500">No exports yet.</div>
            ) : null}
            {Array.from(latestByKind.entries()).map(([kind, row]) => {
              let url = row.public_url || '';
              if (kind === 'general_salesmen_pdfs') {
                const maybe = (row.meta?.all?.publicUrl || row.meta?.all?.public_url) as string | undefined;
                if (maybe) url = maybe;
              }
              const title = row.title || kind.replace(/_/g, ' ');
              return (
                <div key={row.id} className="flex items-center justify-between rounded border p-2">
                  <div className="text-sm">
                    <div className="font-medium">{title}</div>
                    <div className="text-xs text-slate-500">{new Date(row.created_at).toLocaleString()}</div>
                  </div>
                  {url ? (
                    <a className="text-sm px-3 py-1.5 rounded border hover:bg-slate-50" href={url} target="_blank" rel="noopener noreferrer">
                      Open PDF
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">No public URL</span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

