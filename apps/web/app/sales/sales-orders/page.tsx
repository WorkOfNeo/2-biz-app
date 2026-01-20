'use client';
import React from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table';

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
  const [clearing, setClearing] = React.useState(false);

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
    let successCount = 0;
    let failureCount = 0;
    let aggregatedKeys = 0;
    
    for (const log of (logs || [])) {
      if (log.msg === 'STEP:processing_customer' && log.data) {
        current = log.data.current || 0;
        total = log.data.total || 0;
        currentCustomerId = log.data.customer_id || null;
        successCount = log.data.success_so_far || 0;
        failureCount = log.data.failure_so_far || 0;
        aggregatedKeys = log.data.aggregated_keys_so_far || 0;
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
      percent: total > 0 ? Math.floor((current / total) * 100) : 0,
      successCount,
      failureCount,
      aggregatedKeys
    };
  }, { refreshInterval: 2000 });

  // Get aggregated data with style names
  const { data: salesData, mutate: mutateSalesData } = useSWR('sales-orders:data', async () => {
    const { data, error } = await supabase
      .from('stock_sales_data')
      .select('style_no, color, size, total_qty, updated_at')
      .order('style_no', { ascending: true })
      .order('color', { ascending: true })
      .order('size', { ascending: true });
    
    if (error) throw new Error(error.message);
    return data || [];
  }, { refreshInterval: (running?.status === 'running' || runningJobId !== null) ? 2000 : 10000 });

  // Get style names for the style_nos
  const styleNos = React.useMemo(() => {
    if (!salesData) return [];
    return Array.from(new Set(salesData.map((r: any) => r.style_no).filter(Boolean)));
  }, [salesData]);

  const { data: styleNames } = useSWR(
    styleNos.length > 0 ? ['sales-orders:styles', styleNos.join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name')
        .in('style_no', styleNos);
      if (error) throw new Error(error.message);
      const map = new Map<string, string | null>();
      (data || []).forEach((r: any) => {
        map.set(r.style_no, r.style_name);
      });
      return map;
    },
    { refreshInterval: 0 }
  );

  // Transform data into grouped structure by style_no -> color -> size
  const groupedData = React.useMemo(() => {
    if (!salesData || !styleNames) return [];
    
    const grouped = new Map<string, {
      style_no: string;
      style_name: string | null;
      colors: Map<string, Map<string, number>>;
      allSizes: Set<string>;
    }>();

    for (const row of salesData) {
      const styleNo = row.style_no;
      const color = row.color || '';
      const size = row.size || '';
      const qty = Number(row.total_qty) || 0;

      if (!grouped.has(styleNo)) {
        grouped.set(styleNo, {
          style_no: styleNo,
          style_name: styleNames.get(styleNo) || null,
          colors: new Map(),
          allSizes: new Set()
        });
      }

      const styleGroup = grouped.get(styleNo)!;
      styleGroup.allSizes.add(size);

      if (!styleGroup.colors.has(color)) {
        styleGroup.colors.set(color, new Map());
      }

      const colorMap = styleGroup.colors.get(color)!;
      colorMap.set(size, (colorMap.get(size) || 0) + qty);
    }

    // Convert to array and sort sizes
    return Array.from(grouped.values()).map(style => ({
      ...style,
      allSizes: Array.from(style.allSizes).sort((a, b) => {
        // Try to sort sizes naturally (XS, S, M, L, XL, etc.)
        const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
        const aIdx = sizeOrder.indexOf(a.toUpperCase());
        const bIdx = sizeOrder.indexOf(b.toUpperCase());
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      })
    }));
  }, [salesData, styleNames]);

  // Calculate summary stats
  const dataSummary = React.useMemo(() => {
    if (!salesData) return null;
    const totalRows = salesData.length;
    const totalQty = salesData.reduce((sum: number, row: any) => sum + (Number(row.total_qty) || 0), 0);
    const lastUpdated = salesData.length > 0 
      ? salesData.reduce((latest: string | null, row: any) => {
          const rowTime = row.updated_at;
          if (!latest) return rowTime;
          return rowTime > latest ? rowTime : latest;
        }, null)
      : null;
    return { totalRows, totalQty, lastUpdated };
  }, [salesData]);

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

  const handleClearData = async () => {
    if (!confirm('Are you sure you want to clear all sales orders data? This cannot be undone.')) {
      return;
    }

    try {
      setClearing(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert('Not signed in');
        return;
      }

      const res = await fetch('/api/sales/clear-sales-orders', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        }
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Failed (${res.status})`);
      }

      await mutateSalesData();
      alert('Data cleared successfully');
    } catch (error: any) {
      console.error('Failed to clear data:', error);
      alert(`Failed to clear data: ${error.message}`);
    } finally {
      setClearing(false);
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
                    <span className="font-mono tabular-nums">
                      {progress.current.toLocaleString()} / {progress.total.toLocaleString()} customers ({progress.percent}%)
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs font-mono tabular-nums">
                    {progress.customer_id && (
                      <span className="text-gray-600">
                        Customer: <span className="font-semibold">{progress.customer_id}</span>
                      </span>
                    )}
                    <span className="text-green-700">
                      ✓ {progress.successCount.toLocaleString()} success
                    </span>
                    {progress.failureCount > 0 && (
                      <span className="text-red-600">
                        ✗ {progress.failureCount.toLocaleString()} failed
                      </span>
                    )}
                    {progress.aggregatedKeys > 0 && (
                      <span className="text-blue-700">
                        📊 {progress.aggregatedKeys.toLocaleString()} unique items
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-sm text-gray-600">
                  {progress?.stage === 'extracted' 
                    ? `Extracted ${progress?.total?.toLocaleString() || 0} customer IDs, starting to process...` 
                    : 'Initializing...'}
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
                <div className="text-xs space-y-1 mt-2 font-mono tabular-nums">
                  {latest.result.total_customers !== undefined && (
                    <div>Total customers: {latest.result.total_customers.toLocaleString()}</div>
                  )}
                  {latest.result.success !== undefined && (
                    <div>Success: {latest.result.success.toLocaleString()}</div>
                  )}
                  {latest.result.failure !== undefined && (
                    <div>Failed: {latest.result.failure.toLocaleString()}</div>
                  )}
                  {latest.result.aggregated_rows !== undefined && (
                    <div>Aggregated rows: {latest.result.aggregated_rows.toLocaleString()}</div>
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
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Data Summary</div>
                <Button
                  onClick={handleClearData}
                  disabled={clearing || isRunning}
                  variant="outline"
                  size="sm"
                  className="text-xs"
                >
                  {clearing ? 'Clearing...' : 'Clear Data'}
                </Button>
              </div>
              <div className="text-xs space-y-1 font-mono tabular-nums">
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

      {groupedData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Sales Data by Style</CardTitle>
            <CardDescription>
              Aggregated sales order quantities grouped by style, color, and size
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              {groupedData.map((style) => (
                <div key={style.style_no} className="mb-8 last:mb-0">
                  <div className="mb-2 pb-2 border-b">
                    <div className="font-semibold text-sm">{style.style_no}</div>
                    {style.style_name && (
                      <div className="text-xs text-gray-600">{style.style_name}</div>
                    )}
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Color</TableHead>
                        {style.allSizes.map((size) => (
                          <TableHead key={size} className="text-center min-w-16">
                            {size || '(empty)'}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Array.from(style.colors.entries())
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([color, sizeMap]) => (
                          <TableRow key={color}>
                            <TableCell className="font-medium">{color || '(empty)'}</TableCell>
                            {style.allSizes.map((size) => {
                              const qty = sizeMap.get(size) || 0;
                              return (
                                <TableCell key={size} className="text-center font-mono tabular-nums">
                                  {qty > 0 ? (
                                    <span className="transition-all duration-300">{qty.toLocaleString()}</span>
                                  ) : (
                                    <span className="text-gray-300">-</span>
                                  )}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
