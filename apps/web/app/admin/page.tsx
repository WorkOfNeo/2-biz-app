'use client';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../../lib/supabaseClient';
import type { JobRow } from '@shared/types';
import { useState } from 'react';

const ORCH_URL = (process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '').replace(/\/$/, '');

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
  const { data: seasons } = useSWR('seasons-simple', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1>Admin Dashboard</h1>
        <div className="relative flex items-center gap-2">
          <Link className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50" href="/admin/users">Users</Link>
          <Link className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50" href="/admin/roles">Roles</Link>
          <details className="cursor-pointer">
            <summary className="list-none inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm">☰ Menu</summary>
            <div className="absolute right-0 mt-2 w-56 bg-white border rounded-md shadow">
              <Link className="block px-3 py-2 hover:bg-gray-50" href="/settings/customers/import">Import Statistic</Link>
            </div>
          </details>
        </div>
      </div>
      {/* Job controls removed per request */}

      <div className="border rounded-md p-4 mt-4">
        <div className="flex items-end gap-3">
          <div>
            <label className="text-sm">Season 1</label>
            <select className="mt-1 border rounded p-1 text-sm" value={s1} onChange={(e) => setS1(e.target.value)}>
              <option value="">—</option>
              {(seasons ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm">Season 2</label>
            <select className="mt-1 border rounded p-1 text-sm" value={s2} onChange={(e) => setS2(e.target.value)}>
              <option value="">—</option>
              {(seasons ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-4 overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead>
              <tr>
                <th className="text-left p-2 border-b">Customer</th>
                <th className="text-left p-2 border-b">City</th>
                <th className="text-left p-2 border-b">Season 1</th>
                <th className="text-left p-2 border-b">Season 2</th>
                <th className="text-left p-2 border-b">Development</th>
                <th className="text-left p-2 border-b">Actions</th>
              </tr>
              <tr className="bg-gray-50">
                <th className="text-left p-2 border-b"></th>
                <th className="text-left p-2 border-b"></th>
                <th className="text-left p-2 border-b">Qty · Price</th>
                <th className="text-left p-2 border-b">Qty · Price</th>
                <th className="text-left p-2 border-b">Qty · Price</th>
                <th className="text-left p-2 border-b">—</th>
              </tr>
            </thead>
            <tbody>
              {/* Placeholder rows; later populate by joining season_statistics */}
              <tr>
                <td className="p-2 border-b">—</td>
                <td className="p-2 border-b">—</td>
                <td className="p-2 border-b">0 · 0</td>
                <td className="p-2 border-b">0 · 0</td>
                <td className="p-2 border-b">0 · 0</td>
                <td className="p-2 border-b">—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {isLoading && <p>Loading…</p>}
      {error && <p style={{ color: 'red' }}>{String(error)}</p>}
      <table cellPadding={8} style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">ID</th>
            <th align="left">Type</th>
            <th align="left">Status</th>
            <th align="left">Attempts</th>
            <th align="left">Duration</th>
          </tr>
        </thead>
        <tbody>
          {(jobs ?? []).map((j) => {
            const duration = j.started_at && j.finished_at ? (new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000 : null;
            const label = (() => {
              const t = (j.type || '').toString();
              if (!t) return '—';
              return t
                .replace(/_/g, ' ')
                .replace(/^scrape statistics$/i, 'Scrape statistics')
                .replace(/^scrape styles$/i, 'Scrape styles')
                .replace(/^update style stock$/i, 'Scrape stock')
                .replace(/^export overview$/i, 'Export overview')
                .replace(/\b\w/g, (m) => m.toUpperCase());
            })();
            return (
              <tr key={j.id} style={{ borderTop: '1px solid #eee' }}>
                <td><Link href={`/admin/jobs/${j.id}`}>{j.id.slice(0, 8)}…</Link></td>
                <td>{label}</td>
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

