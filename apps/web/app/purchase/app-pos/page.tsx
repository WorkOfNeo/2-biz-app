'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AppPosPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/purchase/orders?tab=app-pos');
  }, [router]);

  return (
    <div className="p-4">
      <div className="text-sm text-slate-500">Redirecting to Purchase Orders…</div>
    </div>
  );
}

