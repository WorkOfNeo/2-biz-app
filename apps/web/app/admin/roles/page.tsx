'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function RolesAdminPage() {
  const supabase = createClientComponentClient();
  // Static page list (read from sidebar structure)
  const { data: pages } = useSWR('pages:list', async () => {
    return [
      '/', '/statistics/general', '/statistics/overview', '/statistics/countries', '/statistics/countries/exports',
      '/styles', '/styles/settings', '/styles/stock-list',
      '/settings/seasons', '/settings/salespersons', '/settings/customers', '/settings/misc', '/settings/runs',
      '/admin', '/admin/users', '/admin/roles'
    ];
  });
  // List all unique user_ids from user_roles and enrich with names from customers or salespersons if any; fallback
  const { data: userRows, mutate: mutateUsers } = useSWR('roles:users', async () => {
    const { data, error } = await supabase.from('user_roles').select('user_id, role');
    if (error) throw new Error(error.message);
    const map = new Map<string, Set<string>>();
    for (const r of (data ?? []) as any[]) {
      const set = map.get(r.user_id) || new Set<string>();
      set.add(r.role);
      map.set(r.user_id, set);
    }
    // Try to look up friendly names from app_settings (user_profiles) if exists
    let nameMap = new Map<string, string>();
    try {
      const { data: prof } = await supabase.from('app_settings').select('value').eq('key', 'user_profiles').maybeSingle();
      const val = (prof?.value as any) || {};
      nameMap = new Map<string, string>(Object.entries(val));
    } catch {}
    const out = Array.from(map.entries()).map(([user_id, roles]) => ({ user_id, name: nameMap.get(user_id) || 'John Doe', roles: Array.from(roles) }));
    return out;
  });
  // Role to pages mapping in app_settings
  const { data: roleAccess, mutate: mutateRoleAccess } = useSWR('role:pages', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'role_page_access').maybeSingle();
    return { id: data?.id ?? null, value: ((data?.value as any) || {}) as Record<string, string[]> };
  });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Roles</h1>
        <div className="text-xs text-gray-500">Manage users and page access per role</div>
      </div>
      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Users</div>
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">Name</th>
              <th className="p-2 text-left border-b">Roles</th>
              <th className="p-2 text-left border-b">Add Role</th>
            </tr>
          </thead>
          <tbody>
            {(userRows ?? []).map((u) => (
              <tr key={u.user_id}>
                <td className="p-2 border-b">{u.name}</td>
                <td className="p-2 border-b">{u.roles.join(', ') || '—'}</td>
                <td className="p-2 border-b">
                  <AddRoleInline userId={u.user_id} onSaved={mutateUsers} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Role → Pages</div>
        <RolePageMatrix pages={pages ?? []} value={roleAccess?.value ?? {}} onSave={async (next) => {
          const existingId = roleAccess?.id || null;
          if (existingId) await supabase.from('app_settings').update({ value: next }).eq('id', existingId as any);
          else await supabase.from('app_settings').insert({ key: 'role_page_access', value: next } as any);
          await mutateRoleAccess();
        }} />
      </div>
      <div className="rounded-md border bg-white p-3">
        <div className="text-sm font-medium mb-2">Add role assignment</div>
        <RoleForm onSaved={() => { mutateUsers(); }} />
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
        <input className="mt-1 border rounded px-2 py-1 text-sm w-80" value={userId} onChange={(e)=>setUserId(e.target.value)} placeholder="Paste auth UID (uuid)" />
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

function AddRoleInline({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const supabase = createClientComponentClient();
  const React = require('react') as typeof import('react');
  const [role, setRole] = React.useState('viewer');
  const [saving, setSaving] = React.useState(false);
  return (
    <div className="flex items-center gap-2">
      <select className="border rounded px-2 py-1 text-sm" value={role} onChange={(e)=>setRole(e.target.value)}>
        {['admin','manager','sales','viewer'].map((r)=> (<option key={r} value={r}>{r}</option>))}
      </select>
      <button
        disabled={saving}
        className="rounded border px-2 py-1 text-sm"
        onClick={async ()=>{
          try { setSaving(true); await supabase.from('user_roles').insert({ user_id: userId, role }); onSaved(); } finally { setSaving(false); }
        }}
      >Add</button>
    </div>
  );
}

function RolePageMatrix({ pages, value, onSave }: { pages: string[]; value: Record<string, string[]>; onSave: (next: Record<string, string[]>) => Promise<void> }) {
  const React = require('react') as typeof import('react');
  const roles: string[] = ['admin','manager','sales','viewer'];
  const [map, setMap] = React.useState<Record<string, Set<string>>>(() => {
    const out: Record<string, Set<string>> = {};
    for (const r of roles) out[r] = new Set<string>((value?.[r] as string[] | undefined) ?? []);
    return out;
  });
  React.useEffect(() => {
    const out: Record<string, Set<string>> = {};
    for (const r of roles) out[r] = new Set<string>((value?.[r] as string[] | undefined) ?? []);
    setMap(out);
  }, [JSON.stringify(value)]);
  async function handleSave() {
    const out: Record<string, string[]> = {};
    for (const r of roles) {
      const set = map[r] ?? new Set<string>();
      out[r] = Array.from(set);
    }
    await onSave(out);
  }
  return (
    <div className="space-y-3">
      <div className="overflow-auto border rounded">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">Page</th>
              {roles.map((r) => (<th key={r} className="p-2 text-center border-b">{r}</th>))}
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => (
              <tr key={p}>
                <td className="p-2 border-b font-mono text-xs">{p}</td>
                {roles.map((r) => {
                  const checked = map[r]?.has(p) ?? false;
                  return (
                    <td key={r} className="p-2 border-b text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = new Set(map[r] || new Set<string>());
                          if (e.target.checked) next.add(p); else next.delete(p);
                          setMap((prev) => ({ ...prev, [r]: next }));
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="rounded border px-3 py-1.5 text-sm bg-slate-900 text-white" onClick={handleSave}>Save</button>
    </div>
  );
}


