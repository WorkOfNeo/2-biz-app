'use client';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import Link from 'next/link';

export default function StatisticsGeneralPage() {
  const { data: seasons } = useSWR('seasons-all', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null }[];
  });
  const { data: saved } = useSWR('app-settings:season-compare', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'season_compare').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { s1?: string; s2?: string } } | null;
  });
  const [s1, setS1] = useState<string>('');
  const [s2, setS2] = useState<string>('');
  const [showSave, setShowSave] = useState(false);
  useEffect(() => {
    if (saved?.value) {
      setS1(saved.value.s1 ?? '');
      setS2(saved.value.s2 ?? '');
    }
  }, [saved?.id]);
  useEffect(() => {
    if (s1 || s2) setShowSave(true);
  }, [s1, s2]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Statistics · General</h1>
        <div className="relative">
          <details>
            <summary className="list-none inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm">☰ Menu</summary>
            <div className="absolute right-0 mt-2 w-56 bg-white border rounded-md shadow">
              <Link className="block px-3 py-2 hover:bg-gray-50" href="/statistics/general/import">Import Statistic</Link>
            </div>
          </details>
        </div>
      </div>

      <div className="flex items-end gap-3">
        <div>
          <label className="text-sm">Season 1</label>
          <select className="mt-1 border rounded p-1 text-sm" value={s1} onChange={(e) => setS1(e.target.value)}>
            <option value="">—</option>
            {(seasons ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm">Season 2</label>
          <select className="mt-1 border rounded p-1 text-sm" value={s2} onChange={(e) => setS2(e.target.value)}>
            <option value="">—</option>
            {(seasons ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name} {s.year ?? ''}</option>
            ))}
          </select>
        </div>
        {showSave && (
          <button
            className="ml-auto text-sm underline"
            onClick={async () => {
              const value = { s1, s2 };
              if (saved) {
                await supabase.from('app_settings').update({ value }).eq('id', saved.id);
              } else {
                await supabase.from('app_settings').insert({ key: 'season_compare', value });
              }
              setShowSave(false);
            }}
          >Save to settings?</button>
        )}
      </div>

      <div className="mt-4 overflow-auto border rounded-md">
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <th className="text-left p-2 border-b">Customer</th>
              <th className="text-left p-2 border-b">City</th>
              <th className="text-left p-2 border-b">Season 1</th>
              <th className="text-left p-2 border-b">Season 2</th>
              <th className="text-left p-2 border-b">Development</th>
              <th className="text-left p-2 border-b">Actions</th>
            </tr>
            <tr className="bg-gray-50">
              <th className="text-left p-2 border-b"></th>
              <th className="text-left p-2 border-b"></th>
              <th className="text-left p-2 border-b">Qty · Price</th>
              <th className="text-left p-2 border-b">Qty · Price</th>
              <th className="text-left p-2 border-b">Qty · Price</th>
              <th className="text-left p-2 border-b">—</th>
            </tr>
          </thead>
          <tbody>
            {/* Placeholder rows; TBD: aggregate from season_statistics */}
            <tr>
              <td className="p-2 border-b">—</td>
              <td className="p-2 border-b">—</td>
              <td className="p-2 border-b">0 · 0</td>
              <td className="p-2 border-b">0 · 0</td>
              <td className="p-2 border-b">0 · 0</td>
              <td className="p-2 border-b">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}


