'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';

export default function StylesSettingsPage() {
  const supabase = createClientComponentClient();
  const { has } = useRoles();
  const isAdmin = has('admin');
  const [runLoading, setRunLoading] = useState(false);
  const { data: styles } = useSWR(isAdmin ? 'styles:all' : null, async () => {
    const { data, error } = await supabase.from('styles').select('id, style_no, style_name, scrape_enabled, updated_at').order('style_no').limit(1000);
    if (error) throw new Error(error.message);
    return data as { id: string; style_no: string; style_name: string | null; scrape_enabled: boolean | null; updated_at: string }[];
  });
  const { data: styleSeasons } = useSWR(isAdmin ? 'style_seasons:all' : null, async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons').limit(5000);
    if (error) throw new Error(error.message);
    const byStyle = new Map<string, string[]>();
    const labels = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      const arr = Array.isArray(r.seasons) ? (r.seasons as string[]) : [];
      byStyle.set(r.style_no, arr);
      for (const s of arr) labels.add(String(s));
    }
    return { byStyle, labels: Array.from(labels).sort() } as { byStyle: Map<string, string[]>; labels: string[] };
  }, { refreshInterval: 0 });
  const { data: seasonsMap } = useSWR(isAdmin ? 'seasons:map' : null, async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year').limit(5000);
    if (error) throw new Error(error.message);
    const m = new Map<string, string>();
    for (const r of (data ?? []) as any[]) {
      const n = (r.name as string | null) || '';
      const y = (r.year as number | null) || null;
      m.set(r.id as string, y ? `${n} ${y}` : n);
    }
    return m as Map<string, string>;
  }, { refreshInterval: 0 });
  const [seasonFilter, setSeasonFilter] = useState<string>('');
  const { data: colorsByStyle, mutate: mutateColors } = useSWR(isAdmin ? 'style_colors:all' : null, async () => {
    const { data, error } = await supabase.from('style_colors').select('id, style_id, color, scrape_enabled, updated_at').order('color').limit(5000);
    if (error) throw new Error(error.message);
    const map = new Map<string, Array<{ id: string; color: string; scrape_enabled: boolean | null; updated_at: string }>>();
    for (const r of (data ?? []) as any[]) {
      const arr = map.get(r.style_id) || [];
      arr.push({ id: r.id, color: r.color, scrape_enabled: r.scrape_enabled, updated_at: r.updated_at });
      map.set(r.style_id, arr);
    }
    return map;
  }, { refreshInterval: 0 });
  // Per-user selection map: { [user_id]: string[] }
  const { data: selectionMap, mutate: mutateSelection } = useSWR(isAdmin ? 'app-settings:styles-user-selection' : null, async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'styles_user_selection').maybeSingle();
    return { id: data?.id ?? null, value: ((data?.value as any) || {}) as Record<string, string[]> };
  });
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  (require('react') as typeof import('react')).useEffect(() => { (async () => { const { data: { session } } = await supabase.auth.getSession(); setCurrentUserId(session?.user?.id ?? null); })(); }, []);
  const selectedForUser = useMemo(() => {
    if (!currentUserId) return new Set<string>();
    const arr = selectionMap?.value?.[currentUserId] || [];
    return new Set<string>(arr);
  }, [selectionMap, currentUserId]);
  // Search by style name (and number)
  const [searchQuery, setSearchQuery] = useState('');
  const filteredStyles = useMemo(() => {
    if (!styles) return [] as { id: string; style_no: string; style_name: string | null; scrape_enabled: boolean | null; updated_at: string }[];
    const q = searchQuery.trim().toLowerCase();
    let base = styles;
    if (seasonFilter) {
      base = base.filter((s) => {
        const arr = styleSeasons?.byStyle.get(s.style_no) || [];
        return arr.includes(seasonFilter);
      });
    }
    if (!q) return base;
    return base.filter((s) => (s.style_name || '').toLowerCase().includes(q) || (s.style_no || '').toLowerCase().includes(q));
  }, [styles, searchQuery, seasonFilter, styleSeasons?.labels.length]);

  // (Seasons column removed)
  async function toggleStyleForUser(styleNo: string) {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    const list = new Set<string>(map[currentUserId] || []);
    if (list.has(styleNo)) list.delete(styleNo); else list.add(styleNo);
    map[currentUserId] = Array.from(list);
    const existsId = selectionMap?.id || null;
    if (existsId) await supabase.from('app_settings').update({ value: map }).eq('id', existsId as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }
  async function addAllFiltered() {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    const list = new Set<string>(map[currentUserId] || []);
    for (const s of filteredStyles) list.add(s.style_no);
    map[currentUserId] = Array.from(list);
    const existsId = selectionMap?.id || null;
    if (existsId) await supabase.from('app_settings').update({ value: map }).eq('id', existsId as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }
  async function clearAll() {
    if (!currentUserId) return;
    const map = { ...(selectionMap?.value || {}) } as Record<string, string[]>;
    map[currentUserId] = [];
    const existsId = selectionMap?.id || null;
    if (existsId) await supabase.from('app_settings').update({ value: map }).eq('id', existsId as any);
    else await supabase.from('app_settings').insert({ key: 'styles_user_selection', value: map } as any);
    await mutateSelection();
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      {!isAdmin && (
        <div className="rounded-md border bg-white p-3 text-sm text-gray-600">Not authorized.</div>
      )}

      {isAdmin && (
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Often Scraped Styles</div>
          <div className="flex items-center gap-2">
            <input
              className="text-xs border rounded px-2 py-1 w-56"
              placeholder="Search styles"
              value={searchQuery}
              onChange={(e)=>setSearchQuery(e.target.value)}
            />
            <select className="text-xs border rounded px-2 py-1" value={seasonFilter} onChange={(e)=>setSeasonFilter(e.target.value)}>
              <option value="">All seasons</option>
              {(styleSeasons?.labels || []).map((label) => (
                <option key={label} value={label}>{seasonsMap?.get(label) ? `${label} — ${seasonsMap.get(label)}` : label}</option>
              ))}
            </select>
            <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={addAllFiltered}>Add all</button>
          </div>
        </div>
        <div className="mt-3 max-h-96 overflow-auto border rounded">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-2 text-left border-b">Action</th>
                <th className="p-2 text-left border-b">Style No.</th>
                <th className="p-2 text-left border-b">Style Name</th>
              </tr>
            </thead>
            <tbody>
              {(filteredStyles ?? []).map((s) => {
                const added = selectedForUser.has(s.style_no);
                return (
                  <tr key={s.style_no} className={(added ? 'bg-slate-50 ' : '') + 'hover:bg-slate-50 transition-colors'}>
                    <td className="p-2 border-b align-middle">
                      <button
                        className={(added ? 'bg-slate-300 text-gray-800 ' : 'bg-slate-900 text-white ') + 'text-xs px-2 py-1 rounded border'}
                        onClick={async ()=>{ await toggleStyleForUser(s.style_no); }}
                      >{added ? 'Added' : 'Add to list'}</button>
                    </td>
                    <td className={(added ? 'border-l-4 border-l-slate-900 ' : '') + 'p-2 border-b font-medium'}>{s.style_no}</td>
                    <td className="p-2 border-b text-gray-700">{s.style_name ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {has('admin') && (
          <div className="flex justify-end mt-2">
            <button className="text-xs text-gray-600 hover:text-black underline" onClick={clearAll}>Clear</button>
          </div>
        )}
      </div>
      )}

      {/* Colors per style removed */}

      {isAdmin && (
      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium">Style Lists</div>
        <StyleListsEditor styles={styles ?? []} />
      </div>
      )}

      {isAdmin && (
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Runs</div>
          <button
            className={"text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800 " + (runLoading ? 'opacity-60 cursor-not-allowed' : '')}
            disabled={runLoading}
            onClick={async () => {
              setRunLoading(true);
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
                console.log('[styles-settings] enqueue update_style_stock', res.status, js);
                try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('job-started', { detail: { label: 'Update style stock — job started' } })); } catch {}
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[styles-settings] enqueue error', e);
              }
              setRunLoading(false);
            }}
          >
            Update Stock
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-600">Runs use the selection above.</div>
      </div>
      )}

      {isAdmin && (
      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Deep Scrape</div>
          <button
            className={"text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800 " + (runLoading ? 'opacity-60 cursor-not-allowed' : '')}
            disabled={runLoading}
            onClick={async () => {
              setRunLoading(true);
              try {
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) throw new Error('Not signed in');
                // Resolve current season
                const { data: current } = await supabase.from('seasons').select('id, spy_season_id').eq('is_current', true).maybeSingle();
                const seasonId = (current as any)?.id as string | undefined;
                const spySeasonId = Number((current as any)?.spy_season_id || 0) || null;
                if (!seasonId) throw new Error('No current season set');
                if (!spySeasonId) { alert('Current season has no SPY mapping yet. Please run Seasons scrape to map spy_season_id.'); return; }
                const res = await fetch('/api/enqueue', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                  body: JSON.stringify({ type: 'deep_scrape_styles', payload: { requestedBy: session.user.email, seasonId } })
                });
                const js = await res.json().catch(() => ({}));
                // eslint-disable-next-line no-console
                console.log('[styles-settings] enqueue deep_scrape_styles', res.status, js);
                try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('job-started', { detail: { label: 'Deep scrape styles — job started' } })); } catch {}
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[styles-settings] enqueue error', e);
              }
              setRunLoading(false);
            }}
          >
            Deep Scrape All
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-600">Opens each style and reads materials season per color.</div>
      </div>
      )}
    </div>
  );
}


