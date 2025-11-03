'use client';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function UsersAdminPage() {
  const supabase = createClientComponentClient();
  const { data, mutate } = useSWR('admin:users', async () => {
    const res = await fetch('/api/admin/users/list');
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  });
  const users = data?.users as { user_id: string; name: string; email: string; roles: string[] }[] | undefined;
  const React = require('react') as typeof import('react');
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [role, setRole] = React.useState('viewer');
  const [creating, setCreating] = React.useState(false);
  const [saving, setSaving] = React.useState<string | null>(null);

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
                {['admin','viewer'].map((r)=> (<option key={r} value={r}>{r}</option>))}
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
              <th className="p-2 text-left border-b">Name</th>
              <th className="p-2 text-left border-b">Email</th>
              <th className="p-2 text-left border-b">Roles</th>
              <th className="p-2 text-left border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.user_id}>
                <td className="p-2 border-b font-mono text-[11px]">{u.user_id}</td>
                <td className="p-2 border-b">
                  <InlineEditable
                    value={u.name || ''}
                    placeholder="Name"
                    onSave={async (val)=>{
                      setSaving(u.user_id);
                      await fetch('/api/admin/users/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: u.user_id, name: val }) });
                      setSaving(null);
                      mutate();
                    }}
                  />
                </td>
                <td className="p-2 border-b">
                  <InlineEditable
                    value={u.email || ''}
                    placeholder="email@example.com"
                    onSave={async (val)=>{
                      setSaving(u.user_id);
                      await fetch('/api/admin/users/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: u.user_id, email: val }) });
                      setSaving(null);
                      mutate();
                    }}
                  />
                </td>
                <td className="p-2 border-b">
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r)=> (
                      <span key={r} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5">
                        <span>{r}</span>
                        <button
                          className="text-red-600 hover:underline"
                          title="Remove role"
                          onClick={async ()=>{
                            await fetch('/api/admin/users/roles/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: u.user_id, role: r }) });
                            mutate();
                          }}
                        >×</button>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="p-2 border-b">
                  <AddRole userId={u.user_id} onAdded={()=>mutate()} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function InlineEditable({ value, onSave, placeholder }:{ value: string; onSave: (v:string)=>Promise<void>|void; placeholder?: string }){
  const React = require('react') as typeof import('react');
  const [val, setVal] = React.useState(value);
  const [editing, setEditing] = React.useState(false);
  React.useEffect(()=>{ setVal(value); }, [value]);
  return (
    <div className="flex items-center gap-2">
      {editing ? (
        <>
          <input className="border rounded px-2 py-1 text-sm" value={val} placeholder={placeholder} onChange={(e)=>setVal(e.target.value)} />
          <button className="text-xs rounded border px-2 py-1 bg-slate-900 text-white" onClick={async ()=>{ await onSave(val); setEditing(false); }}>Save</button>
          <button className="text-xs underline" onClick={()=>{ setVal(value); setEditing(false); }}>Cancel</button>
        </>
      ) : (
        <>
          <span>{value || <span className="text-gray-400">{placeholder || '—'}</span>}</span>
          <button className="text-xs underline" onClick={()=>setEditing(true)}>Edit</button>
        </>
      )}
    </div>
  );
}

function AddRole({ userId, onAdded }:{ userId: string; onAdded: ()=>void }){
  const React = require('react') as typeof import('react');
  const [r, setR] = React.useState('viewer');
  const [busy, setBusy] = React.useState(false);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (e)=>{
        e.preventDefault();
        try {
          setBusy(true);
          await fetch('/api/admin/users/roles/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, role: r }) });
          onAdded();
        } finally { setBusy(false); }
      }}
    >
      <select className="border rounded px-2 py-1 text-sm" value={r} onChange={(e)=>setR(e.target.value)}>
        {['admin','viewer'].map((x)=> (<option key={x} value={x}>{x}</option>))}
      </select>
      <button disabled={busy} className="text-xs rounded border px-2 py-1 bg-slate-900 text-white disabled:opacity-50">Add role</button>
    </form>
  );
}

