'use client';
import { useParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

export default function SeasonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data: season } = useSWR(id ? `season:${id}` : null, async () => {
    const { data, error } = await supabase.from('seasons').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null; created_at: string };
  });
  const { data: rates, mutate } = useSWR(id ? `season:${id}:currency-rates` : null, async () => {
    const key = `currency_rates:${id}`;
    const { data, error } = await supabase.from('app_settings').select('id, value').eq('key', key).maybeSingle();
    if (error) throw new Error(error.message);
    const val = (data?.value as any) || {};
    return { id: data?.id ?? null, value: { EUR: Number(val.EUR || 0) || 0, NOK: Number(val.NOK || 0) || 0, SEK: Number(val.SEK || 0) || 0 } } as { id: string | null; value: Record<string, number> };
  });
  
  const [localRates, setLocalRates] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  
  useEffect(() => {
    if (rates?.value) {
      setLocalRates(rates.value);
      setHasChanges(false);
    }
  }, [rates?.value]);
  
  async function saveRates() {
    if (!id) return;
    setSaving(true);
    setSaveSuccess(false);
    try {
      const key = `currency_rates:${id}`;
      if (rates?.id) {
        await supabase.from('app_settings').update({ value: localRates }).eq('id', rates.id);
      } else {
        await supabase.from('app_settings').insert({ key, value: localRates });
      }
      await mutate();
      setHasChanges(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      alert(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }
  
  function handleRateChange(code: string, value: number) {
    setLocalRates(prev => ({ ...prev, [code]: value }));
    setHasChanges(true);
    setSaveSuccess(false);
  }
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Season</h2>
      {season && (
        <div className="border rounded-md p-4">
          <div><strong>Name:</strong> {season.name}</div>
          <div><strong>Year:</strong> {season.year ?? '-'}</div>
          <div><strong>Created:</strong> {new Date(season.created_at).toLocaleString()}</div>
        </div>
      )}
      <div className="border rounded-md p-4 space-y-3">
        <div className="text-sm font-medium text-gray-700">Currency conversion to DKK (for this season)</div>
        <div className="text-xs text-gray-500">Enter how many DKK equals 1 unit of the foreign currency.</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(['EUR','NOK','SEK'] as const).map((code) => (
            <label key={code} className="block text-sm">
              <div className="mb-1 text-gray-600">{code} → DKK</div>
              <input
                className="w-full rounded border px-2 py-1 text-sm"
                type="number"
                step="0.0001"
                value={localRates[code] ?? 0}
                onChange={(e) => {
                  const v = Number(e.target.value || 0) || 0;
                  handleRateChange(code, v);
                }}
              />
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={saveRates}
            disabled={!hasChanges || saving}
            className={
              'rounded-md px-4 py-2 text-sm font-medium transition-colors ' +
              (hasChanges && !saving
                ? 'bg-slate-900 text-white hover:bg-slate-800'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed')
            }
          >
            {saving ? 'Saving...' : 'Save Currency Rates'}
          </button>
          {saveSuccess && (
            <span className="text-sm text-green-600 font-medium">✓ Saved successfully!</span>
          )}
          {hasChanges && !saving && !saveSuccess && (
            <span className="text-sm text-amber-600">Unsaved changes</span>
          )}
        </div>
      </div>
    </div>
  );
}


