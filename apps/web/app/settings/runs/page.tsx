'use client';
import useSWR from 'swr';
import { useState } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';
import { ProgressBar } from '../../../components/ProgressBar';

const ORCH_URL = (process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '').replace(/\/$/, '');

async function fetchLatest() {
  const { data: jobs } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  const jobIds = (jobs ?? []).map((j: any) => j.id);
  let logsByJob: Record<string, string[]> = {};
  if (jobIds.length > 0) {
    const { data: logs } = await supabase
      .from('job_logs')
      .select('job_id,msg,ts')
      .in('job_id', jobIds)
      .order('ts', { ascending: true });
    for (const l of (logs ?? []) as any[]) {
      const id = l.job_id as string;
      (logsByJob[id] ||= []).push(l.msg as string);
    }
  }
  const { data: cleanupLogs } = await supabase
    .from('job_logs')
    .select('*')
    .ilike('msg', '%cleanup%')
    .order('ts', { ascending: false })
    .limit(1);
  // Group by type and get last finished per type
  const types = Array.from(new Set((jobs ?? []).map((j: any) => j.type))).sort();
  const lastByType: Record<string, string | null> = {};
  for (const t of types) {
    const row = (jobs ?? []).find((j: any) => j.type === t && j.finished_at);
    lastByType[t] = row?.finished_at ?? null;
  }
  return { jobs: jobs ?? [], lastCleanup: cleanupLogs?.[0]?.ts ?? null, logsByJob, lastByType };
}

async function enqueueTestRun(dryRun: boolean) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const token = session.access_token;
  const res = await fetch(`${ORCH_URL}/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'scrape_statistics', payload: { toggles: { deep: !dryRun, dryRun }, requestedBy: session.user.email } })
  });
  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return json.jobId as string;
}

export default function RunsSettingsPage() {
  const { data, mutate } = useSWR('runs:latest', fetchLatest, { refreshInterval: 3000 });
  const [enqueuing, setEnqueuing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);

  async function onTestRun() {
    try {
      setEnqueuing(true);
      setProgress(10);
      const id = await enqueueTestRun(false);
      setJobId(id);
      setProgress(30);
      await mutate();
      setProgress(60);
      // Let SWR refresh show progress/logs
      setTimeout(() => setProgress(100), 1500);
    } finally {
      setEnqueuing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Runs</h2>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            disabled={enqueuing}
            onClick={onTestRun}
          >Run test scrape</button>
        </div>
      </div>

      <div className="rounded-md border p-4">
        <div className="text-sm text-gray-600">Last cleanup: {data?.lastCleanup ? new Date(data.lastCleanup).toLocaleString() : '—'}</div>
        {enqueuing && <div className="mt-2"><ProgressBar value={progress} /></div>}
      </div>

      {/* Active job section */}
      {(() => {
        const active = (data?.jobs ?? []).filter((j: any) => j.status === 'running' || (!j.finished_at && j.started_at)).sort((a: any,b: any) => (new Date(b.started_at||b.created_at).getTime()) - (new Date(a.started_at||a.created_at).getTime()));
        if (!active.length) return null;
        const j = active[0];
        const msgs = data?.logsByJob?.[j.id] ?? [];
        const stepMap: Record<string, number> = {
          'STEP:styles_begin': 10,
          'STEP:style_stock_begin': 15,
          'STEP:style_stock_rows': 70,
          'STEP:begin_deep': 20,
          'STEP:topseller_ready': 40,
          'STEP:salespersons_total': 50,
          'STEP:salesperson_start': 55,
          'STEP:salesperson_done': 85,
          'STEP:complete': 100
        };
        let pct = 0;
        for (const m of msgs) { if (stepMap[m] !== undefined) pct = Math.max(pct, stepMap[m]); }
        return (
          <div className="rounded-md border">
            <div className="px-3 py-2 border-b flex items-center justify-between bg-gray-50">
              <div className="text-sm font-semibold">Active Job</div>
              <div className="text-xs text-gray-600">Started: {j.started_at ? new Date(j.started_at).toLocaleString() : new Date(j.created_at).toLocaleString()}</div>
            </div>
            <div className="p-3 space-y-2">
              <div className="text-sm"><b>Type:</b> {j.type}</div>
              <div className="text-sm"><b>Status:</b> {j.status} ({j.attempts}/{j.max_attempts})</div>
              <div className="max-w-sm"><ProgressBar value={pct} /></div>
              <div className="text-xs text-gray-600">
                <div className="font-medium mb-1">Recent steps</div>
                <ul className="list-disc pl-5 space-y-0.5">
                  {msgs.slice(-8).map((m, i) => (<li key={i}>{m}</li>))}
                </ul>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Sections per job type */}
      {Array.from(new Set((data?.jobs ?? []).map((j: any) => j.type))).sort().map((type) => (
        <div key={type} className="overflow-auto border rounded-md">
          <div className="px-3 py-2 border-b flex items-center justify-between bg-gray-50">
            <div className="text-sm font-semibold">{type.replace(/_/g,' ').replace(/\b\w/g, (m: string) => m.toUpperCase())}</div>
            <div className="text-xs text-gray-600">Last run: {data?.lastByType?.[type] ? new Date(data.lastByType[type] as string).toLocaleString() : '—'}</div>
          </div>
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">ID</th>
                <th className="text-left p-2 border-b">Status</th>
                <th className="text-left p-2 border-b">Attempts</th>
                <th className="text-left p-2 border-b">Started</th>
                <th className="text-left p-2 border-b">Finished</th>
                <th className="text-left p-2 border-b">Progress</th>
                <th className="text-left p-2 border-b">Result</th>
              </tr>
            </thead>
            <tbody>
              {(data?.jobs ?? []).filter((j: any) => j.type === type).slice(0, 20).map((j: any) => {
              const msgs = data?.logsByJob?.[j.id] ?? [];
              const stepMap: Record<string, number> = {
                'STEP:begin_deep': 20,
                'STEP:topseller_ready': 40,
                'STEP:salespersons_total': 50,
                'STEP:salesperson_start': 55,
                'STEP:salesperson_done': 85,
                'STEP:complete': 100
              };
              let pct = 0;
              for (const m of msgs) {
                if (stepMap[m] !== undefined) pct = Math.max(pct, stepMap[m]);
              }
              if (j.status === 'succeeded') pct = 100;
              return (
                <tr key={j.id}>
                  <td className="p-2 border-b"><Link href={`/admin/jobs/${j.id}`}>{j.id.slice(0,8)}…</Link></td>
                  <td className="p-2 border-b">{j.status}</td>
                  <td className="p-2 border-b">{j.attempts}/{j.max_attempts}</td>
                  <td className="p-2 border-b">{j.started_at ? new Date(j.started_at).toLocaleString() : '—'}</td>
                  <td className="p-2 border-b">{j.finished_at ? new Date(j.finished_at).toLocaleString() : '—'}</td>
                  <td className="p-2 border-b" style={{minWidth:180}}>{j.status === 'running' || pct > 0 ? <ProgressBar value={pct} /> : '—'}</td>
                  <td className="p-2 border-b">{j.status === 'succeeded' ? <span className="text-green-700">OK</span> : (j.error ? <span className="text-red-700">{j.error}</span> : '—')}</td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {jobId && <div className="text-xs text-gray-500">Last enqueued job: {jobId}</div>}
    </div>
  );
}

