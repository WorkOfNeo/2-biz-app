import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Allow unauthenticated access to the signin page and public assets
  const { pathname } = req.nextUrl;
  if (
    pathname === '/signin' ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/public') ||
    pathname === '/favicon.ico' ||
    pathname.match(/\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml)$/i) ||
    pathname.startsWith('/api')
  ) {
    return res;
  }

  const supabase = createMiddlewareClient({ req, res });
  const {
    data: { session }
  } = await supabase.auth.getSession();

  if (!session) {
    const signinUrl = new URL('/signin', req.url);
    signinUrl.searchParams.set('redirect', req.nextUrl.pathname + (req.nextUrl.search || ''));
    return NextResponse.redirect(signinUrl);
  }

  // Enforce access by roles
  try {
    const { data } = await supabase.from('user_roles').select('role');
    const roles = new Set<string>((data || []).map((r: any) => String(r.role || '')));
    // Load role_page_access mapping to compute allowed paths
    let roleAccess: Record<string, string[]> = {};
    try {
      const { data: acc } = await supabase.from('app_settings').select('value').eq('key', 'role_page_access').maybeSingle();
      roleAccess = ((acc?.value as any) || {}) as Record<string, string[]>;
    } catch {}

    // Redirect root depending on role
    if (pathname === '/') {
      if (roles.has('finance')) return NextResponse.redirect(new URL('/finance/csv-skat', req.url));
      if (roles.has('sales')) return NextResponse.redirect(new URL('/sales', req.url));
      if (roles.has('purchase')) return NextResponse.redirect(new URL('/statistics/overview', req.url));
      return NextResponse.redirect(new URL('/statistics/overview', req.url));
    }

    if (pathname.startsWith('/admin') && !roles.has('admin')) {
      return NextResponse.redirect(new URL('/', req.url));
    }
    // If not admin, restrict by role allowlists
    if (!roles.has('admin')) {
      let allow: Set<string> | null = null;
      if (roleAccess && Object.keys(roleAccess).length > 0) {
        allow = new Set<string>();
        for (const role of Array.from(roles)) {
          const list = roleAccess[role] || [];
          for (const p of list) allow.add(p);
        }
      }
      if (!allow) {
        // Fallback allow lists
        const tmp = new Set<string>(['/']);
        if (roles.has('purchase')) {
          ['/statistics', '/styles', '/settings/seasons', '/settings/salespersons', '/settings/customers', '/settings/misc'].forEach((p) => tmp.add(p));
        }
        if (roles.has('finance')) tmp.add('/finance');
        if (roles.has('sales')) tmp.add('/sales');
        allow = tmp;
      }
      const ok = Array.from(allow).some((p) => pathname === p || pathname.startsWith(p + '/'));
      if (!ok) return NextResponse.redirect(new URL('/', req.url));
    }
  } catch {}

  return res;
}

export const config = {
  // Protect everything except Next internals, API routes, assets, and the signin page
  matcher: [
    '/((?!_next|api|signin|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml)$).*)'
  ]
};

