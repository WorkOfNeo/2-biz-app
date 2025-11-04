'use client';

import Link from 'next/link';

export default function DownloadsPage() {
  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">Statistics</div>
      <h1 className="text-xl font-semibold">Downloads</h1>
      <p className="text-sm text-gray-600">Here you can access generated exports and downloads.</p>
      <div className="rounded border bg-white p-4 text-sm text-gray-600">
        Coming soon
      </div>
      <div className="text-xs text-gray-400">
        Go to <Link href="/statistics/exports" className="underline">Exports</Link> to generate new files.
      </div>
    </div>
  );
}


