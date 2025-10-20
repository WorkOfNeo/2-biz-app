'use client';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

export default function CustomerDetailPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const { data } = useSWR(['customer', id], async () => {
    const { data, error } = await supabase.from('customers').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data as any;
  });
  if (!data) return <div className="p-4 text-sm text-gray-600">Loading…</div>;
  const entries = Object.entries(data || {});
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-semibold">Customer</h2>
      <div className="overflow-auto border rounded-md">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr><th className="p-2 text-left">Label</th><th className="p-2 text-left">Value</th></tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-t">
                <td className="p-2 font-medium">{k}</td>
                <td className="p-2">{String(v ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


