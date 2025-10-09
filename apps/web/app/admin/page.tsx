'use client';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../../lib/supabaseClient';
import type { JobRow } from '@shared/types';

const ORCH_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL!;

async function fetchJobs(): Promise<JobRow[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data as JobRow[];
}

async function enqueue(deep: boolean) {
  const {
    data: { session }
  } = await supabase.auth.getSession();
  if (!session) throw new Error('No session');
  const token = session.access_token;
  const res = await fetch(`${ORCH_URL}/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'scrape_statistics', payload: { toggles: { deep }, requestedBy: session.user.email } })
  });
  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return json.jobId as string;
}

function Status({ status }: { status: JobRow['status'] }) {
  const color = { queued: '#999', running: '#2980b9', succeeded: '#27ae60', failed: '#e74c3c', cancelled: '#7f8c8d' }[status];
  return <span style={{ padding: '2px 8px', borderRadius: 6, background: color, color: 'white', fontSize: 12 }}>{status}</span>;
}

export default function AdminPage() {
  const { data: jobs, mutate, isLoading, error } = useSWR('jobs', fetchJobs, { refreshInterval: 5000 });

  return (
    <div>
      <h1>Admin Dashboard</h1>
      <div style={{ margin: '16px 0', padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
        <strong>Run now</strong>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={async () => { const id = await enqueue(false); mutate(); location.assign(`/admin/jobs/${id}`); }}>Shallow</button>
          <button onClick={async () => { const id = await enqueue(true); mutate(); location.assign(`/admin/jobs/${id}`); }}>Deep</button>
          <button onClick={async () => {
            const {
              data: { session }
            } = await supabase.auth.getSession();
            if (!session) return alert('No session');
            const token = session.access_token;
            const res = await fetch(`${ORCH_URL}/enqueue`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ type: 'scrape_statistics', payload: { toggles: { dryRun: true }, requestedBy: session.user.email } })
            });
            if (!res.ok) return alert('Failed to enqueue dry-run');
            const json = await res.json();
            mutate();
            location.assign(`/admin/jobs/${json.jobId}`);
          }}>Test pipeline (dry-run)</button>
        </div>
      </div>

      {isLoading && <p>Loading…</p>}
      {error && <p style={{ color: 'red' }}>{String(error)}</p>}
      <table cellPadding={8} style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">ID</th>
            <th align="left">Status</th>
            <th align="left">Attempts</th>
            <th align="left">Duration</th>
          </tr>
        </thead>
        <tbody>
          {(jobs ?? []).map((j) => {
            const duration = j.started_at && j.finished_at ? (new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000 : null;
            return (
              <tr key={j.id} style={{ borderTop: '1px solid #eee' }}>
                <td><Link href={`/admin/jobs/${j.id}`}>{j.id.slice(0, 8)}…</Link></td>
                <td><Status status={j.status} /></td>
                <td>{j.attempts}/{j.max_attempts}</td>
                <td>{duration ? `${duration.toFixed(1)}s` : '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

