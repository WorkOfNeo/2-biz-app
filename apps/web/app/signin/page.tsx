'use client';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useEffect, useState } from 'react';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';

export default function SignInPage() {
  const supabase = createClientComponentClient();
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Ensure we have the base URL configured
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold mb-4">Sign in</h1>
        {error && <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setLoading(true);
            try {
              const { data, error } = await supabase.auth.signInWithPassword({ email, password });
              if (error) throw error;
              // Redirect back to intended page
              const r = (search.get('redirect') || '/') as Route;
              router.replace(r);
            } catch (e: any) {
              setError(e?.message || 'Sign in failed');
            } finally {
              setLoading(false);
            }
          }}
          className="space-y-3"
        >
          <div className="space-y-1">
            <label className="block text-sm text-slate-700">Email</label>
            <input
              type="email"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm text-slate-700">Password</label>
            <input
              type="password"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md border bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:opacity-95 disabled:opacity-60"
          >{loading ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </div>
    </div>
  );
}