function StyleListsEditor({ styles }: { styles: { id: string; style_no: string; style_name: string | null; scrape_enabled: boolean | null; updated_at: string }[] }) {
  const supabase = createClientComponentClient();
  const React = require('react') as typeof import('react');
  const { data, mutate } = useSWR('app-settings:style-lists', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'style_lists').maybeSingle();
    const id = (data as any)?.id as string | null;
    const value = (((data as any)?.value || {}) as { lists?: Record<string, string[]> }) || {};
    const lists = value.lists || {};
    return { id, lists } as { id: string | null; lists: Record<string, string[]> };
  });
  const [active, setActive] = React.useState<string>('');
  React.useEffect(() => {
    if (!active && data) {
      const names = Object.keys(data.lists || {});
      const first = (names.length > 0 ? names[0] : '') as string;
      if (first) setActive(first);
    }
  }, [data, active]);
  const [newList, setNewList] = React.useState('');
  const [query, setQuery] = React.useState('');
  // Load style seasons to enable season filtering in the lists editor
  const { data: styleSeasons } = useSWR('style_seasons:for-lists', async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons').limit(5000);
    if (error) throw new Error(error.message);
    const byStyle = new Map<string, string[]>();
    const labels = new Set<string>();
    for (const r of (data ?? []) as any[]) {
      const arr = Array.isArray(r.seasons) ? (r.seasons as string[]) : [];
      byStyle.set(r.style_no, arr);
      for (const s of arr) labels.add(String(s));
    }
    return { byStyle, labels: Array.from(labels).sort() } as { byStyle: Map<string, string[]>; labels: string[] };
  }, { refreshInterval: 0 });
  const { data: seasonsMap } = useSWR('seasons:map-for-lists', async () => {
    const { data, error } = await supabase.from('seasons').select('id, name, year').limit(5000);
    if (error) throw new Error(error.message);
    const m = new Map<string, string>();
    for (const r of (data ?? []) as any[]) {
      const n = (r.name as string | null) || '';
      const y = (r.year as number | null) || null;
      m.set(r.id as string, y ? `${n} ${y}` : n);
    }
    return m as Map<string, string>;
  }, { refreshInterval: 0 });
  const [seasonFilter, setSeasonFilter] = React.useState<string>('');
  const filteredStyles = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = styles;
    if (seasonFilter) {
      base = base.filter((s) => {
        const arr = styleSeasons?.byStyle.get(s.style_no) || [];
        return arr.includes(seasonFilter);
      });
    }
    if (!q) return base;
    return base.filter((s) => (s.style_name || '').toLowerCase().includes(q) || (s.style_no || '').toLowerCase().includes(q));
  }, [styles, query, seasonFilter, styleSeasons?.labels.length]);
  async function save(next: Record<string, string[]>) {
    const existsId = data?.id || null;
    const payload = { key: 'style_lists', value: { lists: next } } as any;
    if (existsId) await supabase.from('app_settings').update({ value: payload.value }).eq('id', existsId as any);
    else await supabase.from('app_settings').insert(payload);
    await mutate();
  }
  function addList() {
    const name = newList.trim();
    if (!name) return;
    const next = { ...(data?.lists || {}) } as Record<string, string[]>;
    if (!next[name]) next[name] = [];
    save(next);
    setActive(name);
    setNewList('');
  }
  function removeFromList(styleNo: string) {
    const next = { ...(data?.lists || {}) } as Record<string, string[]>;
    const list = new Set(next[active] || []);
    list.delete(styleNo);
    next[active] = Array.from(list);
    save(next);
  }
  function addToList(styleNo: string) {
    const next = { ...(data?.lists || {}) } as Record<string, string[]>;
    const list = new Set(next[active] || []);
    list.add(styleNo);
    next[active] = Array.from(list);
    save(next);
  }
  function clearList() {
    if (!active) return;
    const next = { ...(data?.lists || {}) } as Record<string, string[]>;
    next[active] = [];
    save(next);
  }
  function addAllFilteredToList() {
    if (!active) return;
    const next = { ...(data?.lists || {}) } as Record<string, string[]>;
    const list = new Set(next[active] || []);
    for (const s of filteredStyles) list.add(s.style_no);
    next[active] = Array.from(list);
    save(next);
  }
  const listItems = (data?.lists?.[active] || []) as string[];
  const styleNoToName = React.useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of styles) m.set(s.style_no, s.style_name);
    return m;
  }, [styles]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-xs">Lists:</div>
        <div className="flex flex-wrap gap-2">
          {Object.keys(data?.lists || {}).map((name) => (
            <button key={name} className={(active===name?'bg-slate-900 text-white ':'bg-white text-slate-900 ') + 'text-xs px-2 py-1 border rounded'} onClick={()=>setActive(name)}>{name}</button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input className="text-xs border rounded px-2 py-1" value={newList} onChange={(e)=>setNewList(e.target.value)} placeholder="New list name" />
        <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white" onClick={addList}>Add list</button>
      </div>
      {active && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded border p-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-medium">In “{active}”</div>
              <button
                className="text-[11px] underline disabled:text-gray-400"
                onClick={clearList}
                disabled={!active || listItems.length === 0}
              >Remove all styles</button>
            </div>
            <div className="space-y-1 max-h-64 overflow-auto">
              {listItems.length === 0 && <div className="text-[11px] text-gray-500">No styles yet.</div>}
              {listItems.map((no) => (
                <div key={no} className="flex items-center justify-between text-xs border rounded px-2 py-1">
                  <span>{no}{styleNoToName.get(no) ? ` — ${styleNoToName.get(no)}` : ''}</span>
                  <button className="underline" onClick={()=>removeFromList(no)}>Remove</button>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium">All styles</div>
              <div className="flex items-center gap-2">
                <input className="text-xs border rounded px-2 py-1" placeholder="Search styles" value={query} onChange={(e)=>setQuery(e.target.value)} />
                <select className="text-xs border rounded px-2 py-1" value={seasonFilter} onChange={(e)=>setSeasonFilter(e.target.value)}>
                  <option value="">All seasons</option>
                  {(styleSeasons?.labels || []).map((label) => (
                    <option key={label} value={label}>{seasonsMap?.get(label) ? `${label} — ${seasonsMap.get(label)}` : label}</option>
                  ))}
                </select>
                <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white" onClick={addAllFilteredToList} disabled={!active}>Add all</button>
              </div>
            </div>
            <div className="mt-1 max-h-64 overflow-auto space-y-1">
              {filteredStyles.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-xs border rounded px-2 py-1">
                  <span>{s.style_no} {s.style_name ? `— ${s.style_name}` : ''}</span>
                  <button className="underline" onClick={()=>addToList(s.style_no)}>Add</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

