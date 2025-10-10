'use client';
import useSWR from 'swr';
import Link from 'next/link';
import { supabase } from '../../../../lib/supabaseClient';

type JobRow = {
  id: string;
  type: string;
  status: 'queued'|'running'|'succeeded'|'failed'|'cancelled';
  attempts: number;
  max_attempts: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export default function GeneralLastRunsPage() {
  const { data, error, isLoading } = useSWR('general:last-runs', async () => {
    const { data: jobs, error } = await supabase
      .from('jobs')
      .select('id, type, status, attempts, max_attempts, started_at, finished_at, created_at')
      .eq('type', 'scrape_statistics')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    // fetch latest result per job
    const resultMap = new Map<string, any>();
    if ((jobs ?? []).length > 0) {
      const ids = (jobs ?? []).map((j: any) => j.id);
      // Pull results individually to avoid complex RPC; keep simple
      for (const id of ids) {
        const { data: res } = await supabase
          .from('job_results')
          .select('summary, data, created_at')
          .eq('job_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (res) resultMap.set(id, res);
      }
    }
    return { jobs: jobs as JobRow[], results: resultMap };
  }, { refreshInterval: 10000 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Last Runs</h1>
        <Link href="/statistics/general" className="text-sm underline">Back to General</Link>
      </div>
      {isLoading && <div>Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String(error)}</div>}
      <div className="overflow-auto border rounded-md">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-2 border-b">ID</th>
              <th className="text-left p-2 border-b">Status</th>
              <th className="text-left p-2 border-b">Started</th>
              <th className="text-left p-2 border-b">Finished</th>
              <th className="text-left p-2 border-b">Creates</th>
              <th className="text-left p-2 border-b">Updates</th>
              <th className="text-left p-2 border-b">Deletes</th>
              <th className="text-left p-2 border-b">Summary</th>
            </tr>
          </thead>
          <tbody>
            {(data?.jobs ?? []).map((j) => {
              const r = data?.results.get(j.id) as any | undefined;
              const d = (r?.data ?? {}) as any;
              const creates = d.creates ?? d.inserted ?? d.imported ?? 0;
              const updates = d.updates ?? d.updated ?? 0;
              const deletes = d.deletes ?? d.removed ?? 0;
              return (
                <tr key={j.id}>
                  <td className="p-2 border-b"><Link href={`/admin/jobs/${j.id}`}>{j.id.slice(0,8)}…</Link></td>
                  <td className="p-2 border-b">{j.status}</td>
                  <td className="p-2 border-b">{j.started_at ? new Date(j.started_at).toLocaleString() : '—'}</td>
                  <td className="p-2 border-b">{j.finished_at ? new Date(j.finished_at).toLocaleString() : '—'}</td>
                  <td className="p-2 border-b">{creates}</td>
                  <td className="p-2 border-b">{updates}</td>
                  <td className="p-2 border-b">{deletes}</td>
                  <td className="p-2 border-b">{r?.summary ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


