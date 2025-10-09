'use client';
import useSWR from 'swr';
import { useState } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import { Modal } from '../../../components/Modal';
import { ProgressBar } from '../../../components/ProgressBar';

export default function SalespersonsSettingsPage() {
  const { data, mutate } = useSWR('salespersons-with-counts', async () => {
    // Fetch salespersons and customer counts
    const { data: sps, error } = await supabase.from('salespersons').select('id, name, currency, sort_index').order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    const { data: counts, error: cntErr } = await supabase
      .from('customers')
      .select('salesperson_id, count:salesperson_id', { count: 'exact', head: false })
      .not('salesperson_id', 'is', null);
    if (cntErr) throw new Error(cntErr.message);
    const map = new Map<string, number>();
    for (const c of counts as any[]) {
      const id = c.salesperson_id as string;
      map.set(id, (map.get(id) ?? 0) + 1);
    }
    return (sps ?? []).map((sp) => ({ id: sp.id, name: sp.name, currency: sp.currency ?? 'DKK', sort_index: sp.sort_index ?? 0, customers: map.get(sp.id) ?? 0 }));
  }, { refreshInterval: 15000 });

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState<string>('');
  const [alsoCustomers, setAlsoCustomers] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [deleting, setDeleting] = useState<boolean>(false);
  async function onDelete() {
    if (!confirmId) return;
    try {
      setDeleting(true);
      setProgress(10);
      // Ensure auth
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      setProgress(30);
      // Call RPC directly from browser
      const { error } = await supabase.rpc('delete_salesperson', {
        p_salesperson_id: confirmId,
        p_delete_customers: alsoCustomers
      });
      if (error) throw new Error(error.message);
      setProgress(90);
      await mutate();
      setProgress(100);
      setConfirmId(null);
      setAlsoCustomers(false);
    } finally {
      setDeleting(false);
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Salespersons</h2>
      <div className="overflow-auto border rounded-md">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-2 border-b">Name</th>
              <th className="text-left p-2 border-b">Currency</th>
              <th className="text-left p-2 border-b">Order</th>
              <th className="text-left p-2 border-b">Customers</th>
              <th className="text-left p-2 border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((sp: any) => (
              <tr key={sp.id}>
                <td className="p-2 border-b">{sp.name}</td>
                <td className="p-2 border-b">
                  <select
                    className="rounded border px-2 py-1 text-sm"
                    defaultValue={sp.currency}
                    onChange={async (e) => {
                      const val = e.target.value;
                      try {
                        console.log('[salespersons] change currency', sp.id, val);
                        // optimistic UI
                        (sp as any).currency = val;
                        const { error } = await supabase.from('salespersons').update({ currency: val }).eq('id', sp.id);
                        if (error) throw error;
                        await mutate();
                      } catch (err: any) {
                        console.error('[salespersons] currency update failed', err?.message || err);
                        alert(err?.message || 'Failed to update currency');
                        await mutate();
                      }
                    }}
                  >
                    {['DKK','SEK','NOK','EUR'].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="p-2 border-b">
                  <input
                    type="number"
                    className="w-20 rounded border px-2 py-1 text-sm"
                    defaultValue={sp.sort_index}
                    onBlur={async (e) => {
                      const val = Number(e.target.value) || 0;
                      try {
                        console.log('[salespersons] change sort_index', sp.id, val);
                        const { error } = await supabase.from('salespersons').update({ sort_index: val }).eq('id', sp.id);
                        if (error) throw error;
                        await mutate();
                      } catch (err: any) {
                        console.error('[salespersons] sort_index update failed', err?.message || err);
                        alert(err?.message || 'Failed to update order');
                      }
                    }}
                  />
                </td>
                <td className="p-2 border-b">{sp.customers}</td>
                <td className="p-2 border-b">
                  <button
                    className="text-red-600 hover:underline"
                    onClick={() => { setConfirmId(sp.id); setConfirmName(sp.name); setAlsoCustomers(false); setProgress(0); }}
                  >Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={confirmId !== null}
        onClose={() => { if (!deleting) setConfirmId(null); }}
        title="Delete Salesperson"
        footer={(
          <>
            <button className="px-3 py-1.5 text-sm" disabled={deleting} onClick={() => setConfirmId(null)}>Cancel</button>
            <button
              className="inline-flex items-center rounded-md bg-red-600 text-white px-3 py-1.5 text-sm hover:bg-red-500 disabled:opacity-50"
              disabled={deleting}
              onClick={onDelete}
            >Delete</button>
          </>
        )}
      >
        <div className="space-y-3">
          <p>Are you sure you want to delete <span className="font-semibold">{confirmName}</span>?</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={alsoCustomers} onChange={(e) => setAlsoCustomers(e.target.checked)} />
            Also delete all customers assigned to this salesperson
          </label>
          {deleting && <ProgressBar value={progress} />}
        </div>
      </Modal>
    </div>
  );
}

