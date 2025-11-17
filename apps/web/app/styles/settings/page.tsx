'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';
import { ProgressBar } from '../../../components/ProgressBar';

export default function StylesSettingsPage() {
  const supabase = createClientComponentClient();
  const { has } = useRoles();
  const isAdmin = has('admin');
  const [runLoading, setRunLoading] = useState(false);
  // Deep scrape progress
  const [deepJobId, setDeepJobId] = useState<string | null>(null);
  const [deepProgress, setDeepProgress] = useState<{ index: number; total: number } | null>(null);
  const [deepDone, setDeepDone] = useState(false);
  const { data: styles } = useSWR(isAdmin ? 'styles:all' : null, async () => {
    const { data, error } = await supabase.from('styles').select('id, style_no, style_name, style_type, supplier, scrape_enabled, updated_at').order('style_no').limit(2000);
    if (error) throw new Error(error.message);
    return data as { id: string; style_no: string; style_name: string | null; style_type: string | null; supplier: string | null; scrape_enabled: boolean | null; updated_at: string }[];
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
    const pageSize = 1000;
    async function loadPaged(selectCols: string) {
      const all: any[] = [];
      let from = 0;
      while (true) {
        const to = from + pageSize - 1;
        // Primary attempt: order by color with range pagination
        const { data, error } = await supabase
          .from('style_colors')
          .select(selectCols)
          .order('color', { ascending: true })
          .range(from, to);
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[styles-settings] style_colors loadPaged error (ordered/ranged)', error);
          throw error;
        }
        const batch = (data ?? []) as any[];
        all.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return all;
    }
    try {
      const rows = await loadPaged('id, style_id, color, visible, updated_at');
      const map = new Map<string, Array<{ id: string; color: string; visible: boolean | null; updated_at: string }>>();
      for (const r of rows) {
        const arr = map.get(r.style_id) || [];
        arr.push({ id: r.id, color: r.color, visible: (r.visible as boolean | null) ?? null, updated_at: r.updated_at });
        map.set(r.style_id, arr);
      }
      return map;
    } catch (e1) {
      // eslint-disable-next-line no-console
      console.warn('[styles-settings] style_colors fallback without "visible" column', e1);
      // Fallback 1: when 'visible' column not present; default to null
      try {
        const rows = await loadPaged('id, style_id, color, updated_at');
        const map = new Map<string, Array<{ id: string; color: string; visible: boolean | null; updated_at: string }>>();
        for (const r of rows) {
          const arr = map.get(r.style_id) || [];
          arr.push({ id: r.id, color: r.color, visible: null, updated_at: r.updated_at });
          map.set(r.style_id, arr);
        }
        return map;
      } catch (e2) {
        // eslint-disable-next-line no-console
        console.warn('[styles-settings] style_colors fallback without order/range', e2);
        // Fallback 2: as a last resort, avoid order/range entirely
        const { data, error } = await supabase
          .from('style_colors')
          .select('id, style_id, color, visible, updated_at');
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[styles-settings] style_colors final fetch failed', error);
          throw error;
        }
        const map = new Map<string, Array<{ id: string; color: string; visible: boolean | null; updated_at: string }>>();
    for (const r of (data ?? []) as any[]) {
      const arr = map.get(r.style_id) || [];
          arr.push({ id: r.id, color: r.color, visible: (r.visible as boolean | null) ?? null, updated_at: r.updated_at });
      map.set(r.style_id, arr);
    }
    return map;
      }
    }
  }, { refreshInterval: 0 });
  // Removed global color editor from this section
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
    return base.filter((s) => {
      const name = (s.style_name || '').toLowerCase();
      const no = (s.style_no || '').toLowerCase();
      const type = (s as any).style_type ? String((s as any).style_type).toLowerCase() : '';
      return name.includes(q) || no.includes(q) || type.includes(q);
    });
  }, [styles, searchQuery, seasonFilter, styleSeasons?.labels.length]);

  // (Seasons column removed)
  // Poll deep scrape job logs to show progress
  (require('react') as typeof import('react')).useEffect(() => {
    if (!deepJobId) return;
    let timer: any;
    const poll = async () => {
      try {
        const { data: logs } = await supabase
          .from('job_logs')
          .select('msg, data')
          .eq('job_id', deepJobId)
          .order('ts', { ascending: false })
          .limit(50);
        for (const l of (logs ?? []) as any[]) {
          if (l.msg === 'STEP:deep_styles_progress' && l.data) {
            setDeepProgress({ index: Number(l.data.index || 0), total: Number(l.data.total || 0) });
            break;
          }
          if (l.msg === 'STEP:complete') {
            setDeepDone(true);
            break;
          }
        }
        // Also check job status to stop when finished
        const { data: jobRow } = await supabase.from('jobs').select('status').eq('id', deepJobId).maybeSingle();
        const st = (jobRow as any)?.status as string | undefined;
        if (st === 'succeeded' || st === 'failed' || st === 'cancelled') {
          setDeepDone(true);
        }
      } catch {}
    };
    timer = setInterval(poll, 1200);
    return () => { if (timer) clearInterval(timer); };
  }, [deepJobId]);
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
                <th className="p-2 text-left border-b">Name</th>
                <th className="p-2 text-left border-b">Type</th>
                <th className="p-2 text-left border-b">Supplier</th>
                <th className="p-2 text-left border-b">Colors</th>
              </tr>
            </thead>
            <tbody>
              {(filteredStyles as any[] ?? []).map((s) => {
                const added = selectedForUser.has(s.style_no);
                return (
                  <>
                  <tr key={s.id} className={(added ? 'bg-slate-50 ' : '') + 'hover:bg-slate-50 transition-colors'}>
                    <td className="p-2 border-b align-middle">
                      <button
                        className={(added ? 'bg-slate-300 text-gray-800 ' : 'bg-slate-900 text-white ') + 'text-xs px-2 py-1 rounded border'}
                        onClick={async ()=>{ await toggleStyleForUser(s.style_no); }}
                      >{added ? 'Added' : 'Add to list'}</button>
                    </td>
                    <td className={(added ? 'border-l-4 border-l-slate-900 ' : '') + 'p-2 border-b font-medium'}>{s.style_no}</td>
                    <td className="p-2 border-b text-gray-700">
                      <div className="font-medium">{s.style_name ?? '—'}</div>
                    </td>
                    <td className="p-2 border-b text-gray-600 text-sm">{(s as any).style_type ?? '—'}</td>
                    <td className="p-2 border-b text-gray-600 text-sm">{s.supplier ?? '—'}</td>
                    <td className="p-2 border-b text-[11px] text-gray-500">—</td>
                  </tr>
                    {/* colors editor removed from this section */}
                  </>
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
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Style Lists</div>
          <Link href={{ pathname: '/styles/lists' }} className="text-[11px] underline">Open lists</Link>
        </div>
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
                if (js?.jobId) { setDeepJobId(js.jobId as string); setDeepProgress({ index: 0, total: 0 }); setDeepDone(false); }
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
        {deepJobId && (
          <div className="mt-2 flex items-center gap-2">
            <div className="w-56"><ProgressBar value={(() => {
              const p = deepProgress;
              if (!p || !p.total) return 5;
              return Math.max(5, Math.min(99, Math.round((p.index / p.total) * 100)));
            })()} /></div>
            <div>{deepProgress ? `${Math.min(deepProgress.index, deepProgress.total)}/${deepProgress.total || '?'}` : ''}{deepDone ? ' Done' : ''}</div>
          </div>
        )}
        <div className="mt-3">
          <button
            className="text-xs px-2 py-1 border rounded bg-white text-red-700 hover:bg-red-50"
            onClick={async () => {
              if (!confirm('Clear ALL seasons from style colors? This cannot be undone.')) return;
              try {
                const res = await fetch('/api/admin/clear-style-color-seasons?confirm=1', { method: 'POST' });
                if (!res.ok) {
                  const text = await res.text();
                  alert('Failed to clear: ' + text);
                  return;
                }
                alert('Cleared all style_color_seasons.');
              } catch (e: any) {
                alert('Error: ' + (e?.message || String(e)));
              }
            }}
          >
            Clear seasons (ALL)
          </button>
        </div>
        <div className="mt-4">
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
                  body: JSON.stringify({ type: 'scrape_eans', payload: { requestedBy: session.user.email } })
                });
                const js = await res.json().catch(() => ({}));
                // eslint-disable-next-line no-console
                console.log('[styles-settings] enqueue scrape_eans', res.status, js);
                try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('job-started', { detail: { label: 'Scrape EANs — job started' } })); } catch {}
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[styles-settings] enqueue error', e);
              }
              setRunLoading(false);
            }}
          >
            Scrape EANs
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

