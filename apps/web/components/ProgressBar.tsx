'use client';
import { useEffect, useRef } from 'react';

export function ProgressBar({ value, max = 100, showLabel = false }: { value: number; max?: number; showLabel?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (barRef.current) barRef.current.style.width = pct + '%';
  }, [pct]);
  return (
    <div className="w-full">
      <div className="h-2 w-full overflow-hidden rounded bg-gray-200">
        <div ref={barRef} className="h-full w-0 rounded bg-slate-900 transition-[width] duration-300 ease-out" />
      </div>
      {showLabel && <div className="mt-1 text-xs text-gray-600">{pct}%</div>}
    </div>
  );
}


