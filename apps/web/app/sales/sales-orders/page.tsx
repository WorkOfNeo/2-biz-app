'use client';
import React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';

type Job = { 
  id: string; 
  type: string; 
  status: string; 
  created_at: string; 
  started_at: string | null; 
  finished_at: string | null; 
  payload: any;
  result: any;
};

export default function SalesOrdersPage() {
  const supabase = createClientComponentClient();
  const [runningJobId, setRunningJobId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [rowLimit, setRowLimit] = React.useState<string>('');

  // Get running job
  const { data: running, mutate: mutateRunning } = useSWR('sales-orders:running', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, type, status, created_at, started_at, finished_at, payload, result')
      .eq('type', 'scrape_xlsx_sales_orders')
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0] as Job | undefined) ?? null;
  }, { refreshInterval: 5000 });

  // Get latest completed job
  const { data: latest, mutate: mutateLatest } = useSWR('sales-orders:latest', async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, type, status, created_at, started_at, finished_at, payload, result')
      .eq('type', 'scrape_xlsx_sales_orders')
      .in('status', ['succeeded', 'failed', 'cancelled'])
      .order('finished_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return (data?.[0] as Job | undefined) ?? null;
  }, { refreshInterval: 15000 });

  // Get job progress
  const { data: progress } = useSWR(running?.id ? `sales-orders:progress:${running.id}` : null, async () => {
    if (!running?.id) return null;
    
    const { data: logs, error } = await supabase
      .from('job_logs')
      .select('msg, data, ts')
      .eq('job_id', running.id)
      .in('msg', ['STEP:processing_customer', 'STEP:scrape_complete', 'STEP:scrape_error', 'STEP:customer_ids_extracted', 'STEP:row_limit_applied'])
      .order('ts', { ascending: false })
      .limit(100);
    
    if (error) throw new Error(error.message);
    
    // Find current progress
    let current = 0;
    let total = 0;
    let currentCustomerId: string | null = null;
    let stage: string = 'initializing';
    
    for (const log of (logs || [])) {
      if (log.msg === 'STEP:processing_customer' && log.data) {
        current = log.data.current || 0;
        total = log.data.total || 0;
        currentCustomerId = log.data.customer_id || null;
        stage = 'processing';
        break;
      } else if (log.msg === 'STEP:customer_ids_extracted' && log.data) {
        total = log.data.count || 0;
        if (stage === 'initializing') {
          stage = 'extracted';
        }
      } else if (log.msg === 'STEP:row_limit_applied' && log.data) {
        total = log.data.limited_count || 0;
      }
    }
    
    return {
      current,
      total,
      customer_id: currentCustomerId,
      stage,
      percent: total > 0 ? Math.floor((current / total) * 100) : 0
    };
  }, { refreshInterval: 2000 });

  // Get aggregated data summary
  const { data: dataSummary } = useSWR('sales-orders:summary', async () => {
    const { data, error } = await supabase
      .from('stock_sales_data')
      .select('style_no, color, size, total_qty, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1000);
    
    if (error) throw new Error(error.message);
    
    const totalRows = data?.length || 0;
    const totalQty = (data || []).reduce((sum, row) => sum + (Number(row.total_qty) || 0), 0);
    const lastUpdated = data?.[0]?.updated_at || null;
    
    return {
      totalRows,
      totalQty,
      lastUpdated
    };
  }, { refreshInterval: 30000 });

  const handleStartScrape = async () => {
    try {
      setBusy(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert('Not signed in');
        return;
      }

      const limit = rowLimit.trim() ? parseInt(rowLimit.trim(), 10) : null;
      if (limit !== null && (isNaN(limit) || limit <= 0)) {
        alert('Row limit must be a positive number');
        return;
      }

      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ 
          type: 'scrape_xlsx_sales_orders',
          payload: { 
            requestedBy: session.user.email || 'manual',
            rowLimit: limit
          }
        })
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Failed (${res.status})`);
      }

      const { jobId } = await res.json();
      setRunningJobId(jobId);
      await mutateRunning();
      await mutateLatest();
    } catch (error: any) {
      console.error('Failed to start scrape:', error);
      alert(`Failed to start scrape: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const isRunning = running?.status === 'running' || runningJobId !== null;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-gray-500">Sales</div>
        <h1 className="text-xl font-semibold">Sales Orders</h1>
        <p className="text-sm text-gray-600 mt-1">
          Scrape and aggregate sales order data from SPY system
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scrape Sales Orders</CardTitle>
          <CardDescription>
            Downloads Excel files from SPY sales/running page, parses style/color/size/quantity data,
            and aggregates totals per style/color/size combination.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
            <div className="flex-1 space-y-2">
              <label htmlFor="rowLimit" className="text-sm font-medium">
                Row Limit (for testing - leave empty for all rows)
              </label>
              <input
                id="rowLimit"
                type="number"
                min="1"
                value={rowLimit}
                onChange={(e) => setRowLimit(e.target.value)}
                placeholder="e.g., 10"
                disabled={busy || isRunning}
                className="w-full px-3 py-2 border rounded-md text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </div>
            <Button
              onClick={handleStartScrape}
              disabled={busy || isRunning}
              className="w-full sm:w-auto"
            >
              {busy ? 'Starting...' : isRunning ? 'Scraping in progress...' : 'Start Scrape'}
            </Button>
          </div>

          {isRunning && (
            <div className="space-y-2 p-4 bg-blue-50 rounded-lg border border-blue-200">
              {progress && progress.total > 0 ? (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Progress</span>
                    <span>{progress.current} / {progress.total} customers ({progress.percent}%)</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2.5">
                    <div
                      className="bg-blue-600 h-2.5 rounded-full transition-all"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                  {progress.customer_id && (
                    <div className="text-xs text-gray-600">
                      Processing customer: {progress.customer_id}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-gray-600">
                  {progress?.stage === 'extracted' ? 'Extracted customer IDs, starting to process...' : 'Initializing...'}
                </div>
              )}
            </div>
          )}

          {latest && (
            <div className="space-y-2 p-4 bg-gray-50 rounded-lg border">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Last Run</span>
                <span className={`text-xs px-2 py-1 rounded ${
                  latest.status === 'succeeded' ? 'bg-green-100 text-green-800' :
                  latest.status === 'failed' ? 'bg-red-100 text-red-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {latest.status}
                </span>
              </div>
              {latest.finished_at && latest.started_at && (
                <div className="text-xs text-gray-600 space-y-1">
                  <div>Finished: {new Date(latest.finished_at).toLocaleString()}</div>
                  {(() => {
                    const startTime = new Date(latest.started_at).getTime();
                    const endTime = new Date(latest.finished_at).getTime();
                    const durationMs = endTime - startTime;
                    const durationSec = Math.floor(durationMs / 1000);
                    const minutes = Math.floor(durationSec / 60);
                    const seconds = durationSec % 60;
                    const durationStr = minutes > 0 
                      ? `${minutes}m ${seconds}s` 
                      : `${seconds}s`;
                    return <div className="font-medium">Duration: {durationStr}</div>;
                  })()}
                </div>
              )}
              {latest.result && typeof latest.result === 'object' && (
                <div className="text-xs space-y-1 mt-2">
                  {latest.result.total_customers && (
                    <div>Total customers: {latest.result.total_customers}</div>
                  )}
                  {latest.result.success !== undefined && (
                    <div>Success: {latest.result.success}</div>
                  )}
                  {latest.result.failure !== undefined && (
                    <div>Failed: {latest.result.failure}</div>
                  )}
                  {latest.result.aggregated_rows !== undefined && (
                    <div>Aggregated rows: {latest.result.aggregated_rows}</div>
                  )}
                  {latest.result.total_qty !== undefined && (
                    <div>Total quantity: {latest.result.total_qty.toLocaleString()}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {dataSummary && (
            <div className="space-y-2 p-4 bg-gray-50 rounded-lg border">
              <div className="text-sm font-medium">Data Summary</div>
              <div className="text-xs space-y-1">
                <div>Total rows: {dataSummary.totalRows.toLocaleString()}</div>
                <div>Total quantity: {dataSummary.totalQty.toLocaleString()}</div>
                {dataSummary.lastUpdated && (
                  <div>Last updated: {new Date(dataSummary.lastUpdated).toLocaleString()}</div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
