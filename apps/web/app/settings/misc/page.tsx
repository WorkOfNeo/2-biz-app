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
  const { data: ratesRow, mutate: mutateRates } = useSWR('app-settings:currency-rates', async () => {
    const { data, error } = await supabase.from('app_settings').select('*').eq('key', 'currency_rates').maybeSingle();
    if (error) throw new Error(error.message);
    return data as { id: string; key: string; value: Record<string, number> } | null;
  });
  const [currency, setCurrency] = useState('DKK');
  const [rates, setRates] = useState<Record<string, number>>({ DKK: 1, SEK: 0.68, NOK: 0.64, EUR: 7.47 });
  useEffect(() => {
    if (data?.value?.code) setCurrency(data.value.code);
  }, [data?.id]);
  useEffect(() => {
    if (ratesRow?.value) setRates({ DKK: 1, SEK: 0.68, NOK: 0.64, EUR: 7.47, ...ratesRow.value });
  }, [ratesRow?.id]);
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

      <div className="border rounded-md p-4 space-y-2">
        <div className="text-sm text-gray-600">Base rates (1 unit equals how many DKK)</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(['DKK','SEK','NOK','EUR'] as const).map((c) => (
            <div key={c} className="space-y-1">
              <label className="text-xs text-gray-500">{c} → DKK</label>
              <input
                type="number"
                step="0.01"
                className="w-full rounded border px-2 py-1 text-sm"
                value={rates[c] ?? ''}
                onChange={(e) => setRates((prev) => ({ ...prev, [c]: Number(e.target.value) || 0 }))}
              />
            </div>
          ))}
        </div>
        <div>
          <button
            className="mt-2 inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            onClick={async () => {
              const value = rates;
              if (ratesRow) await supabase.from('app_settings').update({ value }).eq('id', ratesRow.id);
              else await supabase.from('app_settings').insert({ key: 'currency_rates', value });
              await mutateRates();
            }}
          >Save rates</button>
        </div>
      </div>
    </div>
  );
}

