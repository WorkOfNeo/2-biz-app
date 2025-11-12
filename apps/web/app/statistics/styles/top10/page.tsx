'use client';
import useSWR from 'swr';
import { supabase, useRoles } from '../../../../lib/supabaseClient';
import { ProgressBar } from '../../../../components/ProgressBar';
import React from 'react';
import { MoreHorizontal } from 'lucide-react';
export default function Top10StylesPage() {
  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data } = await supabase.from('seasons').select('id, name, year, is_current').order('created_at', { ascending: false });
    return (data ?? []) as Array<{ id: string; name: string; year: number | null; is_current?: boolean }>;
  });
  const defaultSeasonId = React.useMemo(() => (seasons ?? []).find(s => (s as any).is_current)?.id || (seasons ?? [])[0]?.id || null, [seasons?.length]);
  const [seasonId, setSeasonId] = React.useState<string | null>(null);
  React.useEffect(() => { if (!seasonId && defaultSeasonId) setSeasonId(defaultSeasonId); }, [defaultSeasonId]);
  const [showAll, setShowAll] = React.useState(false);
  // Load all rows for season; we'll filter/exclude and slice to top 10 locally
  const { data: allItems, mutate } = useSWR(seasonId ? ['top-styles', seasonId] : null, async () => {
    const { data } = await supabase.from('top_styles').select('*').eq('season_id', seasonId).order('qty', { ascending: false });
    return (data ?? []) as any[];
  });
  // Excluded styles per season (by style_no)
  const { data: excludedSet, mutate: mutateExcluded } = useSWR(seasonId ? ['top-styles:excluded', seasonId] : null, async () => {
    const key = `top_styles_excluded:${seasonId}`;
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
    const list = (((data?.value as any)?.styleNos as string[] | undefined) ?? []).filter(Boolean);
    return new Set(list);
  });
  // Global exclusions across all seasons
  const { data: excludedGlobal, mutate: mutateExcludedGlobal } = useSWR('top-styles:excluded-global', async () => {
    const key = 'top_styles_excluded_global';
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', key).maybeSingle();
    const list = (((data?.value as any)?.styleNos as string[] | undefined) ?? []).filter(Boolean);
    return { id: (data as any)?.id as string | null, list } as { id: string | null; list: string[] };
  });
  const excludedGlobalSet = React.useMemo(() => new Set((excludedGlobal?.list || []).map(s => String(s))), [excludedGlobal?.id, excludedGlobal?.list?.length]);
  const items = React.useMemo(() => {
    const list = (allItems ?? []) as Array<any>;
    const ex = excludedSet as Set<string> | undefined;
    let filtered = ex ? list.filter((r) => !ex.has(r.style_no)) : list;
    if (excludedGlobalSet && excludedGlobalSet.size > 0) {
      filtered = filtered.filter((r) => !excludedGlobalSet.has(String(r.style_no)));
    }
    return showAll ? filtered : filtered.slice(0, 10);
  }, [allItems, excludedSet, excludedGlobalSet, showAll]);
  const { data: supplierMap } = useSWR(items && items.length ? ['suppliers', items.map(i=>i.style_no).join(',')] : null, async () => {
    const { data } = await supabase.from('styles').select('style_no, supplier').in('style_no', (items ?? []).map((i:any)=>i.style_no));
    const map = new Map<string, string | null>();
    for (const r of (data ?? []) as any[]) map.set(r.style_no, r.supplier ?? null);
    return map;
  });
  const { has } = useRoles();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [excludeModalOpen, setExcludeModalOpen] = React.useState(false);
  const [exclInput, setExclInput] = React.useState('');
  React.useEffect(() => {
    if (excludeModalOpen) {
      const arr = (excludedGlobal?.list || []) as string[];
      setExclInput(arr.join('\n'));
    }
  }, [excludeModalOpen, excludedGlobal?.id]);
  const [saving, setSaving] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // Initialize selection from exclusions when entering exclude mode or when exclusions change
  React.useEffect(() => {
    if (excludeModalOpen) {
      const base = new Set<string>();
      if (excludedSet && excludedSet instanceof Set) for (const s of excludedSet as Set<string>) base.add(s);
      setSelected(base);
    }
  }, [excludeModalOpen, excludedSet]);
  async function enqueueScrapeTopStyles() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ type: 'scrape_top_styles', payload: {} })
      });
      setMenuOpen(false);
    } catch {}
  }
  async function saveExclusions() {
    if (!seasonId) return;
    setSaving(true);
    const key = `top_styles_excluded:${seasonId}`;
    const value = { styleNos: Array.from(selected) };
    try {
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', key).maybeSingle();
      if (existing?.id) {
        await supabase.from('app_settings').update({ value }).eq('id', (existing as any).id);
      } else {
        await supabase.from('app_settings').insert({ key, value } as any);
      }
      await mutateExcluded();
      await mutate();
      setExcludeModalOpen(false);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">Statistics</div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Top 10 Styles</h1>
        {has('admin') && (
          <div className="relative">
            <button
              className="rounded border px-2 py-1 text-sm hover:bg-gray-50 inline-flex items-center gap-1"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MoreHorizontal size={16} />
              Menu
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-56 rounded border bg-white shadow z-10">
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  onClick={enqueueScrapeTopStyles}
                >
                  Scrape Top 10
                </button>
                <button className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50" onClick={() => { setExcludeModalOpen(true); setMenuOpen(false); }}>
                  Exclude Styles
                </button>
              </div>
            )}
          </div>
        )}
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
              <th className="p-2 text-left">Color</th>
              <th className="p-2 text-left">Supplier</th>
              <th className="p-2 text-left">DG</th>
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
                <td className="p-2">{r.color || '—'}</td>
                <td className="p-2">{supplierMap?.get(r.style_no) || '—'}</td>
                <td className="p-2">
                  <input
                    type="text"
                    defaultValue={r.dg || ''}
                    className="w-36 rounded border px-2 py-1 text-sm"
                    placeholder="DG"
                    onBlur={async (e) => {
                      try {
                        const val = e.target.value;
                        await supabase.from('top_styles').update({ dg: val || null }).eq('id', r.id);
                        // Also persist DG on styles so general style cards show it
                        await supabase.from('styles').update({ dg: val || null }).eq('style_no', r.style_no);
                      } catch {}
                    }}
                  />
                </td>
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
    {/* Global Exclusions Modal */}
    {excludeModalOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="w-full max-w-lg rounded-md bg-white p-4 shadow">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Exclude Styles (Global)</div>
            <button className="text-xs underline" onClick={() => setExcludeModalOpen(false)}>Close</button>
          </div>
          <div className="mt-3 text-xs text-gray-600">Enter style numbers to exclude (one per line or comma-separated). Applies to all seasons.</div>
          <textarea
            className="mt-2 w-full h-40 rounded border p-2 text-sm font-mono"
            value={exclInput}
            onChange={(e) => setExclInput(e.target.value)}
            placeholder="e.g. BR7225\nBR7120"
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <button className="rounded border px-3 py-1 text-xs" onClick={() => setExcludeModalOpen(false)}>Cancel</button>
            <button
              className="rounded border px-3 py-1 text-xs bg-slate-900 text-white hover:opacity-90"
              onClick={async () => {
                const key = 'top_styles_excluded_global';
                const styleNos = Array.from(new Set((exclInput || '')
                  .split(/[,\n]+/)
                  .map(s => s.trim())
                  .filter(Boolean)));
                try {
                  const { data: existing } = await supabase.from('app_settings').select('id').eq('key', key).maybeSingle();
                  if (existing?.id) {
                    await supabase.from('app_settings').update({ value: { styleNos } }).eq('id', (existing as any).id);
                  } else {
                    await supabase.from('app_settings').insert({ key, value: { styleNos } } as any);
                  }
                  await mutateExcludedGlobal();
                  setExcludeModalOpen(false);
                } catch {}
              }}
            >Save</button>
          </div>
        </div>
      </div>
    )}
  </div>
  );
}


