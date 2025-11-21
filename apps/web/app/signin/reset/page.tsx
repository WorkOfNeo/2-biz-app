'use client';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import React from 'react';

export default function ResetRequestPage() {
  const supabase = createClientComponentClient();
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold mb-4">Reset password</h1>
        {sent ? (
          <div className="text-sm text-green-700">If the email exists, a reset link has been sent.</div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const redirectTo = `${window.location.origin}/signin/update-password`;
                const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
                if (error) throw error;
                setSent(true);
              } catch (e: any) {
                setError(e?.message || 'Failed to send reset email');
              }
            }}
          >
            {error && <div className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <label className="block text-sm">
              <span className="text-slate-700">Email</span>
              <input type="email" className="mt-1 w-full rounded-md border px-3 py-2 text-sm" value={email} onChange={(e)=>setEmail(e.target.value)} required />
            </label>
            <button className="w-full rounded-md border bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:opacity-95">Send reset link</button>
          </form>
        )}
        <div className="mt-3 text-xs"><a className="text-blue-700 hover:underline" href="/signin">Back to sign in</a></div>
      </div>
    </div>
  );
}


