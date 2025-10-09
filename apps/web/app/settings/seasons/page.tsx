'use client';
import { useState } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import useSWR from 'swr';

export default function SeasonsSettingsPage() {
  const { data: seasons, mutate } = useSWR('seasons', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null; created_at: string }[];
  });
  const [name, setName] = useState('');
  const [year, setYear] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Seasons</h2>
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
              <th className="text-left p-2 border-b">Created</th>
            </tr>
          </thead>
          <tbody>
            {(seasons ?? []).map((s) => (
              <tr key={s.id}>
                <td className="p-2 border-b">{s.name}</td>
                <td className="p-2 border-b">{s.year ?? '-'}</td>
                <td className="p-2 border-b">{new Date(s.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

