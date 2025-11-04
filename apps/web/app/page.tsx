'use client';
import { useEffect, useState } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import OverviewPage from './statistics/overview/page';

export default function HomePage() {
  const supabase = createClientComponentClient();
  const [userName, setUserName] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const name = (user as any)?.user_metadata?.name as string | undefined;
        setUserName(name || (user?.email ?? 'there'));
      } catch {}
    })();
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-center text-2xl font-semibold">Welcome {userName}!</h1>
      <OverviewPage />
    </div>
  );
}

