'use client';
import { useState } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import useSWR from 'swr';
import type { CustomerRow, SalespersonRow } from '@shared/types';
import { Modal } from '../../../components/Modal';

// Import moved to /settings/customers/import

export default function CustomersSettingsPage() {
  const { data: customers, mutate } = useSWR('customers', async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('*, salespersons(name)')
      .order('company', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return data as any[];
  }, { refreshInterval: 10000 });
  const { data: salespersons } = useSWR('salespersons', async () => {
    const { data, error } = await supabase.from('salespersons').select('*').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return data as SalespersonRow[];
  });
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Customers</h2>
      <div className="space-y-2">
        <h3 className="text-lg font-semibold mt-6">Customers</h3>
        <div className="overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2 border-b">Company</th>
                <th className="text-left p-2 border-b">Customer ID</th>
                <th className="text-left p-2 border-b">Salesperson</th>
                <th className="text-left p-2 border-b">City</th>
                <th className="text-left p-2 border-b">Country</th>
                <th className="text-left p-2 border-b">Excluded</th>
                <th className="text-left p-2 border-b">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(customers ?? []).map((c) => (
                <CustomerRowItem key={c.id} row={c} salespersons={salespersons ?? []} onSaved={mutate} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CustomerRowItem({ row, salespersons, onSaved }: { row: any; salespersons: SalespersonRow[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState<string>(row.company ?? '');
  const [statsName, setStatsName] = useState<string>(row.stats_display_name ?? '');
  const [groupName, setGroupName] = useState<string>(row.group_name ?? '');
  const [salespersonName, setSalespersonName] = useState<string>(row.salespersons?.name ?? '');
  const [email, setEmail] = useState<string>(row.email ?? '');
  const [city, setCity] = useState<string>(row.city ?? '');
  const [postal, setPostal] = useState<string>(row.postal ?? '');
  const [country, setCountry] = useState<string>(row.country ?? '');
  const [currency, setCurrency] = useState<string>(row.currency ?? '');
  const [excluded, setExcluded] = useState<boolean>(!!row.excluded);
  const [nulled, setNulled] = useState<boolean>(!!row.nulled);
  const [closed, setClosed] = useState<boolean>(!!row.permanently_closed);
  const [saving, setSaving] = useState(false);
  return (
    <tr>
      <td className="p-2 border-b">{row.company || '-'}</td>
      <td className="p-2 border-b font-mono text-xs">{row.customer_id}</td>
      <td className="p-2 border-b">{row.salespersons?.name || '-'}</td>
      <td className="p-2 border-b">{row.city || '-'}</td>
      <td className="p-2 border-b">{row.country || '-'}</td>
      <td className="p-2 border-b">{row.excluded ? 'Yes' : 'No'}</td>
      <td className="p-2 border-b">
        <button className="text-blue-600 hover:underline" onClick={() => setOpen(true)}>Edit</button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Edit Customer"
          footer={(
            <>
              <button className="px-3 py-1.5 text-sm" onClick={() => setOpen(false)}>Cancel</button>
              <button
                disabled={saving}
                className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                onClick={async () => {
                  try {
                    setSaving(true);
                    const { data: { session } } = await supabase.auth.getSession();
                    if (!session) throw new Error('Not signed in');
                    const token = session.access_token;
                    const res = await fetch(`${process.env.NEXT_PUBLIC_ORCHESTRATOR_URL}/customers/${row.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({
                        company,
                        stats_display_name: statsName,
                        group_name: groupName,
                        salesperson_name: salespersonName,
                        email, city, postal, country, currency,
                        excluded, nulled, permanently_closed: closed
                      })
                    });
                    if (!res.ok) throw new Error(await res.text());
                    setOpen(false);
                    onSaved();
                  } finally {
                    setSaving(false);
                  }
                }}
              >Save</button>
            </>
          )}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">Company<input className="mt-1 w-full border rounded p-1 text-sm" value={company} onChange={(e) => setCompany(e.target.value)} /></label>
            <label className="text-sm">Stats Display<input className="mt-1 w-full border rounded p-1 text-sm" value={statsName} onChange={(e) => setStatsName(e.target.value)} /></label>
            <label className="text-sm">Group<input className="mt-1 w-full border rounded p-1 text-sm" value={groupName} onChange={(e) => setGroupName(e.target.value)} /></label>
            <label className="text-sm">Salesperson<input list={`sp-${row.id}`} className="mt-1 w-full border rounded p-1 text-sm" value={salespersonName} onChange={(e) => setSalespersonName(e.target.value)} placeholder="Salesperson name" /></label>
            <datalist id={`sp-${row.id}`}>{salespersons.map((sp) => (<option key={sp.id} value={sp.name} />))}</datalist>
            <label className="text-sm">Email<input className="mt-1 w-full border rounded p-1 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="text-sm">City<input className="mt-1 w-full border rounded p-1 text-sm" value={city} onChange={(e) => setCity(e.target.value)} /></label>
            <label className="text-sm">Postal<input className="mt-1 w-full border rounded p-1 text-sm" value={postal} onChange={(e) => setPostal(e.target.value)} /></label>
            <label className="text-sm">Country<input className="mt-1 w-full border rounded p-1 text-sm" value={country} onChange={(e) => setCountry(e.target.value)} /></label>
            <label className="text-sm">Currency<input className="mt-1 w-full border rounded p-1 text-sm" value={currency} onChange={(e) => setCurrency(e.target.value)} /></label>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} /> Excluded</label>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={nulled} onChange={(e) => setNulled(e.target.checked)} /> Nulled</label>
            <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Permanently Closed</label>
          </div>
        </Modal>
      </td>
    </tr>
  );
}

