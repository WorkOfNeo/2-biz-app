'use client';
import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import useSWR from 'swr';

export default function SeasonsSettingsPage() {
  const { data: seasons, mutate } = useSWR('seasons', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null; created_at: string }[];
  });
  const { data: savedCompare, mutate: mutateCompare } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const [name, setName] = useState('');
  const [year, setYear] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');

  useEffect(() => {
    if (savedCompare?.value) {
      setS1(savedCompare.value.s1 ?? '');
      setS2(savedCompare.value.s2 ?? '');
    }
  }, [savedCompare?.id]);
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Seasons</h2>

      {/* General statistics comparison selection */}
      <div className="border rounded-md p-4 space-y-3">
        <div className="text-sm font-medium text-gray-700">General statistics comparison</div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="text-sm text-gray-600">Season 1</label>
            <select className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm" value={s1} onChange={(e) => setS1(e.target.value)}>
              <option value="">—</option>
              {(seasons ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
              ))}
            </select>
          </div>
          <div className="hidden text-gray-500 sm:block">vs</div>
          <div className="flex-1 min-w-[220px]">
            <label className="text-sm text-gray-600">Season 2</label>
            <select className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm" value={s2} onChange={(e) => setS2(e.target.value)}>
              <option value="">—</option>
              {(seasons ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
              ))}
            </select>
          </div>
          <button
            className="ml-auto inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            disabled={!s1 && !s2}
            onClick={async () => {
              const value = { s1, s2 };
              try {
                if (savedCompare) {
                  const { error } = await supabase.from('app_settings').update({ value }).eq('id', savedCompare.id);
                  if (error) throw new Error(error.message);
                } else {
                  const { error } = await supabase.from('app_settings').insert({ key: 'season_compare', value });
                  if (error) throw new Error(error.message);
                }
                await mutateCompare();
              } catch (err: any) {
                alert(err?.message || 'Failed to save');
              }
            }}
          >Save</button>
        </div>
      </div>
      <div className="border rounded-md p-4 space-y-2">
        <div className="text-sm text-gray-600">Add a new season</div>
        <div className="flex items-center gap-2">
          <input className="border rounded p-2 text-sm" placeholder="e.g. AW" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="border rounded p-2 text-sm w-24" placeholder="Year" type="number" value={year} onChange={(e) => setYear(e.target.value ? Number(e.target.value) : '')} />
          <button
            disabled={saving || !name.trim()}
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            onClick={async () => {
              try {
                setSaving(true);
                const { error } = await supabase.from('seasons').insert({ name, year: year === '' ? null : year });
                if (error) throw new Error(error.message);
                setName(''); setYear('');
                mutate();
              } finally {
                setSaving(false);
              }
            }}
          >Add</button>
        </div>
      </div>
      <div className="overflow-auto border rounded-md">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-2 border-b">Name</th>
              <th className="text-left p-2 border-b">Year</th>
              <th className="text-left p-2 border-b">Display Currency</th>
              <th className="text-left p-2 border-b">Created</th>
            </tr>
          </thead>
          <tbody>
            {(seasons ?? []).map((s) => (
              <tr key={s.id}>
                <td className="p-2 border-b">{s.name}</td>
                <td className="p-2 border-b">{s.year ?? '-'}</td>
                <td className="p-2 border-b">
                  <select
                    className="rounded border px-2 py-1 text-sm"
                    defaultValue={(s as any).display_currency ?? ''}
                    onChange={async (e) => {
                      const val = e.target.value || null;
                      const { error } = await supabase.from('seasons').update({ display_currency: val }).eq('id', s.id);
                      if (!error) mutate();
                    }}
                  >
                    <option value="">(default)</option>
                    {['DKK','SEK','NOK','EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="p-2 border-b">{new Date(s.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

