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

