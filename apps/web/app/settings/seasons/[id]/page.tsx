'use client';
import { useParams } from 'next/navigation';
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
  async function saveRates(next: Record<string, number>) {
    if (!id) return;
    const key = `currency_rates:${id}`;
    if (rates?.id) {
      await supabase.from('app_settings').update({ value: next }).eq('id', rates.id);
    } else {
      await supabase.from('app_settings').insert({ key, value: next });
    }
    await mutate();
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
                defaultValue={rates?.value?.[code] ?? 0}
                onBlur={async (e) => {
                  try {
                    const v = Number(e.target.value || 0) || 0;
                    const next = { ...(rates?.value || {}), [code]: v };
                    await saveRates(next);
                  } catch (err: any) {
                    alert(err?.message || 'Failed to save');
                  }
                }}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}


