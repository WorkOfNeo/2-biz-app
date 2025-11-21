'use client';
import * as React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { SearchSelect } from '../../../components/SearchSelect';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { Modal } from '../../../components/Modal';

type TabKey = 'scraping' | 'stock-lists';

export default function StylesSettingsPage() {
  const [tab, setTab] = React.useState<TabKey>('scraping');
  const supabase = createClientComponentClient();

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <Card>
        <CardHeader className="gap-2">
          <div className="flex items-center gap-1">
            <TabButton active={tab==='scraping'} onClick={()=>setTab('scraping')}>Scraping</TabButton>
            <TabButton active={tab==='stock-lists'} onClick={()=>setTab('stock-lists')}>Stock Lists</TabButton>
          </div>
        </CardHeader>
        <CardContent>
          {tab === 'scraping' && <ScrapingTab supabase={supabase} />}
          {tab === 'stock-lists' && <StockListsTab supabase={supabase} />}
        </CardContent>
      </Card>
    </div>
  );
}

function StockListsTab({ supabase }: { supabase: any }) {
  const ReactNS = React as typeof import('react');
  const [innerTab, setInnerTab] = ReactNS.useState<'add' | 'edit'>(() => 'edit');
  // Feedback notice
  const [notice, setNotice] = ReactNS.useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  function flash(text: string, kind: 'success' | 'error' = 'success') {
    setNotice({ text, kind });
    setTimeout(() => setNotice(null), 1800);
  }
  // Load stock lists
  const { data: stockLists, mutate: mutateLists } = useSWR('stock-lists:settings', async () => {
    const { data, error } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; name: string }>;
  }, { refreshInterval: 0 });
  const [activeListId, setActiveListId] = ReactNS.useState<string>('');
  // Persist selection for editor page convenience
  ReactNS.useEffect(() => { try { if (activeListId) localStorage.setItem('activeStockListId', activeListId); } catch {} }, [activeListId]);
  const [newListName, setNewListName] = ReactNS.useState<string>('');
  async function createList() {
    const name = newListName.trim();
    if (!name) return;
    const { data, error } = await supabase.from('stock_lists').insert({ name }).select('id').single();
    if (error) { alert(error.message); return; }
    await mutateLists();
    setActiveListId((data as any).id as string);
    setNewListName('');
  }
  // Load styles and seasons for filtering
  type StyleRow = { id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null };
  const { data: styles } = useSWR('styles:all:stocklists', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url')
      .order('style_no', { ascending: true })
      .limit(4000);
    if (error) throw error;
    return (data ?? []) as StyleRow[];
  }, { refreshInterval: 0 });
  const { data: seasons } = useSWR('seasons:list:stocklists', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year, hidden').order('year', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; name: string | null; year: number | null; hidden?: boolean | null }>;
  }, { refreshInterval: 0 });
  const seasonCodeById = ReactNS.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (seasons ?? [])) {
      const parts = String(s.name || '').trim().split(/\s+/).filter(Boolean);
      const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
      const yy = s.year != null ? String(s.year).slice(-2) : '';
      m.set(String(s.id), `${letters}${yy}`);
    }
    return m;
  }, [seasons && seasons.length]);
  const { data: styleSeasons } = useSWR('style_seasons:byStyle:stocklists', async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons').limit(8000);
    if (error) throw error;
    const byStyle = new Map<string, string[]>();
    for (const r of (data ?? []) as any[]) {
      const arr = Array.isArray(r.seasons) ? (r.seasons as string[]) : [];
      byStyle.set(r.style_no, arr);
    }
    return byStyle as Map<string, string[]>;
  }, { refreshInterval: 0 });
  const [seasonId, setSeasonId] = ReactNS.useState<string>('');
  const [query, setQuery] = ReactNS.useState<string>('');
  const seasonSelectItems = ReactNS.useMemo(() => {
    return (seasons ?? [])
      .filter((s) => !(s as any).hidden)
      .map((s) => ({ value: String(s.id), label: seasonCodeById.get(String(s.id)) || String(s.id) }));
  }, [seasons && seasons.length, seasonCodeById && Array.from(seasonCodeById.keys()).length]);
  const filtered = ReactNS.useMemo(() => {
    let list = (styles ?? []) as StyleRow[];
    if (seasonId) {
      const target = (() => {
        const s = (seasons ?? []).find((x) => String(x.id) === String(seasonId));
        if (!s) return '';
        const yy = s.year != null ? String(s.year).slice(-2) : '';
        const name = String(s.name || '').toUpperCase();
        return yy && name ? `${yy} ${name}` : '';
      })();
      if (target) list = list.filter((st) => (styleSeasons?.get(st.style_no) || []).includes(target));
    }
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => (s.style_no || '').toLowerCase().includes(q) || (s.style_name || '').toLowerCase().includes(q));
  }, [styles, seasonId, styleSeasons, query, seasons && seasons.length]);
  // Manage adding to list
  const { data: listStyles } = useSWR(activeListId ? ['stock-list-styles:ids', activeListId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_styles').select('style_id').eq('list_id', activeListId);
    if (error) throw error;
    return new Set(((data ?? []) as any[]).map(r => String(r.style_id)));
  }, { refreshInterval: 0 });
  const styleIdsInList = ReactNS.useMemo(() => Array.from((listStyles as Set<string> | undefined) || new Set<string>()), [listStyles]);
  async function addStylesToList(styleIds: string[]) {
    const listId = activeListId;
    if (!listId) { alert('Create or select a stock list first'); return; }
    const existing = (listStyles as Set<string>) || new Set<string>();
    const toInsert = Array.from(new Set(styleIds.filter((id) => id && !existing.has(String(id))))).map((id) => ({ list_id: listId, style_id: id }));
    if (toInsert.length === 0) { flash('No new styles to add', 'error'); return; }
    const { error } = await supabase.from('stock_list_styles').upsert(toInsert as any, { onConflict: 'list_id,style_id' } as any);
    if (error) { alert(error.message); return; }
    try { await (useSWR as any).mutate?.(['stock-list-styles:ids', listId]); } catch {}
    flash(`Added ${toInsert.length} styles`);
  }
  // Colors for styles in the active list
  const { data: styleColors } = useSWR(activeListId && styleIdsInList.length ? ['style_colors:forList', activeListId, styleIdsInList.join(',')] : null, async () => {
    const { data, error } = await supabase.from('style_colors').select('id, style_id, color').in('style_id', styleIdsInList);
    if (error) throw error;
    // style_id -> [{id,color}]
    const byStyle = new Map<string, Array<{ id: string; color: string }>>();
    for (const r of (data ?? []) as any[]) {
      const sid = String(r.style_id || '');
      const list = byStyle.get(sid) || [];
      list.push({ id: String(r.id), color: String(r.color || '') });
      byStyle.set(sid, list);
    }
    // invert maps
    const invByStyle = new Map<string, Map<string, string>>();
    const fwdByStyle = new Map<string, Map<string, string>>();
    for (const [sid, list] of byStyle.entries()) {
      const inv = new Map<string, string>();
      const fwd = new Map<string, string>();
      for (const row of list) {
        const key = row.color.trim().toLowerCase();
        inv.set(row.id, key);
        fwd.set(key, row.id);
      }
      invByStyle.set(sid, inv);
      fwdByStyle.set(sid, fwd);
    }
    return { byStyle, invByStyle, fwdByStyle };
  }, { refreshInterval: 0 });
  // Current include rules for this list
  const { data: listColorRules, mutate: mutateColorRules } = useSWR(activeListId ? ['stock_list_colors:byList:settings', activeListId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_colors').select('style_id, style_color_id, include').eq('list_id', activeListId);
    if (error) throw error;
    const includeIdsMap = new Map<string, Set<string>>(); // style_id -> set(style_color_id)
    const hasAnyMap = new Map<string, boolean>(); // style_id -> has explicit rows
    for (const r of (data ?? []) as any[]) {
      const sid = String(r.style_id || '');
      hasAnyMap.set(sid, true);
      if (r.include === true) {
        const set = includeIdsMap.get(sid) || new Set<string>();
        set.add(String(r.style_color_id || ''));
        includeIdsMap.set(sid, set);
      }
    }
    return { includeIdsMap, hasAnyMap } as { includeIdsMap: Map<string, Set<string>>; hasAnyMap: Map<string, boolean> };
  }, { refreshInterval: 0 });
  async function toggleColorInclude(styleId: string, colorId: string) {
    if (!activeListId) return;
    try {
      const hasAny = Boolean(listColorRules?.hasAnyMap.get(styleId));
      const includeIds = new Set<string>((listColorRules?.includeIdsMap.get(styleId) || new Set<string>()) as Set<string>);
      const isOn = hasAny ? includeIds.has(colorId) : true;
      if (!hasAny) {
        // Create include rows for all colors except the toggled-off one
        const colors = styleColors?.byStyle.get(styleId) || [];
        const rows = colors
          .filter(c => String(c.id) !== String(colorId))
          .map(c => ({ list_id: activeListId, style_id: styleId, style_color_id: c.id, include: true }));
        if (rows.length) await supabase.from('stock_list_colors').upsert(rows as any, { onConflict: 'list_id,style_color_id' } as any);
        await mutateColorRules();
        flash('Saved');
        return;
      }
      if (isOn) {
        await supabase.from('stock_list_colors').delete().eq('list_id', activeListId).eq('style_id', styleId).eq('style_color_id', colorId);
      } else {
        await supabase.from('stock_list_colors').upsert({ list_id: activeListId, style_id: styleId, style_color_id: colorId, include: true } as any, { onConflict: 'list_id,style_color_id' } as any);
      }
      await mutateColorRules();
      flash('Saved');
    } catch (e: any) {
      flash(e?.message || 'Failed to save', 'error');
    }
  }
  async function allowAllColors(styleId: string) {
    if (!activeListId) return;
    try {
      await supabase.from('stock_list_colors').delete().eq('list_id', activeListId).eq('style_id', styleId);
      await mutateColorRules();
      flash('All colors allowed');
    } catch (e: any) {
      flash(e?.message || 'Failed to update', 'error');
    }
  }
  // Paste input
  const [pasted, setPasted] = ReactNS.useState<string>('');
  const [pasteOpen, setPasteOpen] = ReactNS.useState(false);
  const onAddPasted = async () => {
    try {
      const lines = pasted.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length === 0) return;
      // Lookup style ids by style_no
      const uniqueNos = Array.from(new Set(lines)).slice(0, 2000);
      const { data, error } = await supabase.from('styles').select('id, style_no').in('style_no', uniqueNos);
      if (error) throw error;
      const ids = ((data ?? []) as any[]).map(r => String(r.id)).filter(Boolean);
      if (ids.length === 0) { alert('No matching styles found'); return; }
      await addStylesToList(ids);
      setPasted('');
    } catch (e: any) { alert(e?.message || 'Failed to add'); }
  };
  return (
    <div className="text-sm text-gray-700">
      <div className="mb-2 flex items-center gap-2">
        <div className="text-xs text-gray-600">Create list</div>
        <Input className="w-56" placeholder="e.g. Outlet Week 12" value={newListName} onChange={(e)=>setNewListName(e.target.value)} />
        <Button size="sm" onClick={createList}>Create</Button>
      </div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="text-xs text-gray-600">Active list</div>
          <select className="rounded border px-2 py-1 text-xs" value={activeListId} onChange={(e)=>setActiveListId(e.target.value)}>
            <option value="">—</option>
            {(stockLists ?? []).map((l: any) => (<option key={l.id} value={l.id}>{l.name}</option>))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <TabButton active={innerTab==='add'} onClick={()=>setInnerTab('add')}>Add Styles</TabButton>
          <TabButton active={innerTab==='edit'} onClick={()=>setInnerTab('edit')}>Edit List</TabButton>
        </div>
      </div>
      {notice && (
        <div className={(notice.kind==='success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200') + ' mb-2 rounded border px-3 py-2 text-xs'}>
          {notice.text}
        </div>
      )}
      {!activeListId && (
        <div className="mb-3 text-xs text-gray-600">Create and select a list to start adding styles.</div>
      )}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Input className="w-56" placeholder="Search style no / name" value={query} onChange={(e)=>setQuery(e.target.value)} />
          <SearchSelect items={seasonSelectItems} value={seasonId} onChange={setSeasonId} placeholder="All seasons" clearable />
          <Button size="sm" disabled={!activeListId} onClick={async () => { const ids = filtered.map(s => s.id); await addStylesToList(ids); }}>Add All</Button>
        </div>
        <div>
          <Button size="sm" variant="outline" disabled={!activeListId} onClick={()=>setPasteOpen(true)}>Add by input</Button>
        </div>
      </div>
      <Modal open={pasteOpen} onClose={()=>setPasteOpen(false)} title="Add styles by input" footer={(<div className="flex items-center justify-end gap-2"><Button size="sm" variant="outline" onClick={()=>setPasteOpen(false)}>Cancel</Button><Button size="sm" disabled={!activeListId} onClick={onAddPasted}>Add to list</Button></div>)}>
        <div className="space-y-2">
          <div className="text-xs text-gray-600">Paste style numbers (one per line)</div>
          <textarea className="w-full h-40 rounded border p-2 text-sm" placeholder={`e.g.\n12345\n23456\n...`} value={pasted} onChange={(e)=>setPasted(e.target.value)} disabled={!activeListId} />
        </div>
      </Modal>
      {innerTab === 'add' && (
      <div className="max-h-80 overflow-auto border rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left">Image</th>
              <th className="p-2 text-left">Style no</th>
              <th className="p-2 text-left">Name</th>
              <th className="p-2 text-left">Add</th>
            </tr>
          </thead>
          <tbody>
            {(filtered ?? []).map((s) => (
              <tr key={s.id} className="border-t">
                <td className="p-2"><Thumb src={s.image_url || ''} /></td>
                <td className="p-2 font-medium">{s.style_no}</td>
                <td className="p-2">{s.style_name || '—'}</td>
                <td className="p-2">
                  <Button size="sm" variant="outline" disabled={!activeListId} onClick={async ()=> addStylesToList([s.id])}>Add</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {innerTab === 'edit' && activeListId && (
        <div className="max-h-96 overflow-auto border rounded">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-2 text-left">Style</th>
                <th className="p-2 text-left">Colors (toggle to include)</th>
                <th className="p-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {styleIdsInList.map((sid) => {
                const row = (styles || []).find(s => String(s.id) === sid);
                const colors = styleColors?.byStyle.get(sid) || [];
                const hasAny = Boolean(listColorRules?.hasAnyMap.get(sid));
                const includeIdsSet = (listColorRules?.includeIdsMap.get(sid) || new Set<string>()) as Set<string>;
                return (
                  <tr key={sid} className="border-t align-top">
                    <td className="p-2">
                      <div className="font-medium">{row?.style_no || '—'}</div>
                      <div className="text-xs text-gray-600">{row?.style_name || '—'}</div>
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-2">
                        {colors.map((c) => {
                          const on = hasAny ? includeIdsSet.has(String(c.id)) : true;
                          return (
                            <label key={c.id} className={"inline-flex items-center gap-1 px-2 py-1 rounded border " + (on ? 'bg-slate-900 text-white border-slate-900' : '')}>
                              <input type="checkbox" className="h-3 w-3" checked={on} onChange={() => toggleColorInclude(sid, String(c.id))} />
                              <span className="text-xs">{c.color}</span>
                            </label>
                          );
                        })}
                      </div>
                    </td>
                    <td className="p-2">
                      <Button size="sm" variant="outline" onClick={()=>allowAllColors(sid)}>Allow all colors</Button>
                    </td>
                  </tr>
                );
              })}
              {styleIdsInList.length === 0 && (
                <tr><td className="p-2 text-xs text-gray-600" colSpan={3}>No styles in this list yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScrapingTab({ supabase }: { supabase: any }) {
  const ReactNS = React as typeof import('react');
  // Load styles
  type StyleRow = { id: string; style_no: string; style_name: string | null; supplier: string | null; image_url: string | null };
  const { data: styles } = useSWR('styles:all:scraping', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url')
      .order('style_no', { ascending: true })
      .limit(2000);
    if (error) throw error;
    return (data ?? []) as StyleRow[];
  }, { refreshInterval: 0 });
  // Colors
  const { data: colorsByStyle } = useSWR('style_colors:map', async () => {
    const pageSize = 1000;
    const rows: any[] = [];
    let from = 0;
    while (true) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase.from('style_colors').select('id, style_id, color').order('color').range(from, to);
      if (error) throw error;
      const batch = data ?? [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    const map = new Map<string, Array<{ id: string; color: string }>>();
    for (const r of rows) {
      const arr = map.get(r.style_id) || [];
      arr.push({ id: r.id, color: r.color });
      map.set(r.style_id, arr);
    }
    return map;
  }, { refreshInterval: 0 });
  // Seasons
  const { data: seasons } = useSWR('seasons:list:min', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year, hidden').order('year', { ascending: false });
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; name: string | null; year: number | null; hidden?: boolean | null }>;
  }, { refreshInterval: 0 });
  const seasonCodeById = ReactNS.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of (seasons ?? [])) {
      const parts = String(s.name || '').trim().split(/\s+/).filter(Boolean);
      const letters = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
      const yy = s.year != null ? String(s.year).slice(-2) : '';
      m.set(String(s.id), `${letters}${yy}`);
    }
    return m;
  }, [seasons && seasons.length]);
  const seasonLabelById = ReactNS.useMemo(() => {
    // style_seasons stores labels like "25 WINTER"
    const m = new Map<string, string>();
    for (const s of (seasons ?? [])) {
      const yy = s.year != null ? String(s.year).slice(-2) : '';
      const name = String(s.name || '').toUpperCase();
      if (yy && name) m.set(String(s.id), `${yy} ${name}`);
    }
    return m;
  }, [seasons && seasons.length]);
  const hiddenSeasonSet = ReactNS.useMemo(() => {
    const st = new Set<string>();
    for (const s of (seasons ?? [])) if ((s as any).hidden) st.add(String(s.id));
    return st;
  }, [seasons && seasons.length]);
  // Color -> seasons map
  const { data: colorSeasons } = useSWR('style_color_seasons:map', async () => {
    const pageSize = 2000;
    const out = new Map<string, string[]>();
    let from = 0;
    while (true) {
      const to = from + pageSize - 1;
      const { data, error } = await supabase.from('style_color_seasons').select('style_color_id, season_id').range(from, to);
      if (error) throw error;
      const batch = (data ?? []) as Array<{ style_color_id: string; season_id: string }>;
      for (const r of batch) {
        const arr = out.get(r.style_color_id) || [];
        if (!arr.includes(r.season_id)) arr.push(r.season_id);
        out.set(r.style_color_id, arr);
      }
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    return out as Map<string, string[]>;
  }, { refreshInterval: 0 });
  // style_seasons for filtering
  const { data: styleSeasons } = useSWR('style_seasons:byStyle', async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons').limit(5000);
    if (error) throw error;
    const byStyle = new Map<string, string[]>();
    const labels = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      const arr = Array.isArray(r.seasons) ? (r.seasons as string[]) : [];
      byStyle.set(r.style_no, arr);
      for (const s of arr) labels.add(String(s));
    }
    return { byStyle, labels: Array.from(labels).sort() } as { byStyle: Map<string, string[]>; labels: string[] };
  }, { refreshInterval: 0 });
  // Per-user selection
  const { data: selectionMap, mutate: mutateSelection } = useSWR('app-settings:styles-user-selection', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'styles_user_selection').maybeSingle();
    return { id: data?.id ?? null, value: ((data?.value as any) || {}) as Record<string, string[]> };
  });
  const [currentUserId, setCurrentUserId] = ReactNS.useState<string | null>(null);
  ReactNS.useEffect(() => { (async () => { const { data: { session } } = await supabase.auth.getSession(); setCurrentUserId(session?.user?.id ?? null); })(); }, []);
  const selectedSet = ReactNS.useMemo(() => {
    if (!currentUserId) return new Set<string>();
    return new Set<string>(selectionMap?.value?.[currentUserId] || []);
  }, [selectionMap, currentUserId]);
  async function toggle(styleNo: string) {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    const list = new Set<string>(map[currentUserId] || []);
    if (list.has(styleNo)) list.delete(styleNo); else list.add(styleNo);
    map[currentUserId] = Array.from(list);
    if (selectionMap?.id) await supabase.from('app_settings').update({ value: map }).eq('id', selectionMap.id as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }
  // Filters
  const [qLeft, setQLeft] = ReactNS.useState('');
  const [qRight, setQRight] = ReactNS.useState('');
  const [seasonLeft, setSeasonLeft] = ReactNS.useState<string>('');
  const [seasonRight, setSeasonRight] = ReactNS.useState<string>('');
  function applyFilter(list: StyleRow[], q: string, seasonId: string) {
    let out = list;
    const target = seasonId ? (seasonLabelById.get(seasonId) || '') : '';
    if (target) {
      out = out.filter((s) => {
        const arr = styleSeasons?.byStyle.get(s.style_no) || [];
        return arr.includes(target);
      });
    }
    const qq = q.trim().toLowerCase();
    if (!qq) return out;
    return out.filter((s) => {
      const name = (s.style_name || '').toLowerCase();
      const no = (s.style_no || '').toLowerCase();
      return name.includes(qq) || no.includes(qq);
    });
  }
  const leftItems = ReactNS.useMemo(() => applyFilter(styles ?? [], qLeft, seasonLeft), [styles, qLeft, seasonLeft, styleSeasons && (styleSeasons.labels || []).length]);
  const rightItems = ReactNS.useMemo(() => {
    const selected = (styles ?? []).filter((s) => selectedSet.has(s.style_no));
    return applyFilter(selected, qRight, seasonRight);
  }, [styles, selectedSet.size, qRight, seasonRight, styleSeasons && (styleSeasons.labels || []).length]);
  const seasonSelectItems = ReactNS.useMemo(() => {
    return (seasons ?? [])
      .filter((s) => !(s as any).hidden)
      .map((s) => ({ value: String(s.id), label: seasonCodeById.get(String(s.id)) || String(s.id) }));
  }, [seasons && seasons.length, seasonCodeById && Array.from(seasonCodeById.keys()).length]);

  // Manual run: enqueue selected scrape and measure elapsed seconds
  const [runBusy, setRunBusy] = ReactNS.useState(false);
  const [runJobId, setRunJobId] = ReactNS.useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = ReactNS.useState<number>(0);
  const [completedSec, setCompletedSec] = ReactNS.useState<number | null>(null);
  ReactNS.useEffect(() => {
    let t: any;
    if (runJobId && !completedSec) {
      t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    }
    return () => { if (t) clearInterval(t); };
  }, [runJobId, completedSec]);
  ReactNS.useEffect(() => {
    if (!runJobId) return;
    let t: any;
    const poll = async () => {
      try {
        const { data } = await supabase.from('jobs').select('status, started_at, finished_at').eq('id', runJobId).maybeSingle();
        const st = (data as any)?.status as string | undefined;
        const startedAt = (data as any)?.started_at ? new Date((data as any).started_at).getTime() : null;
        const finishedAt = (data as any)?.finished_at ? new Date((data as any).finished_at).getTime() : null;
        if (st && (st === 'succeeded' || st === 'failed' || st === 'cancelled')) {
          let secs: number;
          if (startedAt && finishedAt) secs = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
          else secs = elapsedSec;
          setCompletedSec(secs);
          setRunBusy(false);
          return;
        }
      } catch {}
    };
    t = setInterval(poll, 1200);
    return () => { if (t) clearInterval(t); };
  }, [runJobId, elapsedSec]);

  return (
    <div className="text-sm text-gray-700">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-gray-600">Run scraping for “Often scraped” selection.</div>
          <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="min-w-[9rem]"
            variant={runBusy ? 'secondary' : 'default'}
            disabled={runBusy}
            onClick={async () => {
              try {
              setRunBusy(true);
              setRunJobId(null);
              setElapsedSec(0);
              setCompletedSec(null);
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) throw new Error('Not signed in');
                const res = await fetch('/api/enqueue', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                body: JSON.stringify({ type: 'update_style_stock', payload: { requestedBy: session.user.email, mode: 'selected' } })
                });
                const js = await res.json().catch(() => ({}));
              if (!res.ok || !js?.jobId) throw new Error(js?.error || 'Failed to enqueue');
              setRunJobId(js.jobId as string);
              } catch (e: any) {
              alert(e?.message || 'Failed to enqueue run');
              setRunBusy(false);
            }
            }}
          >
            {runBusy ? 'Running…' : 'Run selected now'}
          </Button>
        </div>
      </div>
      {runJobId && (
        <div className="mb-3 text-xs text-gray-700">
          Job: <span className="font-mono">{runJobId.slice(0,8)}…</span> · Elapsed: {completedSec ?? elapsedSec}s {completedSec != null ? '(completed)' : ''}
        </div>
      )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded border">
          <div className="px-2 py-1 text-xs font-medium border-b bg-gray-50">All styles</div>
          <div className="p-2 flex items-center gap-2">
            <Input className="w-56" placeholder="Search style no / name" value={qLeft} onChange={(e)=>setQLeft(e.target.value)} />
            <SearchSelect items={seasonSelectItems} value={seasonLeft} onChange={setSeasonLeft} placeholder="All seasons" clearable />
            </div>
          <div className="max-h-96 overflow-auto divide-y">
            {(leftItems ?? []).map((s) => {
              const added = selectedSet.has(s.style_no);
                return (
                <div key={s.id} className={"flex items-start justify-between gap-2 px-2 py-2 " + (added ? 'bg-slate-50' : '')}>
                  <div className="flex items-start gap-2 min-w-0">
                    <Thumb src={s.image_url || ''} />
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{s.style_no}</div>
                      <div className="text-gray-700 truncate">{s.style_name ?? '—'}</div>
                      <ColorsLine styleId={s.id} colorsByStyle={colorsByStyle} colorSeasons={colorSeasons} seasonCodeById={seasonCodeById} hiddenSeasonSet={hiddenSeasonSet} />
                    </div>
                  </div>
                  <Button size="sm" variant={added ? 'secondary' : 'default'} onClick={()=>toggle(s.style_no)}>{added ? 'Added' : 'Add'}</Button>
                  </div>
                );
              })}
            </div>
          </div>
        <div className="rounded border">
          <div className="px-2 py-1 text-xs font-medium border-b bg-gray-50">Often scraped</div>
          <div className="p-2 flex items-center gap-2">
            <Input className="w-56" placeholder="Search style no / name" value={qRight} onChange={(e)=>setQRight(e.target.value)} />
            <SearchSelect items={seasonSelectItems} value={seasonRight} onChange={setSeasonRight} placeholder="All seasons" clearable />
          </div>
          <div className="max-h-96 overflow-auto divide-y">
            {(rightItems ?? []).map((s) => (
              <div key={s.id} className="flex items-start justify-between gap-2 px-2 py-2">
                <div className="flex items-start gap-2 min-w-0">
                  <Thumb src={s.image_url || ''} />
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 truncate">{s.style_no}</div>
                    <div className="text-gray-700 truncate">{s.style_name ?? '—'}</div>
                    <ColorsLine styleId={s.id} colorsByStyle={colorsByStyle} colorSeasons={colorSeasons} seasonCodeById={seasonCodeById} hiddenSeasonSet={hiddenSeasonSet} />
              </div>
            </div>
                <Button size="sm" variant="outline" onClick={()=>toggle(s.style_no)}>Remove</Button>
                </div>
              ))}
            {(rightItems ?? []).length === 0 && (
              <div className="px-2 py-2 text-[11px] text-gray-500">No styles selected.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      size="sm"
      variant={active ? 'default' : 'outline'}
      onClick={onClick}
      type="button"
      className={active ? 'rounded-b-none' : 'rounded-b-none'}
    >
      {children}
    </Button>
  );
}

function Thumb({ src }: { src: string }) {
  const ReactNS = React as typeof import('react');
  const [imgSrc, setImgSrc] = ReactNS.useState<string>(src);
  const [attempt, setAttempt] = ReactNS.useState<number>(0);
  ReactNS.useEffect(() => { setImgSrc(src); setAttempt(0); }, [src]);
  if (!imgSrc) return <div className="w-7 h-7 rounded border bg-gray-100" />;
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={imgSrc}
      alt=""
      className="w-7 h-7 rounded object-cover border"
      onError={() => {
        if (attempt === 0 && /tr:n-s1024/i.test(imgSrc)) { setImgSrc(imgSrc.replace(/tr:n-s1024/ig, 'tr:n-s512')); setAttempt(1); return; }
        if (attempt === 1 && /tr:n-s512/i.test(imgSrc)) { setImgSrc(imgSrc.replace(/tr:n-s512/ig, 'tr:n-s256')); setAttempt(2); return; }
        if (attempt === 2 && /\/tr:n-s\d+\//i.test(imgSrc)) { setImgSrc(imgSrc.replace(/\/tr:n-s\d+\//ig, '/')); setAttempt(3); return; }
        setImgSrc('');
      }}
    />
  );
}

function ColorsLine({
  styleId,
  colorsByStyle,
  colorSeasons,
  seasonCodeById,
  hiddenSeasonSet,
}: {
  styleId: string;
  colorsByStyle: Map<string, Array<{ id: string; color: string }>> | undefined;
  colorSeasons: Map<string, string[]> | undefined;
  seasonCodeById: Map<string, string> | undefined;
  hiddenSeasonSet: Set<string> | undefined;
}) {
  const colors = (colorsByStyle?.get(styleId) || []) as Array<{ id: string; color: string }>;
  if (!colors.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {colors.map((c) => {
        const seasonIds = (colorSeasons?.get(c.id) || []).filter((sid) => !(hiddenSeasonSet?.has(sid)));
        const labels = seasonIds.map((sid) => seasonCodeById?.get(sid) || sid);
        return (
          <Badge key={c.id}>
            <span className="text-[11px] text-gray-800">{c.color}</span>
            <span className="text-[10px] text-gray-500 ml-1">{labels.join(' / ') || '—'}</span>
          </Badge>
          );
        })}
    </div>
  );
}


