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
    return showAll ? filtered : filtered.slice(0, 15);
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
  // Global exclusions edit state
  const [exclSelected, setExclSelected] = React.useState<string[]>([]);
  const [exclSearch, setExclSearch] = React.useState('');
  const [exclSearching, setExclSearching] = React.useState(false);
  const [exclResults, setExclResults] = React.useState<Array<{ style_no: string; style_name: string | null }>>([]);
  React.useEffect(() => {
    if (excludeModalOpen) {
      const arr = ((excludedGlobal?.list || []) as string[]).map(String);
      setExclSelected(Array.from(new Set(arr)));
      setExclSearch('');
      setExclResults([]);
    }
  }, [excludeModalOpen, excludedGlobal?.id]);
  // Search styles by style no or name
  React.useEffect(() => {
    let cancelled = false;
    const q = (exclSearch || '').trim();
    if (!excludeModalOpen) return;
    if (!q) { setExclResults([]); return; }
    (async () => {
      setExclSearching(true);
      try {
        const { data, error } = await supabase
          .from('styles')
          .select('style_no, style_name')
          .or(`style_no.ilike.%${q}%,style_name.ilike.%${q}%`)
          .order('style_no', { ascending: true })
          .limit(20);
        if (!cancelled) setExclResults(((data ?? []) as any[]).map(r => ({ style_no: r.style_no, style_name: r.style_name ?? null })));
      } finally {
        if (!cancelled) setExclSearching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [exclSearch, excludeModalOpen]);
  // Names for selected exclusions
  const { data: exclSelectedMeta } = useSWR(excludeModalOpen && (exclSelected?.length || 0) > 0 ? ['top-styles:excluded-meta', exclSelected.join(',')] : null, async () => {
    const { data } = await supabase.from('styles').select('style_no, style_name').in('style_no', exclSelected);
    const map = new Map<string, string | null>();
    for (const r of (data ?? []) as any[]) map.set(r.style_no, r.style_name ?? null);
    return map;
  });
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
        <h1 className="text-xl font-semibold">Top 15 Styles</h1>
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
              <th className="p-2 text-left">Style Name</th>
              <th className="p-2 text-left">Color</th>
              <th className="p-2 text-left">Type</th>
              <th className="p-2 text-right">Sold</th>
              <th className="p-2 text-left">DG</th>
              <th className="p-2 text-left">Supplier</th>
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((r: any, i: number) => (
              <tr key={r.id} className="border-t">
                
                <td className="p-2">{i+1}</td>
                <td className="p-2"><img src={r.image_url} alt="" className="h-10 w-10 object-cover rounded" /></td>
                <td className="p-2">{r.style_name}</td>
                <td className="p-2">{r.color || '—'}</td>
                <td className="p-2">{r.type}</td>
                <td className="p-2 text-right">{Number(r.qty || 0).toLocaleString('da-DK')}</td>
                <td className="p-2">
                  <input
                    type="text"
                    defaultValue={r.dg || ''}
                    className="w-36 rounded border px-2 py-1 text-sm"
                    placeholder="DG"
                    onBlur={async (e) => {
                      const val = (e.target.value || '').trim();
                      if ((r.dg || '') === val) return;
                      try {
                        const res = await fetch('/api/top-styles/dg', {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ id: r.id, style_no: r.style_no, dg: val || null })
                        });
                        if (!res.ok) {
                          const txt = await res.text().catch(()=> '');
                          throw new Error(txt || 'Failed to save DG');
                        }
                        await mutate();
                      } catch (err: any) {
                        alert(err?.message || 'Failed to save DG');
                      }
                    }}
                  />
                </td>
                <td className="p-2">{supplierMap?.get(r.style_no) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-2">
          {!showAll && (items?.length ?? 0) >= 15 && (
            <button
              className="text-xs text-gray-600 hover:underline"
              onClick={() => setShowAll(true)}
            >View more</button>
          )}
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
          <div className="mt-3 text-xs text-gray-600">
            Search and add styles to exclude globally (applies to all seasons).
          </div>
          <div className="mt-2">
            <input
              className="w-full rounded border px-2 py-1 text-sm"
              placeholder="Search by style no or name…"
              value={exclSearch}
              onChange={(e) => setExclSearch(e.target.value)}
            />
            {exclSearch && (
              <div className="mt-1 max-h-48 overflow-auto rounded border bg-white">
                {exclSearching && <div className="p-2 text-xs text-gray-500">Searching…</div>}
                {!exclSearching && exclResults.length === 0 && <div className="p-2 text-xs text-gray-500">No results</div>}
                {!exclSearching && exclResults.map(r => {
                  const already = exclSelected.includes(r.style_no);
                  return (
                    <div key={r.style_no} className="flex items-center justify-between px-2 py-1.5 text-sm hover:bg-gray-50">
                      <div className="min-w-0">
                        <div className="font-mono text-xs text-gray-700">{r.style_no}</div>
                        <div className="text-xs text-gray-600 truncate">{r.style_name || '—'}</div>
                      </div>
                      <button
                        className={"ml-2 rounded border px-2 py-0.5 text-xs " + (already ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50')}
                        disabled={already}
                        onClick={() => setExclSelected(prev => Array.from(new Set([...prev, r.style_no])))}
                      >
                        {already ? 'Added' : 'Add'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="mt-3">
            <div className="text-xs font-semibold text-gray-700 mb-1">Selected exclusions</div>
            <div className="max-h-40 overflow-auto rounded border">
              {exclSelected.length === 0 ? (
                <div className="p-2 text-xs text-gray-500">None selected</div>
              ) : (
                <ul className="divide-y">
                  {exclSelected.map(no => {
                    const nm = exclSelectedMeta?.get(no) || null;
                    return (
                      <li key={no} className="flex items-center justify-between px-2 py-1.5">
                        <div className="min-w-0">
                          <div className="font-mono text-xs text-gray-700">{no}</div>
                          <div className="text-xs text-gray-600 truncate">{nm || '—'}</div>
                        </div>
                        <button
                          className="ml-2 rounded border px-2 py-0.5 text-xs hover:bg-gray-50"
                          onClick={() => setExclSelected(prev => prev.filter(x => x !== no))}
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button className="rounded border px-3 py-1 text-xs" onClick={() => setExcludeModalOpen(false)}>Cancel</button>
            <button
              className="rounded border px-3 py-1 text-xs bg-slate-900 text-white hover:opacity-90"
              onClick={async () => {
                const key = 'top_styles_excluded_global';
                const styleNos = Array.from(new Set((exclSelected || []).map(s => String(s).trim()).filter(Boolean)));
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


