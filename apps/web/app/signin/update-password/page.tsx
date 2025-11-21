'use client';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import React from 'react';
import { useRouter } from 'next/navigation';

export default function UpdatePasswordPage() {
  const supabase = createClientComponentClient();
  const router = useRouter();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [msg, setMsg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold mb-4">Set a new password</h1>
        {msg ? (
          <div className="space-y-3">
            <div className="text-sm text-green-700">{msg}</div>
            <button className="w-full rounded-md border bg-slate-900 px-3 py-2 text-sm font-medium text-white" onClick={()=>router.replace('/signin')}>Go to sign in</button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
              if (password !== confirm) { setError('Passwords do not match'); return; }
              try {
                setBusy(true);
                const { error } = await supabase.auth.updateUser({ password });
                if (error) throw error;
                setMsg('Password updated. You can now sign in.');
              } catch (e: any) {
                setError(e?.message || 'Failed to update password');
              } finally { setBusy(false); }
            }}
          >
            {error && <div className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <label className="block text-sm">
              <span className="text-slate-700">New password</span>
              <input type="password" className="mt-1 w-full rounded-md border px-3 py-2 text-sm" value={password} onChange={(e)=>setPassword(e.target.value)} required />
            </label>
            <label className="block text-sm">
              <span className="text-slate-700">Confirm password</span>
              <input type="password" className="mt-1 w-full rounded-md border px-3 py-2 text-sm" value={confirm} onChange={(e)=>setConfirm(e.target.value)} required />
            </label>
            <button disabled={busy} className="w-full rounded-md border bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save password'}</button>
          </form>
        )}
        <div className="mt-3 text-xs"><a className="text-blue-700 hover:underline" href="/signin">Back to sign in</a></div>
      </div>
    </div>
  );
}


