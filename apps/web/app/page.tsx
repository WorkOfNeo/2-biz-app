import Link from 'next/link';
"use client";
import { useState } from 'react';

export default function HomePage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  return (
    <div>
      <h1>Statistics Admin</h1>
      <p>
        Go to <Link href="/admin">/admin</Link> or <Link href="/signin">/signin</Link>.
      </p>
      <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
        <strong>Test Login via Browserless</strong>
        <div style={{ marginTop: 8 }}>
          <button
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setResult(null);
              try {
                const res = await fetch('/api/test-login', { method: 'POST' });
                const json = await res.json();
                setResult(JSON.stringify(json));
              } catch (e: any) {
                setResult(String(e?.message ?? e));
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? 'Testing…' : 'Run Test Login'}
          </button>
        </div>
        {result && (
          <pre style={{ marginTop: 8, background: '#f9f9f9', padding: 8, borderRadius: 6, overflowX: 'auto' }}>{result}</pre>
        )}
      </div>
    </div>
  );
}

