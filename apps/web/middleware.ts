import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs';

const SUPERADMIN_EMAIL = process.env.NEXT_PUBLIC_SUPERADMIN_EMAIL!;

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.nextUrl.pathname.startsWith('/admin')) return res;

  const supabase = createMiddlewareClient({ req, res });
  const {
    data: { session }
  } = await supabase.auth.getSession();

  const email = session?.user?.email;
  if (!session || !email || email !== SUPERADMIN_EMAIL) {
    const signinUrl = new URL('/signin', req.url);
    return NextResponse.redirect(signinUrl);
  }

  return res;
}

export const config = {
  matcher: ['/admin/:path*']
};

