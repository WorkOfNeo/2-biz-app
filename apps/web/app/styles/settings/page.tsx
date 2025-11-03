'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';

export default function StylesSettingsPage() {
  const supabase = createClientComponentClient();
  const { has } = useRoles();
  const [runLoading, setRunLoading] = useState(false);
  const { data: styles } = useSWR('styles:all', async () => {
    const { data, error } = await supabase.from('styles').select('id, style_no, style_name, scrape_enabled, updated_at').order('style_no').limit(1000);
    if (error) throw new Error(error.message);
    return data as { id: string; style_no: string; style_name: string | null; scrape_enabled: boolean | null; updated_at: string }[];
  });
  const { data: colorsByStyle, mutate: mutateColors } = useSWR('style_colors:all', async () => {
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
  const { data: selectionMap, mutate: mutateSelection } = useSWR('app-settings:styles-user-selection', async () => {
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
    if (!q) return styles;
    return styles.filter((s) => (s.style_name || '').toLowerCase().includes(q) || (s.style_no || '').toLowerCase().includes(q));
  }, [styles, searchQuery]);

  // Load seasons per style for display (style_no -> seasons[])
  const { data: styleSeasons } = useSWR<Map<string, string[]>>('style_seasons', async () => {
    const { data, error } = await supabase.from('style_seasons').select('style_no, seasons');
    if (error) throw new Error(error.message);
    const map = new Map<string, string[]>();
    for (const r of (data ?? []) as any[]) map.set(r.style_no as string, Array.isArray(r.seasons) ? (r.seasons as string[]) : []);
    return map;
  });
  function formatSeasonsFor(styleNo: string): string {
    const arr = styleSeasons?.get(styleNo) || [];
    if (!arr || arr.length === 0) return '—';
    const first = String(arr[0] || '').trim();
    const m = first.match(/^(\d{2,4})\s+(.+)$/);
    const name = (m?.[2] ?? first).toString();
    const extra = arr.length > 1 ? ` +${arr.length - 1}` : '';
    return `${name}${extra}`;
  }
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

      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Your list for stock updates</div>
          <div className="flex items-center gap-2">
            <input
              className="text-xs border rounded px-2 py-1 w-56"
              placeholder="Search styles"
              value={searchQuery}
              onChange={(e)=>setSearchQuery(e.target.value)}
            />
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
                <th className="p-2 text-left border-b">Seasons</th>
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
                    <td className="p-2 border-b text-gray-700">{formatSeasonsFor(s.style_no)}</td>
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

      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Colors per style</div>
        </div>
        <div className="mt-3">
          <div className="text-[11px] text-gray-500 mb-2">Toggle scrape per color. Colors are discovered automatically during scrapes.</div>
          <div className="space-y-3 max-h-[600px] overflow-auto pr-1">
            {(styles ?? []).map((s) => {
              const list = (colorsByStyle?.get(s.id) ?? []).slice().sort((a,b)=>a.color.localeCompare(b.color));
              return (
                <details key={s.id} className="rounded border">
                  <summary className="cursor-pointer select-none px-3 py-2 font-medium">
                    {s.style_no} <span className="text-gray-500 font-normal">{s.style_name ?? ''}</span> <span className="text-[11px] text-gray-500">{list.length} colors</span>
                  </summary>
                  <div className="px-2 pb-2">
                    {list.length === 0 ? (
                      <div className="text-xs text-gray-500 px-2">No colors discovered yet.</div>
                    ) : (
                      <table className="min-w-full text-xs">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="p-2 text-left border-b">Color</th>
                            <th className="p-2 text-left border-b">Last Updated</th>
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((c) => (
                            <tr key={c.id}>
                              <td className="p-2 border-b font-medium">{c.color}</td>
                              <td className="p-2 border-b text-gray-500">{c.updated_at ? new Date(c.updated_at).toLocaleString() : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      </div>

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
                const res = await fetch('/api/enqueue', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                  body: JSON.stringify({ type: 'deep_scrape_styles', payload: { requestedBy: session.user.email } })
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
    </div>
  );
}


