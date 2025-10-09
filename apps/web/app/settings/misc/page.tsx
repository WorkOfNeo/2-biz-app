'use client';
import useSWR from 'swr';
import { useState, useEffect } from 'react';
import { supabase } from '../../../lib/supabaseClient';

export default function MiscSettingsPage() {
  const { data, mutate } = useSWR('app-settings:base-currency', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'base_currency').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: { code: string } } | null;
  });
  const [currency, setCurrency] = useState('DKK');
  useEffect(() => {
    if (data?.value?.code) setCurrency(data.value.code);
  }, [data?.id]);
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Misc</h2>
      <div className="border rounded-md p-4 space-y-2">
        <div className="text-sm text-gray-600">Base currency</div>
        <div className="flex items-center gap-2">
          <select className="rounded border px-2 py-1.5 text-sm" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {['DKK','SEK','NOK','EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            onClick={async () => {
              const value = { code: currency };
              if (data) await supabase.from('app_settings').update({ value }).eq('id', data.id);
              else await supabase.from('app_settings').insert({ key: 'base_currency', value });
              await mutate();
            }}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

