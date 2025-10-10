'use client';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../../lib/supabaseClient';

export default function SeasonLogsPage() {
  const params = useParams<{ id: string }>();
  const seasonId = params.id;

  const { data, error, isLoading, mutate } = useSWR(seasonId ? ['season-logs', seasonId] : null, async () => {
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

  async function saveOverrides(next: { qty_overrides?: Record<string, number>; price_overrides?: Record<string, number> }) {
    const key = `season_overrides:${seasonId}`;
    const existing = data?.overrides?.id;
    if (existing) {
      const { error } = await supabase.from('app_settings').update({ value: next }).eq('id', existing);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from('app_settings').insert({ key, value: next });
      if (error) throw new Error(error.message);
    }
    mutate();
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Season logs</h2>
      {isLoading && <div>Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String(error)}</div>}

      {/* Override form */}
      <div className="border rounded p-4 space-y-3">
        <div className="text-sm text-gray-700">Overrides (force values regardless of scrape)</div>
        <div className="text-xs text-gray-500">Enter account numbers with Qty and Amount. These will override display and calculations.</div>
        <OverridesEditor
          initialQty={data?.overrides?.value?.qty_overrides ?? {}}
          initialPrice={data?.overrides?.value?.price_overrides ?? {}}
          onSave={saveOverrides}
        />
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

function OverridesEditor({ initialQty, initialPrice, onSave }: { initialQty: Record<string, number>; initialPrice: Record<string, number>; onSave: (v: { qty_overrides?: Record<string, number>; price_overrides?: Record<string, number> }) => Promise<void> }) {
  const [rows, setRows] = (function init() {
    const accounts = Array.from(new Set([...Object.keys(initialQty || {}), ...Object.keys(initialPrice || {})]));
    return useSWR.mutate ? useState(accounts.map((a) => ({ account: a, qty: initialQty?.[a] ?? '', amount: initialPrice?.[a] ?? '' })))[0] : useState([] as any)[0];
  })();
  const [state, setState] = useState(rows.length > 0 ? rows : [{ account: '', qty: '', amount: '' }]);

  return (
    <div className="space-y-2">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left p-2 border-b">Account</th>
            <th className="text-left p-2 border-b">Qty</th>
            <th className="text-left p-2 border-b">Amount</th>
            <th className="text-left p-2 border-b">Actions</th>
          </tr>
        </thead>
        <tbody>
          {state.map((r, i) => (
            <tr key={i}>
              <td className="p-2 border-b"><input className="border rounded px-2 py-1 text-sm w-40" value={r.account} onChange={(e) => {
                const next = [...state]; next[i] = { ...next[i], account: e.target.value }; setState(next);
              }} placeholder="CUST123" /></td>
              <td className="p-2 border-b"><input className="border rounded px-2 py-1 text-sm w-32" type="number" value={r.qty as any} onChange={(e) => {
                const next = [...state]; next[i] = { ...next[i], qty: e.target.value }; setState(next);
              }} /></td>
              <td className="p-2 border-b"><input className="border rounded px-2 py-1 text-sm w-40" type="number" value={r.amount as any} onChange={(e) => {
                const next = [...state]; next[i] = { ...next[i], amount: e.target.value }; setState(next);
              }} /></td>
              <td className="p-2 border-b"><button className="text-red-600 text-xs underline" onClick={() => setState(state.filter((_, idx) => idx !== i))}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2">
        <button className="text-sm underline" onClick={() => setState([...state, { account: '', qty: '', amount: '' }])}>Add row</button>
        <button className="ml-auto inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800" onClick={async () => {
          const qty_overrides: Record<string, number> = {};
          const price_overrides: Record<string, number> = {};
          for (const r of state) {
            if (!r.account) continue;
            if (r.qty !== '' && !Number.isNaN(Number(r.qty))) qty_overrides[r.account] = Number(r.qty);
            if (r.amount !== '' && !Number.isNaN(Number(r.amount))) price_overrides[r.account] = Number(r.amount);
          }
          await onSave({ qty_overrides, price_overrides });
        }}>Save overrides</button>
      </div>
    </div>
  );
}


