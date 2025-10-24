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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <div className="text-xs text-gray-500">Assign roles to control access</div>
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