function ColorVisibilityEditor({ styleId }: { styleId: string }) {
  const supabase = createClientComponentClient();
  const React = require('react') as typeof import('react');
  const { data, mutate } = useSWR(styleId ? ['style_colors:editor', styleId] : null, async () => {
    async function loadWithVisible() {
      const { data, error } = await supabase
        .from('style_colors')
        .select('id, color, visible')
        .eq('style_id', styleId)
        .order('color', { ascending: true });
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[styles-settings] ColorVisibilityEditor loadWithVisible ordered error', error);
        throw error;
      }
      return (data ?? []) as Array<{ id: string; color: string; visible: boolean | null }>;
    }
    try {
      return await loadWithVisible();
    } catch (e1) {
      // eslint-disable-next-line no-console
      console.warn('[styles-settings] ColorVisibilityEditor fallback without visible/order', e1);
      // Fallback: avoid order first
      const { data, error } = await supabase
        .from('style_colors')
        .select('id, color')
        .eq('style_id', styleId);
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[styles-settings] ColorVisibilityEditor final fetch failed', error);
        throw error;
      }
      return ((data ?? []) as any[]).map((r) => ({ ...r, visible: null })) as Array<{ id: string; color: string; visible: boolean | null }>;
    }
  });
  return (
    <div className="flex flex-wrap gap-2">
      {(data ?? []).map((c) => {
        const checked = c.visible !== false;
        return (
          <label key={c.id} className="inline-flex items-center gap-1 border rounded px-1.5 py-0.5">
            <input
              type="checkbox"
              checked={checked}
              onChange={async (e) => {
                const next = e.target.checked;
                mutate((prev: any) => {
                  const arr = Array.isArray(prev) ? prev.map((row: any) => row.id === c.id ? { ...row, visible: next } : row) : prev;
                  return arr;
                }, false);
                try {
                  const { data: updated, error } = await supabase.from('style_colors').update({ visible: next }).eq('id', c.id).select('id, visible').maybeSingle();
                  if (error) throw error as any;
                  // eslint-disable-next-line no-console
                  console.log('[styles-settings] updated color visibility', { id: c.id, next, server: updated });
                  await mutate();
                } catch (err: any) {
                  alert(err?.message || 'Failed to update color visibility');
                  try { await mutate(); } catch {}
                }
              }}
            />
            <span className="text-[11px]">{c.color}</span>
          </label>
        );
      })}
    </div>
  );
}


