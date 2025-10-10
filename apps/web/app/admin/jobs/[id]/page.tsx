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
