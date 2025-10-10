'use client';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../../lib/supabaseClient';

export default function SeasonLogsPage() {
  const params = useParams<{ id: string }>();
  const seasonId = params.id;

  const { data, error, isLoading } = useSWR(seasonId ? ['season-logs', seasonId] : null, async () => {
    // Fetch recent jobs that wrote to this season
    const { data: results, error: resErr } = await supabase
      .from('job_results')
      .select('job_id, summary, data, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (resErr) throw new Error(resErr.message);
    const filtered = (results ?? []).filter((r: any) => (r.data?.seasonId || r.data?.season_id) === seasonId);
    // Fetch overrides for this season
    const { data: overrides } = await supabase
      .from('app_settings')
      .select('id, key, value')
      .eq('key', `season_overrides:${seasonId}`)
      .maybeSingle();
    const value = (overrides?.value as any) || { qty_overrides: {}, price_overrides: {} };
    return { runs: filtered, overrides: { id: overrides?.id ?? null, value } } as { runs: any[]; overrides: { id: string | null; value: { qty_overrides?: Record<string, number>; price_overrides?: Record<string, number> } } };
  }, { refreshInterval: 10000 });

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Season logs</h2>
      {isLoading && <div>Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String(error)}</div>}

      {/* Overrides (read-only for now) */}
      <div className="border rounded p-4 space-y-3">
        <div className="text-sm text-gray-700">Overrides (read-only)</div>
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">Account</th>
                <th className="text-left p-2 border-b">Qty override</th>
                <th className="text-left p-2 border-b">Amount override</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const qty = (data?.overrides?.value?.qty_overrides ?? {}) as Record<string, number>;
                const price = (data?.overrides?.value?.price_overrides ?? {}) as Record<string, number>;
                const accounts = Array.from(new Set([...Object.keys(qty), ...Object.keys(price)]));
                if (accounts.length === 0) return (
                  <tr><td className="p-2" colSpan={3}>No overrides set for this season.</td></tr>
                );
                return accounts.map((a) => (
                  <tr key={a}>
                    <td className="p-2 border-b font-mono">{a}</td>
                    <td className="p-2 border-b">{qty[a] ?? '-'}</td>
                    <td className="p-2 border-b">{price[a] ?? '-'}</td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent runs for this season */}
      <div className="border rounded">
        <div className="px-3 py-2 font-semibold bg-gray-50">Recent runs</div>
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">Job</th>
                <th className="text-left p-2 border-b">Created</th>
                <th className="text-left p-2 border-b">Rows upserted</th>
                <th className="text-left p-2 border-b">Samples</th>
              </tr>
            </thead>
            <tbody>
              {(data?.runs ?? []).map((r: any) => (
                <tr key={r.job_id}>
                  <td className="p-2 border-b"><a className="underline" href={`/admin/jobs/${r.job_id}`} target="_blank" rel="noreferrer">{r.job_id.slice(0,8)}…</a></td>
                  <td className="p-2 border-b whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="p-2 border-b">{r.data?.rowsUpserted ?? '-'}</td>
                  <td className="p-2 border-b text-xs">
                    {Array.isArray(r.data?.samples) ? r.data.samples.map((s: any) => s.salesperson).slice(0, 5).join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


