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

// Role-based page access sourced from app_settings.role_page_access
export function useRoleAccess() {
  const React = require('react') as typeof import('react');
  const [map, setMap] = React.useState<Record<string, string[]>>({});
  const [allowedSet, setAllowedSet] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [roles] = React.useState<Set<UserRole>>(() => new Set());
  // Fetch roles separately
  React.useEffect(() => {
    let mounted = true;
    fetchUserRoles().then((r) => {
      if (!mounted) return;
      (roles as any).clear?.();
      for (const role of r) (roles as any).add?.(role);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, []);
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'role_page_access').maybeSingle();
        if (error) throw error;
        const val = (data?.value as any) || {};
        if (!mounted) return;
        setMap(val as Record<string, string[]>);
        // Build allowlist for current user's roles
        const set = new Set<string>();
        for (const role of Array.from(roles as any as Set<string>)) {
          const list = (val?.[role] as string[] | undefined) || [];
          for (const p of list) set.add(p);
        }
        setAllowedSet(set);
      } catch (e: any) {
        setError(e?.message || 'Failed to load role access');
      }
    })();
    return () => { mounted = false; };
  }, [JSON.stringify(Array.from((roles as any as Set<string>)?.values?.() || []))]);
  function can(path: string): boolean {
    // Admins always allowed when explicitly set in roles
    if ((roles as any as Set<string>).has('admin')) return true;
    if (allowedSet.size === 0) return true; // default allow if no mapping
    // Exact match or parent-allow (e.g., '/settings' allows '/settings/seasons')
    if (allowedSet.has(path)) return true;
    for (const p of Array.from(allowedSet)) {
      if (p !== '/' && path.startsWith(p + '/')) return true;
    }
    return false;
  }
  return { map, can, loading, error } as const;
}

