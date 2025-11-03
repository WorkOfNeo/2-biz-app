'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function UsersAdminPage() {
  const supabase = createClientComponentClient();
  const { data: users } = useSWR('users:list', async () => {
    // We cannot list auth users from the client; show role assignments grouped by user
    const { data, error } = await supabase.from('user_roles').select('user_id, role').order('user_id');
    if (error) throw new Error(error.message);
    const map = new Map<string, string[]>();
    for (const r of (data ?? []) as any[]) {
      const arr = map.get(r.user_id) || [];
      arr.push(r.role);
      map.set(r.user_id, arr);
    }
    return Array.from(map.entries()).map(([user_id, roles]) => ({ user_id, roles }));
  });
  const React = require('react') as typeof import('react');
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [role, setRole] = React.useState('viewer');
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <div className="text-xs text-gray-500">Assign roles to control access</div>
      </div>
      <div>
        <button className="rounded border px-3 py-1.5 text-sm bg-slate-900 text-white" onClick={()=>setOpen((v)=>!v)}>{open ? 'Close' : 'Create user'}</button>
        {open && (
          <form
            className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 rounded border p-3 bg-white"
            onSubmit={async (e)=>{
              e.preventDefault();
              try {
                setCreating(true);
                const res = await fetch('/api/admin/users/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password, role }) });
                if (!res.ok) throw new Error(await res.text());
                setName(''); setEmail(''); setPassword(''); setRole('viewer'); setOpen(false);
              } catch (e) {
                // no-op
              } finally { setCreating(false); }
            }}
          >
            <label className="text-sm">
              <div className="font-medium">Name</div>
              <input className="mt-1 w-full border rounded px-2 py-1 text-sm" placeholder="Full name" value={name} onChange={(e)=>setName(e.target.value)} />
            </label>
            <label className="text-sm">
              <div className="font-medium">Email</div>
              <input type="email" required className="mt-1 w-full border rounded px-2 py-1 text-sm" placeholder="name@example.com" value={email} onChange={(e)=>setEmail(e.target.value)} />
            </label>
            <label className="text-sm">
              <div className="font-medium">Password</div>
              <input type="password" required className="mt-1 w-full border rounded px-2 py-1 text-sm" placeholder="••••••••" value={password} onChange={(e)=>setPassword(e.target.value)} />
            </label>
            <label className="text-sm">
              <div className="font-medium">Role</div>
              <select className="mt-1 w-full border rounded px-2 py-1 text-sm" value={role} onChange={(e)=>setRole(e.target.value)}>
                {['admin','manager','sales','viewer'].map((r)=> (<option key={r} value={r}>{r}</option>))}
              </select>
            </label>
            <div className="flex items-end">
              <button disabled={creating || !email || !password} className="rounded border px-3 py-1.5 text-sm bg-slate-900 text-white disabled:opacity-50">Create</button>
            </div>
          </form>
        )}
      </div>
      <div className="rounded-md border bg-white overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-2 text-left border-b">User ID</th>
              <th className="p-2 text-left border-b">Roles</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.user_id}>
                <td className="p-2 border-b font-mono text-xs">{u.user_id}</td>
                <td className="p-2 border-b">{u.roles.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


