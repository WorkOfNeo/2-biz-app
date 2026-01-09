'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function StylesRunsPage() {
  const supabase = createClientComponentClient();
  const RUNS: Array<{ type: string; label: string; description: string }> = [
    { type: 'update_style_stock', label: 'Update Stock', description: 'Refresh latest stock per style/color' },
    { type: 'deep_scrape_styles', label: 'Deep Enrich Styles', description: 'Open each style and sync colors ↔ seasons from SPY' },
    { type: 'scrape_eans', label: 'Scrape EANs', description: 'Fetch EANs for known colors' },
    { type: 'scrape_styles', label: 'Update Styles (Meta)', description: 'Refresh list of styles, names, images' },
  ];
  const { data: jobsByType } = useSWR('styles:runs:all', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, type, status, created_at, started_at, finished_at, error')
      .in('type', RUNS.map((r) => r.type))
      .order('created_at', { ascending: false })
      .limit(80);
    if (error) throw new Error(error.message);
    const map = new Map<string, any[]>();
    for (const r of (data ?? [])) {
      const arr = map.get((r as any).type) || [];
      if (arr.length < 20) arr.push(r);
      map.set((r as any).type, arr);
    }
    return map;
  }, { refreshInterval: 10000 });

  async function enqueue(type: string, payload?: Record<string, any>) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      // Add current season id for deep_scrape_styles
      let fullPayload = { requestedBy: session.user.email, ...(payload || {}) } as Record<string, any>;
      if (type === 'deep_scrape_styles') {
        const { data: current } = await supabase.from('seasons').select('id, spy_season_id').eq('is_current', true).maybeSingle();
        const seasonId = (current as any)?.id as string | undefined;
        const spySeasonId = Number((current as any)?.spy_season_id || 0) || null;
        if (!seasonId || !spySeasonId) throw new Error('Current season not mapped to SPY yet');
        fullPayload = { ...fullPayload, seasonId };
      }
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type, payload: fullPayload })
      });
      const js = await res.json().catch(() => ({}));
      // eslint-disable-next-line no-console
      console.log('[styles-runs] enqueue', type, res.status, js);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[styles-runs] enqueue error', e);
      alert((e as any)?.message || 'Failed to enqueue job');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Styles</div>
          <h1 className="text-xl font-semibold">Runs</h1>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={() => enqueue('update_style_stock')}>Update Stock</button>
          <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={() => enqueue('deep_scrape_styles')}>Deep Enrich</button>
          <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={() => enqueue('scrape_eans')}>Scrape EANs</button>
          <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={() => enqueue('scrape_styles')}>Update Styles</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {RUNS.map((run) => {
          const rows = jobsByType?.get(run.type) || [];
          return (
            <div key={run.type} className="rounded-md border bg-white">
              <div className="flex items-center justify-between p-3 border-b">
                <div>
                  <div className="text-sm font-medium">{run.label}</div>
                  <div className="text-[11px] text-gray-600">{run.description}</div>
                </div>
                <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={() => enqueue(run.type)}>
                  Run
                </button>
              </div>
              <div className="overflow-auto">
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
                    {rows.map((j: any) => (
                      <tr key={j.id} className="hover:bg-gray-50">
                        <td className="p-2 border-b"><Link className="underline" href={`/admin/jobs/${j.id}`}>{j.id.slice(0,8)}…</Link></td>
                        <td className="p-2 border-b">{j.status}</td>
                        <td className="p-2 border-b">{j.started_at ? new Date(j.started_at).toLocaleString() : '—'}</td>
                        <td className="p-2 border-b">{j.finished_at ? new Date(j.finished_at).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td className="p-2 text-gray-500" colSpan={4}>No recent runs.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


