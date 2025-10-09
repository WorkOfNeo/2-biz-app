'use client';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';

export default function SalespersonsSettingsPage() {
  const { data } = useSWR('salespersons-with-counts', async () => {
    // Fetch salespersons and customer counts
    const { data: sps, error } = await supabase.from('salespersons').select('id, name');
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
    return (sps ?? []).map((sp) => ({ id: sp.id, name: sp.name, customers: map.get(sp.id) ?? 0 }));
  });
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Salespersons</h2>
      <div className="overflow-auto border rounded-md">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-2 border-b">Name</th>
              <th className="text-left p-2 border-b">Customers</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((sp: any) => (
              <tr key={sp.id}>
                <td className="p-2 border-b">{sp.name}</td>
                <td className="p-2 border-b">{sp.customers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

