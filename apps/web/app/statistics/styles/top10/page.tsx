'use client';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';
import React from 'react';
export default function Top10StylesPage() {
  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data } = await supabase.from('seasons').select('id, name, year, is_current').order('created_at', { ascending: false });
    return (data ?? []) as Array<{ id: string; name: string; year: number | null; is_current?: boolean }>;
  });
  const defaultSeasonId = React.useMemo(() => (seasons ?? []).find(s => (s as any).is_current)?.id || (seasons ?? [])[0]?.id || null, [seasons?.length]);
  const [seasonId, setSeasonId] = React.useState<string | null>(null);
  React.useEffect(() => { if (!seasonId && defaultSeasonId) setSeasonId(defaultSeasonId); }, [defaultSeasonId]);
  const [showAll, setShowAll] = React.useState(false);
  const { data: items, mutate } = useSWR(seasonId ? ['top-styles', seasonId, showAll ? 'all' : 'top10'] : null, async () => {
    const q = supabase.from('top_styles').select('*').eq('season_id', seasonId).order('qty', { ascending: false });
    const { data } = showAll ? await q : await q.limit(10);
    return (data ?? []) as any[];
  });
  const [running, setRunning] = React.useState(false);
  async function runScrape() {
    if (running) return;
    try {
      setRunning(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { alert('Not signed in'); return; }
      const token = session.access_token;
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'scrape_top_styles', payload: { requestedBy: session.user.email } })
      });
      if (!res.ok) throw new Error(await res.text());
      // Give the worker some time, then refresh
      setTimeout(() => mutate(), 3000);
    } catch (e: any) {
      alert(e?.message || 'Failed to enqueue');
    } finally {
      setRunning(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">Statistics</div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Top 10 Styles</h1>
        <button
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          onClick={runScrape}
          disabled={running}
        >{running ? 'Running…' : 'Run scrape'}</button>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-600">Season</label>
        <select
          className="rounded border px-2 py-1 text-sm"
          value={seasonId || ''}
          onChange={(e) => setSeasonId(e.target.value || null)}
        >
          {(seasons ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.year ? ' ' + s.year : ''}</option>
          ))}
        </select>
      </div>
      <div className="rounded-md border p-2 overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left">#</th>
              <th className="p-2 text-left">Image</th>
              <th className="p-2 text-left">Style No</th>
              <th className="p-2 text-left">Style Name</th>
              <th className="p-2 text-left">Type</th>
              <th className="p-2 text-left">Quality</th>
              <th className="p-2 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((r: any, i: number) => (
              <tr key={r.id} className="border-t">
                <td className="p-2">{i+1}</td>
                <td className="p-2"><img src={r.image_url} alt="" className="h-10 w-10 object-cover rounded" /></td>
                <td className="p-2">{r.style_no}</td>
                <td className="p-2">{r.style_name}</td>
                <td className="p-2">{r.type}</td>
                <td className="p-2">{r.quality}</td>
                <td className="p-2 text-right">{Number(r.qty || 0).toLocaleString('da-DK')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-2">
          {!showAll && (items?.length ?? 0) >= 10 && (
            <button
              className="text-xs text-gray-600 hover:underline"
              onClick={() => setShowAll(true)}
            >View more</button>
          )}
        </div>
      </div>
    </div>
  );
}


