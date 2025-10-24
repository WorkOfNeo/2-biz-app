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

  return res;
}

export const config = {
  // Protect everything except Next internals, API routes, assets, and the signin page
  matcher: [
    '/((?!_next|api|signin|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml)$).*)'
  ]
};

