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
  // User profiles (uid -> name) stored in app_settings.user_profiles
  const { data: profiles, mutate: mutateProfiles } = useSWR('user_profiles', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'user_profiles').maybeSingle();
    const id = data?.id ?? null;
    const value = ((data?.value as any) || {}) as Record<string, string>;
    const list = Object.entries(value).map(([user_id, name]) => ({ user_id, name }));
    return { id, value, list } as { id: string | null; value: Record<string, string>; list: Array<{ user_id: string; name: string }> };
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
        <RoleForm
          users={(profiles?.list && profiles.list.length > 0) ? profiles.list : (userRows ?? []).map((u: any) => ({ user_id: u.user_id, name: u.name }))}
          onSaved={async () => { await mutateUsers(); await mutateProfiles(); }}
          onAddUser={async (uid, name) => {
            const currentId = profiles?.id || null;
            const current = profiles?.value || {};
            const next = { ...current, [uid]: name || 'John Doe' } as Record<string, string>;
            if (currentId) await supabase.from('app_settings').update({ value: next }).eq('id', currentId as any);
            else await supabase.from('app_settings').insert({ key: 'user_profiles', value: next } as any);
            await mutateProfiles();
          }}
        />
      </div>
    </div>
  );
}

function RoleForm({ users, onSaved, onAddUser }: { users: Array<{ user_id: string; name: string }>; onSaved: () => void; onAddUser: (uid: string, name: string) => Promise<void> }) {
  const supabase = createClientComponentClient();
  const React = require('react') as typeof import('react');
  const [mode, setMode] = React.useState<'existing' | 'new'>('existing');
  const [userId, setUserId] = React.useState(users[0]?.user_id || '');
  const [newUid, setNewUid] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [role, setRole] = React.useState('viewer');
  const [saving, setSaving] = React.useState(false);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          setSaving(true);
          let targetUid = userId.trim();
          if (mode === 'new') {
            if (!newUid.trim()) return;
            await onAddUser(newUid.trim(), newName.trim() || 'John Doe');
            targetUid = newUid.trim();
          }
          if (!targetUid) return;
          const { error } = await supabase.from('user_roles').insert({ user_id: targetUid, role });
          if (error) throw error;
          setNewUid(''); setNewName('');
          onSaved();
        } catch (e) {
          // no-op
        } finally { setSaving(false); }
      }}
    >
      <div className="text-sm">
        <div className="font-medium mb-1">User</div>
        <div className="flex items-center gap-2">
          <select className="border rounded px-2 py-1 text-sm w-64" value={mode === 'existing' ? userId : ''} onChange={(e)=>{ setMode('existing'); setUserId(e.target.value); }}>
            {users.map((u)=> (<option key={u.user_id} value={u.user_id}>{u.name}</option>))}
          </select>
          <span className="text-xs text-gray-500">or</span>
          <button type="button" className="rounded border px-2 py-1 text-sm" onClick={()=> setMode('new')}>Add new</button>
        </div>
        {mode === 'new' && (
          <div className="mt-2 flex items-center gap-2">
            <input className="border rounded px-2 py-1 text-sm w-56" placeholder="New user name" value={newName} onChange={(e)=>setNewName(e.target.value)} />
            <input className="border rounded px-2 py-1 text-sm w-64" placeholder="Auth UID (uuid)" value={newUid} onChange={(e)=>setNewUid(e.target.value)} />
          </div>
        )}
      </div>
      <label className="text-sm">
        <div className="font-medium">Role</div>
        <select className="mt-1 border rounded px-2 py-1 text-sm" value={role} onChange={(e)=>setRole(e.target.value)}>
          {['admin','manager','sales','viewer'].map((r)=> (<option key={r} value={r}>{r}</option>))}
        </select>
      </label>
      <button disabled={saving || (mode==='new' ? !newUid.trim() : !userId.trim())} className="rounded border px-3 py-1.5 text-sm bg-slate-900 text-white">Add</button>
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
    for (const r of roles) {
      const list = (value?.[r] as string[] | undefined) ?? [];
      out[r] = list.length > 0 ? new Set<string>(list) : new Set<string>(pages);
    }
    return out;
  });
  React.useEffect(() => {
    const out: Record<string, Set<string>> = {};
    for (const r of roles) {
      const list = (value?.[r] as string[] | undefined) ?? [];
      out[r] = list.length > 0 ? new Set<string>(list) : new Set<string>(pages);
    }
    setMap(out);
  }, [JSON.stringify(value), JSON.stringify(pages)]);
  async function handleSave() {
    const out: Record<string, string[]> = {};
    for (const r of roles) {
      const set = map[r] ?? new Set<string>();
      // Empty array means allow-all (default); compress full coverage to []
      out[r] = set.size === pages.length ? [] : Array.from(set);
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


