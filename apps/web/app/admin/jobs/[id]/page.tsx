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
          {Array.isArray((data.result.data as any)?.samples) && (
            <div className="mt-3">
              <div className="text-sm font-medium mb-1">Sample rows per salesperson</div>
              <div className="overflow-auto border rounded">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-2 border-b">Salesperson</th>
                      <th className="text-left p-2 border-b">Customer</th>
                      <th className="text-left p-2 border-b">Account</th>
                      <th className="text-left p-2 border-b">Country</th>
                      <th className="text-left p-2 border-b">Qty</th>
                      <th className="text-left p-2 border-b">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {((data.result.data as any).samples as any[]).flatMap((s: any) =>
                      (s.rows || []).map((r: any, i: number) => (
                        <tr key={`${s.salesperson}-${i}`}>
                          <td className="p-2 border-b whitespace-nowrap">{s.salesperson}</td>
                          <td className="p-2 border-b">{r.customer}</td>
                          <td className="p-2 border-b font-mono">{r.account}</td>
                          <td className="p-2 border-b">{r.country}</td>
                          <td className="p-2 border-b text-right">{r.qty}</td>
                          <td className="p-2 border-b text-right">{r.amount}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-auto">{JSON.stringify(data.result.data, null, 2)}</pre>
        </div>
      )}

      <div className="border rounded">
        <div className="px-3 py-2 font-semibold bg-gray-50">Logs</div>
        <div className="max-h-[60vh] overflow-auto p-2 text-xs">
          {/* Group by salesperson for STEP:salesperson_done with collapsible rows */}
          {(() => {
            const groups = new Map<string, any[]>();
            for (const l of (data?.logs ?? [])) {
              if (l.msg === 'STEP:salesperson_done' && l.data?.name && Array.isArray(l.data?.rows)) {
                const key = l.data.name as string;
                const arr = groups.get(key) ?? [];
                groups.set(key, arr.concat(l));
              }
            }
            const entries = Array.from(groups.entries());
            if (entries.length === 0) {
              return <div className="text-gray-500">No per-salesperson logs captured.</div>;
            }
            return (
              <div className="space-y-2">
                {entries.map(([name, logs]) => (
                  <details key={name} className="border rounded">
                    <summary className="cursor-pointer select-none px-3 py-2 font-medium">
                      {name}
                      <span className="ml-2 text-gray-500 text-[11px]">{logs.reduce((a: number, l: any) => a + (l.data?.upserted ?? 0), 0)} rows</span>
                    </summary>
                    <div className="overflow-x-auto px-2 pb-2">
                      <table className="min-w-full text-[11px]">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="text-left p-2 border-b">Time</th>
                            <th className="text-left p-2 border-b">Account</th>
                            <th className="text-left p-2 border-b">Customer</th>
                            <th className="text-left p-2 border-b">Qty</th>
                            <th className="text-left p-2 border-b">Price</th>
                            <th className="text-left p-2 border-b">Op</th>
                          </tr>
                        </thead>
                        <tbody>
                          {logs.flatMap((l: any) => (l.data?.rows ?? []).map((r: any, i: number) => (
                            <tr key={`${l.id}-${i}`}>
                              <td className="p-2 border-b whitespace-nowrap text-gray-500">{new Date(l.ts).toLocaleTimeString()}</td>
                              <td className="p-2 border-b font-mono">{r.account}</td>
                              <td className="p-2 border-b">{r.customer}</td>
                              <td className="p-2 border-b text-right">{r.qty}</td>
                              <td className="p-2 border-b text-right">{r.price} {r.currency ?? ''}</td>
                              <td className="p-2 border-b"><span className={r.op === 'created' ? 'text-green-700' : 'text-blue-700'}>{r.op}</span></td>
                            </tr>
                          )))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
              </div>
            );
          })()}

          {/* Fallback: raw log list below */}
          <div className="mt-4 border-t pt-2">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-left p-2 border-b w-[110px]">Time</th>
                  <th className="text-left p-2 border-b w-[90px]">Level</th>
                  <th className="text-left p-2 border-b">Message</th>
                </tr>
              </thead>
              <tbody>
                {(data?.logs ?? []).map((l: any) => (
                  <tr key={l.id} className="align-top">
                    <td className="p-2 border-b whitespace-nowrap text-gray-500">{new Date(l.ts).toLocaleTimeString()}</td>
                    <td className="p-2 border-b"><span className={"px-1 rounded " + (l.level === 'error' ? 'bg-red-600 text-white' : 'bg-slate-800 text-white')}>{l.level}</span></td>
                    <td className="p-2 border-b">
                      <div className="font-medium mb-1">{l.msg}</div>
                      {l.data && (
                        <div className="overflow-x-auto">
                          <table className="min-w-[600px] border text-[11px]">
                            <tbody>
                              {Object.entries(l.data as Record<string, any>).map(([k, v]) => (
                                <tr key={k}>
                                  <td className="border px-2 py-1 text-gray-600 whitespace-nowrap">{k}</td>
                                  <td className="border px-2 py-1">
                                    {typeof v === 'object' ? <pre className="whitespace-pre-wrap break-words">{JSON.stringify(v, null, 2)}</pre> : String(v)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
