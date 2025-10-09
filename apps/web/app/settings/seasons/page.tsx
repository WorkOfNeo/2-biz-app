'use client';
import { useState } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import useSWR from 'swr';

export default function SeasonsSettingsPage() {
  const { data: seasons, mutate } = useSWR('seasons', async () => {
    const { data, error } = await supabase.from('seasons').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; created_at: string }[];
  });
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Seasons</h2>
      <div className="border rounded-md p-4 space-y-2">
        <div className="text-sm text-gray-600">Add a new season</div>
        <div className="flex items-center gap-2">
          <input className="border rounded p-2 text-sm" placeholder="e.g. AW2025" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            disabled={saving || !name.trim()}
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            onClick={async () => {
              try {
                setSaving(true);
                const { data: { session } } = await supabase.auth.getSession();
                if (!session) throw new Error('Not signed in');
                // service role needed for insert; here we can call orchestrator or create a secured RPC later.
                // For now, insert is blocked for anon; show message.
                const res = await fetch(`${process.env.NEXT_PUBLIC_ORCHESTRATOR_URL}/health`);
                if (!res.ok) throw new Error('Orchestrator reachable check failed');
                const { error } = await supabase.from('seasons').insert({ name });
                if (error) throw new Error(error.message);
                setName('');
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
              <th className="text-left p-2 border-b">Created</th>
            </tr>
          </thead>
          <tbody>
            {(seasons ?? []).map((s) => (
              <tr key={s.id}>
                <td className="p-2 border-b">{s.name}</td>
                <td className="p-2 border-b">{new Date(s.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

