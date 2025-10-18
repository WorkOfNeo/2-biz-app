'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function StylesRunsPage() {
  const supabase = createClientComponentClient();
  const { data: jobs } = useSWR('styles:runs', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, status, created_at, started_at, finished_at, error')
      .eq('type', 'update_style_stock')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  }, { refreshInterval: 10000 });

  async function enqueue() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'update_style_stock', payload: { requestedBy: session.user.email } })
      });
      const js = await res.json().catch(() => ({}));
      // eslint-disable-next-line no-console
      console.log('[styles-runs] enqueue', res.status, js);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[styles-runs] enqueue error', e);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Styles</div>
          <h1 className="text-xl font-semibold">Runs</h1>
        </div>
        <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={enqueue}>Update Stock</button>
      </div>

      <div className="rounded-md border bg-white overflow-hidden">
        <table className="min-w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">Job</th>
              <th className="p-2 text-left border-b">Status</th>
              <th className="p-2 text-left border-b">Started</th>
              <th className="p-2 text-left border-b">Finished</th>
            </tr>
          </thead>
          <tbody>
            {(jobs ?? []).map((j: any) => (
              <tr key={j.id}>
                <td className="p-2 border-b"><Link className="underline" href={`/admin/jobs/${j.id}`}>{j.id.slice(0,8)}…</Link></td>
                <td className="p-2 border-b">{j.status}</td>
                <td className="p-2 border-b">{j.started_at ? new Date(j.started_at).toLocaleString() : '—'}</td>
                <td className="p-2 border-b">{j.finished_at ? new Date(j.finished_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


