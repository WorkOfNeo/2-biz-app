'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function StylesSettingsPage() {
  const supabase = createClientComponentClient();
  const [runLoading, setRunLoading] = useState(false);
  const { data: styles } = useSWR('styles:all', async () => {
    const { data, error } = await supabase.from('styles').select('style_no, style_name').order('style_no').limit(1000);
    if (error) throw new Error(error.message);
    return data as { style_no: string; style_name: string | null }[];
  });
  const { data: selected } = useSWR('app-settings:styles-daily-selection', async () => {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'styles_daily_selection').maybeSingle();
    return ((data?.value as any)?.styleNos as string[] | undefined) ?? [];
  });
  const [local, setLocal] = useState<string[] | null>(null);
  const current = (local ?? selected ?? []) as string[];
  const allNos = useMemo(() => new Set((styles ?? []).map(s => s.style_no)), [styles]);
  const allSelected = current.length > 0 && current.length === allNos.size;

  function toggleOne(no: string) {
    setLocal((prev) => {
      const arr = prev ? [...prev] : [...(selected ?? [])];
      const idx = arr.indexOf(no);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(no);
      return arr;
    });
  }

  function toggleAll() {
    setLocal((prev) => {
      if (allSelected) return [];
      return Array.from(allNos);
    });
  }

  async function save() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const body = { key: 'styles_daily_selection', value: { styleNos: current } };
      // upsert into app_settings
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'styles_daily_selection').maybeSingle();
      if (existing?.id) {
        await supabase.from('app_settings').update({ value: body.value }).eq('id', existing.id as string);
      } else {
        await supabase.from('app_settings').insert(body as any);
      }
      // eslint-disable-next-line no-console
      console.log('[styles-settings] saved', current.length);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[styles-settings] save error', e);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Styles</div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="rounded-md border bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Daily update selection</div>
          <div className="flex items-center gap-2">
            <button className="text-xs px-2 py-1 border rounded hover:bg-gray-50" onClick={toggleAll}>{allSelected ? 'Unselect all' : 'Select all'}</button>
            <button className="text-xs px-2 py-1 border rounded bg-slate-900 text-white hover:bg-slate-800" onClick={save}>Save</button>
          </div>
        </div>
        <div className="mt-3 max-h-96 overflow-auto border rounded">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-2 text-left border-b">Select</th>
                <th className="p-2 text-left border-b">Style No.</th>
                <th className="p-2 text-left border-b">Style Name</th>
              </tr>
            </thead>
            <tbody>
              {(styles ?? []).map((s) => {
                const checked = current.includes(s.style_no);
                return (
                  <tr
                    key={s.style_no}
                    onClick={() => toggleOne(s.style_no)}
                    className={(checked ? 'bg-slate-50 ' : '') + 'hover:bg-slate-50 cursor-pointer transition-colors'}
                  >
                    <td className="p-2 border-b align-middle">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(s.style_no)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 accent-slate-900 rounded"
                      />
                    </td>
                    <td className={(checked ? 'border-l-4 border-l-slate-900 ' : '') + 'p-2 border-b font-medium'}>{s.style_no}</td>
                    <td className="p-2 border-b text-gray-700">{s.style_name ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
    </div>
  );
}


