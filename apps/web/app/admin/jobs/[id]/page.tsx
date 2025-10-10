'use client';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

export default function JobDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || '';
  const { data, error, isLoading } = useSWR(id ? ['job', id] : null, async () => {
    const { data: job, error: jobErr } = await supabase.from('jobs').select('*').eq('id', id).maybeSingle();
    if (jobErr) throw new Error(jobErr.message);
    const { data: logs, error: logsErr } = await supabase
      .from('job_logs')
      .select('*')
      .eq('job_id', id)
      .order('ts', { ascending: false })
      .limit(200);
    if (logsErr) throw new Error(logsErr.message);
    const { data: results } = await supabase
      .from('job_results')
      .select('*')
      .eq('job_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    return { job, logs: logs ?? [], result: results?.[0] ?? null };
  }, { refreshInterval: 4000 });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Job {id.slice(0,8)}…</h1>
      {isLoading && <div>Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String(error)}</div>}
      {data?.job && (
        <div className="border rounded p-3">
          <div className="text-sm">Status: <b>{data.job.status}</b></div>
          <div className="text-sm">Attempts: {data.job.attempts}/{data.job.max_attempts}</div>
          <div className="text-sm">Started: {data.job.started_at ? new Date(data.job.started_at).toLocaleString() : '—'}</div>
          <div className="text-sm">Finished: {data.job.finished_at ? new Date(data.job.finished_at).toLocaleString() : '—'}</div>
          {data.job.error && <div className="text-sm text-red-700">Error: {data.job.error}</div>}
          <div className="text-xs text-gray-500 break-all">Payload: {JSON.stringify(data.job.payload)}</div>
        </div>
      )}

      {data?.result && (
        <div className="border rounded p-3">
          <div className="font-semibold">Result</div>
          <div className="text-sm">Summary: {data.result.summary}</div>
          <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-auto">{JSON.stringify(data.result.data, null, 2)}</pre>
        </div>
      )}

      <div className="border rounded">
        <div className="px-3 py-2 font-semibold bg-gray-50">Logs</div>
        <div className="max-h-[50vh] overflow-auto p-2 text-xs">
          {(data?.logs ?? []).map((l: any) => (
            <div key={l.id} className="border-b py-1">
              <span className="text-gray-500">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className={"ml-2 px-1 rounded " + (l.level === 'error' ? 'bg-red-600 text-white' : 'bg-slate-800 text-white')}>{l.level}</span>
              <span className="ml-2">{l.msg}</span>
              {l.data && <pre className="mt-1 text-[10px] bg-gray-50 p-1 rounded overflow-auto">{JSON.stringify(l.data, null, 2)}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

'use client';
import useSWR from 'swr';
import { useParams } from 'next/navigation';
import type { JobRow, JobLogRow, JobResult } from '@shared/types';

const ORCH_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL!;

interface JobBundle {
  job: JobRow;
  logs: JobLogRow[];
  result: JobResult | null;
}

async function fetchJob(id: string): Promise<JobBundle> {
  const res = await fetch(`${ORCH_URL}/jobs/${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data, isLoading, error, mutate } = useSWR(id ? `job:${id}` : null, () => fetchJob(id), { refreshInterval: 4000 });

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p style={{ color: 'red' }}>{String(error)}</p>;
  if (!data) return null;

  const { job, logs, result } = data;

  return (
    <div>
      <h1>Job {job.id}</h1>
      <p>Status: {job.status}</p>
      <p>Attempts: {job.attempts}/{job.max_attempts}</p>
      <p>Started: {job.started_at ?? '-'}</p>
      <p>Finished: {job.finished_at ?? '-'}</p>
      <h3>Payload</h3>
      <pre style={{ background: '#f7f7f7', padding: 8, borderRadius: 8 }}>{JSON.stringify(job.payload, null, 2)}</pre>
      <h3>Logs</h3>
      <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
        {logs.map((l) => (
          <div key={l.id} style={{ fontFamily: 'monospace', fontSize: 12 }}>
            <strong>[{l.level}]</strong> {l.ts}: {l.msg} {l.data ? JSON.stringify(l.data) : ''}
          </div>
        ))}
      </div>
      <h3>Result</h3>
      <pre style={{ background: '#f7f7f7', padding: 8, borderRadius: 8 }}>{result ? JSON.stringify(result, null, 2) : 'No result yet'}</pre>
    </div>
  );
}

