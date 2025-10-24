import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export const supabase = createClientComponentClient();

export type UserRole = 'admin' | 'manager' | 'sales' | 'viewer';

export async function fetchUserRoles(): Promise<Set<UserRole>> {
  try {
    const { data, error } = await supabase.from('user_roles').select('role');
    if (error) throw error;
    const roles = new Set<UserRole>();
    for (const r of (data ?? []) as any[]) {
      const v = String(r.role || '').trim();
      if (v) roles.add(v as UserRole);
    }
    return roles;
  } catch {
    return new Set();
  }
}

export function useRoles() {
  const [roles, setRoles] = (require('react') as typeof import('react')).useState<Set<UserRole>>(new Set());
  (require('react') as typeof import('react')).useEffect(() => {
    let mounted = true;
    fetchUserRoles().then((r) => { if (mounted) setRoles(r); });
    return () => { mounted = false; };
  }, []);
  function has(role: UserRole) { return roles.has(role); }
  return { roles, has } as const;
}