function StyleListsEditor({ styles }: { styles: { id: string; style_no: string; style_name: string | null; scrape_enabled: boolean | null; updated_at: string }[] }) {
  const supabase = createClientComponentClient();
  const React = require('react') as typeof import('react');
  // Load lists from DB
  const { data: lists, mutate } = useSWR('stock-lists:all', async () => {
    const { data, error } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string }>;
  });
  const [activeId, setActiveId] = React.useState<string>('');
  const [activeName, setActiveName] = React.useState<string>('');
  React.useEffect(() => {
    if (!activeId && lists && (lists as any).length > 0) {
      const first = (lists as Array<{ id: string; name: string }>)[0] as { id: string; name: string } | undefined;
      if (first?.id) { setActiveId(first.id); setActiveName(first.name || ''); }
    }
  }, [lists, activeId]);
  const [newList, setNewList] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [openColorsFor, setOpenColorsFor] = React.useState<Record<string, boolean>>({});
  // Current list styles
  const { data: listStyleRows, mutate: mutateListStyles } = useSWR(activeId ? ['stock-list-styles:byList', activeId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_styles').select('style_id').eq('list_id', activeId);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ style_id: string }>;
  });
  const styleIdSet = React.useMemo(() => new Set((listStyleRows ?? []).map((r) => r.style_id)), [listStyleRows]);
  const filteredStyles = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let base = styles;
    // Exclude styles already in active list
    base = base.filter((s) => !styleIdSet.has(s.id));
    if (!q) return base;
    return base.filter((s) => (s.style_name || '').toLowerCase().includes(q) || (s.style_no || '').toLowerCase().includes(q));
  }, [styles, query, styleIdSet.size]);
  async function addList() {
    const name = newList.trim();
    if (!name) return;
    const { data: row, error } = await supabase.from('stock_lists').insert({ name }).select('id, name').maybeSingle();
    if (error) { alert(error.message); return; }
    await mutate();
    if (row?.id) { setActiveId(row.id); setActiveName(row.name || name); }
    setNewList('');
  }
  async function deleteList() {
    if (!activeId) return;
    if (!confirm(`Delete list “${activeName || activeId}”?`)) return;
    await supabase.from('stock_lists').delete().eq('id', activeId);
    await mutate();
    setActiveId('');
    setActiveName('');
  }
  async function removeFromList(styleId: string) {
    if (!activeId) return;
    await supabase.from('stock_list_styles').delete().eq('list_id', activeId).eq('style_id', styleId);
    await mutateListStyles();
  }
  async function addToList(styleId: string) {
    if (!activeId) return;
    await supabase.from('stock_list_styles').insert({ list_id: activeId, style_id: styleId });
    await mutateListStyles();
  }
  async function clearList() {
    if (!activeId) return;
    await supabase.from('stock_list_styles').delete().eq('list_id', activeId);
    await mutateListStyles();
  }
  async function addAllFilteredToList() {
    if (!activeId) return;
    const rows = filteredStyles.map((s) => ({ list_id: activeId, style_id: s.id }));
    if (rows.length === 0) return;
    await supabase.from('stock_list_styles').upsert(rows, { onConflict: 'list_id,style_id' as any });
    await mutateListStyles();
  }
  const styleNoToName = React.useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of styles) m.set(s.style_no, s.style_name);
    return m;
  }, [styles]);
  const styleNoToId = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of styles) m.set(s.style_no, s.id);
    return m;
  }, [styles]);
  const styleIdToNo = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of styles) m.set(s.id, s.style_no);
    return m;
  }, [styles]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-xs">Lists:</div>
        <div className="flex flex-wrap gap-2">
          {(lists ?? []).map((row) => (
            <button key={row.id} className={(activeId===row.id?'bg-slate-900 text-white ':'bg-white text-slate-900 ') + 'text-xs px-2 py-1 border rounded'} onClick={()=>{ setActiveId(row.id); setActiveName(row.name); }}>{row.name}</button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input className="text-xs border rounded px-2 py-1" value={newList} onChange={(e)=>setNewList(e.target.value)} placeholder="New list name" />
        <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white" onClick={addList}>Add list</button>
      </div>
      {activeId && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded border p-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-medium">In “{activeName || 'List'}”</div>
              <button
                className="text-[11px] underline disabled:text-gray-400"
                onClick={clearList}
                disabled={!activeId || (listStyleRows?.length || 0) === 0}
              >Remove all styles</button>
              <Link href={`/styles/lists/${activeId}` as any} className="text-[11px] underline">Open page</Link>
              <button
                className="text-[11px] underline text-red-700"
                onClick={deleteList}
              >Delete list</button>
            </div>
            <div className="space-y-1 max-h-64 overflow-auto">
              {(listStyleRows?.length || 0) === 0 && <div className="text-[11px] text-gray-500">No styles yet.</div>}
              {(listStyleRows || []).map((row) => {
                const no = styleIdToNo.get(row.style_id) || '';
                const styleId = row.style_id || '';
                const open = !!openColorsFor[no];
                return (
                  <div key={no} className="text-xs border rounded">
                    <div className="flex items-center justify-between px-2 py-1">
                      <span>{no}{no ? (styleNoToName.get(no) ? ` — ${styleNoToName.get(no)}` : '') : ''}</span>
                      <div className="flex items-center gap-3">
                        <button className="underline" onClick={()=>setOpenColorsFor((m)=>({ ...m, [no]: !open }))}>{open ? 'Hide colors' : 'Edit colors'}</button>
                        <button className="underline" onClick={()=>removeFromList(styleId)}>Remove</button>
                </div>
                    </div>
                    {open && styleId && (
                      <div className="px-2 pb-2">
                        <ListColorEditor listId={activeId} styleId={styleId} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium">All styles</div>
              <div className="flex items-center gap-2">
                <input className="text-xs border rounded px-2 py-1" placeholder="Search styles" value={query} onChange={(e)=>setQuery(e.target.value)} />
                <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white" onClick={addAllFilteredToList} disabled={!activeId}>Add all</button>
              </div>
            </div>
            <div className="mt-1 max-h-64 overflow-auto space-y-1">
              {filteredStyles.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-xs border rounded px-2 py-1">
                  <span>{s.style_no} {s.style_name ? `— ${s.style_name}` : ''}</span>
                  <button className="underline" onClick={()=>addToList(s.id)}>Add</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function ListColorEditor({ listId, styleId }: { listId: string; styleId: string }) {
  const supabase = createClientComponentClient();
  const React = require('react') as typeof import('react');
  // Load available colors for the style
  const { data: colors } = useSWR(styleId ? ['style_colors:for-style', styleId] : null, async () => {
    const { data, error } = await supabase.from('style_colors').select('id, color').eq('style_id', styleId).order('color', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; color: string }>;
  });
  // Load per-list color includes
  const { data: includes, mutate } = useSWR(listId && styleId ? ['stock_list_colors:includes', listId, styleId] : null, async () => {
    const { data, error } = await supabase.from('stock_list_colors').select('style_color_id, include').eq('list_id', listId).eq('style_id', styleId);
    if (error) throw error;
    const m = new Map<string, boolean>();
    for (const r of (data ?? []) as any[]) m.set(r.style_color_id as string, r.include !== false);
    return m as Map<string, boolean>;
  });
  const [savingAll, setSavingAll] = React.useState(false);
  const [savingById, setSavingById] = React.useState<Record<string, boolean>>({});
  const [lastSavedAt, setLastSavedAt] = React.useState<number | null>(null);
  const total = (colors?.length || 0);
  const includedCount = React.useMemo(() => {
    if (!colors) return 0;
    let n = 0;
    for (const c of colors) {
      const on = includes?.has(c.id) ? (includes.get(c.id) as boolean) : false;
      if (on) n++;
    }
    return n;
  }, [colors?.length, includes && Array.from((includes as Map<string, boolean>).entries()).map(([k,v])=>k+':'+String(v)).join(',')]);
  async function setInclude(styleColorId: string, next: boolean) {
    // optimistic update: clone map
    setSavingById((m) => ({ ...m, [styleColorId]: true }));
    await mutate((prev: any) => {
      const m = new Map<string, boolean>(prev as Map<string, boolean> | undefined);
      m.set(styleColorId, next);
      return m;
    }, false);
    try {
      await supabase.from('stock_list_colors').upsert({ list_id: listId, style_id: styleId, style_color_id: styleColorId, include: next } as any, { onConflict: 'list_id,style_color_id' as any });
      await mutate();
      setLastSavedAt(Date.now());
    } catch (err) {
      // revert
      await mutate();
    } finally {
      setSavingById((m) => {
        const copy = { ...m };
        delete copy[styleColorId];
        return copy;
      });
    }
  }
  async function addAll() {
    if (!colors?.length) return;
    // optimistic set all to true
    setSavingAll(true);
    await mutate((prev: any) => {
      const m = new Map<string, boolean>(prev as Map<string, boolean> | undefined);
      for (const c of colors) m.set(c.id, true);
      return m;
    }, false);
    try {
      const rows = colors.map((c) => ({ list_id: listId, style_id: styleId, style_color_id: c.id, include: true }));
      await supabase.from('stock_list_colors').upsert(rows, { onConflict: 'list_id,style_color_id' as any });
      await mutate();
      setLastSavedAt(Date.now());
    } catch (e) {
      await mutate();
    } finally {
      setSavingAll(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-gray-600">Included: <span className="font-medium text-black">{includedCount}</span> / {total}</div>
        <div>
          <button className={"text-[11px] underline " + (savingAll ? 'opacity-60 cursor-not-allowed' : '')} onClick={addAll} disabled={savingAll}>
            {savingAll ? 'Adding…' : 'Add all colors'}
          </button>
        </div>
      </div>
      {lastSavedAt && (
        <div className="text-[11px] text-green-700">Saved just now</div>
      )}
      <div className="flex flex-wrap gap-2">
        {(colors ?? []).map((c) => {
          const checked = includes?.has(c.id) ? (includes.get(c.id) as boolean) : false;
          const saving = !!savingById[c.id];
          return (
            <label key={c.id} className="inline-flex items-center gap-1 border rounded px-1.5 py-0.5">
              <input
                type="checkbox"
                checked={checked}
                disabled={saving}
                onChange={async (e) => {
                  const next = e.target.checked;
                  await setInclude(c.id, next);
                }}
              />
              <span className={"text-[11px] " + (saving ? 'opacity-60' : '')}>{c.color}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

