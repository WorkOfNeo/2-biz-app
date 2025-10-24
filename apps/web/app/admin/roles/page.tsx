'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function RolesAdminPage() {
  const supabase = createClientComponentClient();
  const { data: pages } = useSWR('pages:list', async () => {
    // Static page list for now; later can be discovered
    return [
      '/', '/statistics/general', '/statistics/overview', '/statistics/countries', '/statistics/countries/exports',
      '/styles', '/styles/settings', '/styles/stock-list',
      '/settings/seasons', '/settings/salespersons', '/settings/customers', '/settings/misc', '/settings/runs',
      '/admin', '/admin/users', '/admin/roles'
    ];
  });
  const { data: roles, mutate } = useSWR('roles:list', async () => {
    const { data, error } = await supabase.from('user_roles').select('id, user_id, role').order('role');
    if (error) throw new Error(error.message);
    return data as { id: string; user_id: string; role: string }[];
  });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Roles</h1>
        <div className="text-xs text-gray-500">Define roles and map to pages (UI gating)</div>
      </div>
      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Existing role assignments</div>
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">User ID</th>
              <th className="p-2 text-left border-b">Role</th>
              <th className="p-2 text-left border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(roles ?? []).map((r) => (
              <tr key={r.id}>
                <td className="p-2 border-b font-mono text-xs">{r.user_id}</td>
                <td className="p-2 border-b">{r.role}</td>
                <td className="p-2 border-b">
                  <button
                    className="text-xs rounded border px-2 py-1"
                    onClick={async () => { try { await supabase.from('user_roles').delete().eq('id', r.id); await mutate(); } catch {} }}
                  >Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Add role assignment</div>
        <RoleForm onSaved={mutate} />
      </div>
    </div>
  );
}

function RoleForm({ onSaved }: { onSaved: () => void }) {
  const supabase = createClientComponentClient();
  const [userId, setUserId] = (require('react') as typeof import('react')).useState('');
  const [role, setRole] = (require('react') as typeof import('react')).useState('viewer');
  const [saving, setSaving] = (require('react') as typeof import('react')).useState(false);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          setSaving(true);
          if (!userId.trim()) return;
          const { error } = await supabase.from('user_roles').insert({ user_id: userId.trim(), role });
          if (error) throw error;
          setUserId('');
          onSaved();
        } catch (e) {
          // no-op
        } finally { setSaving(false); }
      }}
    >
      <label className="text-sm">
        <div className="font-medium">User ID (auth.uid)</div>
        <input className="mt-1 border rounded px-2 py-1 text-sm w-80" value={userId} onChange={(e)=>setUserId(e.target.value)} placeholder="uuid" />
      </label>
      <label className="text-sm">
        <div className="font-medium">Role</div>
        <select className="mt-1 border rounded px-2 py-1 text-sm" value={role} onChange={(e)=>setRole(e.target.value)}>
          {['admin','manager','sales','viewer'].map((r)=> (<option key={r} value={r}>{r}</option>))}
        </select>
      </label>
      <button disabled={saving || !userId.trim()} className="rounded border px-3 py-1.5 text-sm bg-slate-900 text-white">Add</button>
    </form>
  );
}


