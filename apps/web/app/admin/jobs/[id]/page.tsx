'use client';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

export default function JobDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || '';
  const { data, error, isLoading } = useSWR(id ? ['job', id] : null, async () => {
    const { data: job, error: jobErr } = await supabase.from('jobs').select('*').eq('id', id).maybeSingle();
    if (jobErr) throw new Error(jobErr.message);
    const { data: logs, error: logsErr } = await supabase
      .from('job_logs')
      .select('*')
      .eq('job_id', id)
      .order('ts', { ascending: false })
      .limit(200);
    if (logsErr) throw new Error(logsErr.message);
    const { data: results } = await supabase
      .from('job_results')
      .select('*')
      .eq('job_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    return { job, logs: logs ?? [], result: results?.[0] ?? null };
  }, { refreshInterval: 4000 });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Job {id.slice(0,8)}…</h1>
      {isLoading && <div>Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String(error)}</div>}
      {data?.job && (
        <div className="border rounded p-3">
          <div className="text-sm">Status: <b>{data.job.status}</b></div>
          <div className="text-sm">Attempts: {data.job.attempts}/{data.job.max_attempts}</div>
          <div className="text-sm">Started: {data.job.started_at ? new Date(data.job.started_at).toLocaleString() : '—'}</div>
          <div className="text-sm">Finished: {data.job.finished_at ? new Date(data.job.finished_at).toLocaleString() : '—'}</div>
          {data.job.error && <div className="text-sm text-red-700">Error: {data.job.error}</div>}
          <div className="text-xs text-gray-500 break-all">Payload: {JSON.stringify(data.job.payload)}</div>
        </div>
      )}

      {data?.result && (
        <div className="border rounded p-3">
          <div className="font-semibold">Result</div>
          <div className="text-sm">Summary: {data.result.summary}</div>
          {/* Samples table if present */}
          {/* Parsed rows grouped view */}
          {data.result.data && (data.result.data as any).parsed && (
            <div className="mt-4 space-y-3">
              <div className="text-sm font-medium">Parsed rows</div>
              {/* Topseller by salesperson */}
              {Array.isArray(((data.result.data as any).parsed.topseller) as any[]) && (
                <details className="border rounded" open>
                  <summary className="cursor-pointer select-none px-3 py-2 font-medium">Topseller (per salesperson)</summary>
                  <div className="p-2 space-y-2">
                    {(((data.result.data as any).parsed.topseller) as any[]).map((g: any, idx: number) => (
                      <details key={idx} className="border rounded">
                        <summary className="cursor-pointer select-none px-3 py-2">{g.salesperson} <span className="text-[11px] text-gray-500">{g.rows?.length ?? 0} rows</span></summary>
                        <div className="overflow-auto px-2 pb-2">
                          <table className="min-w-full text-[11px]">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="text-left p-2 border-b">Customer</th>
                                <th className="text-left p-2 border-b">Account</th>
                                <th className="text-left p-2 border-b">Country</th>
                                <th className="text-right p-2 border-b">Qty</th>
                                <th className="text-right p-2 border-b">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(g.rows ?? []).map((r: any, i: number) => (
                                <tr key={i}>
                                  <td className="p-2 border-b">{r.customer}</td>
                                  <td className="p-2 border-b font-mono">{r.account}</td>
                                  <td className="p-2 border-b">{r.country}</td>
                                  <td className="p-2 border-b text-right">{r.qty}</td>
                                  <td className="p-2 border-b text-right">{r.amount} {r.currency ?? ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    ))}
                  </div>
                </details>
              )}
              {/* Invoiced lines grouped by salesperson -> customer */}
              {Array.isArray(((data.result.data as any).parsed.invoiced?.lines) as any[]) && (
                <details className="border rounded">
                  <summary className="cursor-pointer select-none px-3 py-2 font-medium">Invoiced ({(data.result.data as any).parsed.invoiced.count})</summary>
                  <div className="p-2 space-y-2">
                    {(() => {
                      const lines = ((data.result.data as any).parsed.invoiced.lines as any[]);
                      const bySales = new Map<string, any[]>();
                      for (const l of lines) {
                        const key = (l.salespersonName || '—') as string;
                        const arr = bySales.get(key) ?? [];
                        arr.push(l); bySales.set(key, arr);
                      }
                      return Array.from(bySales.entries()).map(([sp, arr], idx) => (
                        <details key={idx} className="border rounded">
                          <summary className="cursor-pointer select-none px-3 py-2">{sp} <span className="text-[11px] text-gray-500">{arr.length} rows</span></summary>
                          <div className="overflow-auto px-2 pb-2">
                            <table className="min-w-full text-[11px]">
                              <thead className="bg-gray-50">
                                <tr>
                                  <th className="text-left p-2 border-b">Customer</th>
                                  <th className="text-right p-2 border-b">Qty</th>
                                  <th className="text-right p-2 border-b">User Curr.</th>
                                  <th className="text-right p-2 border-b">Customer Curr.</th>
                                  <th className="text-left p-2 border-b">Invoice</th>
                                  <th className="text-left p-2 border-b">Date</th>
                                </tr>
                              </thead>
                              <tbody>
                                {arr.map((r: any, i2: number) => (
                                  <tr key={i2}>
                                    <td className="p-2 border-b">{r.customerName}</td>
                                    <td className="p-2 border-b text-right">{r.qty}</td>
                                    <td className="p-2 border-b text-right">{r.userCurrencyAmount?.amount} {r.userCurrencyAmount?.currency ?? ''}</td>
                                    <td className="p-2 border-b text-right">{r.customerCurrencyAmount?.amount} {r.customerCurrencyAmount?.currency ?? ''}</td>
                                    <td className="p-2 border-b">{r.invoiceNo ?? '-'}</td>
                                    <td className="p-2 border-b">{r.invoiceDate ?? '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      ));
                    })()}
                  </div>
                </details>
              )}
            </div>
          )}
          {/* samples and raw JSON removed for cleaner UI */}
        </div>
      )}

      {/* Logs removed for a streamlined data view */}
    </div>
  );
}
