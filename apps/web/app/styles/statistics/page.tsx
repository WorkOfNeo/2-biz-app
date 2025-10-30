'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase, useRoles } from '../../../lib/supabaseClient';

export default function StylesStatisticsPage() {
  const { has } = useRoles();
  const [running, setRunning] = React.useState(false as any);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const { data: recent } = useSWR(has('admin') ? 'statistics_per_size:recent' : null, async () => {
    const { data, error } = await supabase
      .from('statistics_per_size_snapshots')
      .select('id, date_from, rows_count, scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return data ?? [];
  }, { refreshInterval: 10000 });

  async function enqueue() {
    setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const token = session.access_token;
      const body = { type: 'scrape_statistics', payload: { requestedBy: session.user.email, kind: 'per_size' } } as any;
      const res = await fetch('/api/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      const js = await res.json();
      setJobId(js.jobId);
      setRunning(true);
    } catch (e: any) {
      setErr(e?.message || 'Failed to enqueue');
    }
  }

  if (!has('admin')) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Statistics</h1>
        <div className="text-sm text-gray-600">You do not have access to this page.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Styles</div>
          <h1 className="text-xl font-semibold">Statistics</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="relative rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
            onClick={enqueue}
            disabled={running}
          >
            {running ? 'Running…' : 'Scrape Statistics Per Size (Today)'}
          </button>
        </div>
      </div>
      {err && <div className="text-sm text-red-600">{err}</div>}
      <div className="rounded-md border overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">When</th>
              <th className="p-2 text-left border-b">Date from</th>
              <th className="p-2 text-left border-b">Rows</th>
              <th className="p-2 text-left border-b">Job</th>
            </tr>
          </thead>
          <tbody>
            {(recent ?? []).map((r: any) => (
              <tr key={r.id}>
                <td className="p-2 border-b whitespace-nowrap">{new Date(r.scraped_at).toLocaleString()}</td>
                <td className="p-2 border-b">{r.date_from}</td>
                <td className="p-2 border-b">{r.rows_count ?? '—'}</td>
                <td className="p-2 border-b font-mono text-[12px]">{jobId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


