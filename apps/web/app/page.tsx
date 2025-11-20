'use client';
import * as React from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function HomePage() {
  const supabase = createClientComponentClient();
  const [name, setName] = React.useState<string>('');
  React.useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const nm = (user?.user_metadata as any)?.name || user?.email || '';
        setName(String(nm || ''));
      } catch {}
    })();
  }, []);
  return (
    <div className="min-h-screen grid place-items-center text-slate-700">
      <div className="text-center space-y-2">
        <div className="text-2xl font-semibold">Hej{ name ? ` ${name}` : '' }.</div>
        <div className="text-sm text-gray-600">Vælg en side i menuen til venstre.</div>
      </div>
    </div>
  );
}

