'use client';
import React, { useState, useMemo, useEffect } from 'react';
import useSWR from 'swr';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { SearchSelect } from '../../../components/SearchSelect';

type SalesRow = {
  style_no: string;
  color: string;
  date: string;
  size: string;
  quantity: number;
};

type AggregatedData = {
  size: string;
  quantity: number;
};

export default function StyleStatisticsPage() {
  const supabase = createClientComponentClient();
  const [selectedStyleNo, setSelectedStyleNo] = useState<string>('');
  const [colors, setColors] = useState<string[]>([]);
  const [selectedColor, setSelectedColor] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [salesData, setSalesData] = useState<SalesRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch available styles using SWR
  const { data: styles } = useSWR('styles:all:statistics', async () => {
    const { data, error } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier')
      .order('style_no', { ascending: true })
      .limit(5000);
    if (error) throw error;
    return (data ?? []) as Array<{ id: string; style_no: string; style_name: string | null; supplier: string | null }>;
  }, { refreshInterval: 0 });

  // Fetch available colors when style is selected
  useEffect(() => {
    async function fetchColors() {
      if (!selectedStyleNo) {
        setColors([]);
        setSelectedColor('');
        return;
      }

      try {
        const response = await fetch('/api/historical-sales/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            style_nos: [selectedStyleNo],
            limit: 1000
          })
        });
        const json = await response.json();
        if (response.ok && json.data) {
          const uniqueColors = Array.from(
            new Set(json.data.map((row: SalesRow) => row.color))
          ).sort() as string[];
          setColors(uniqueColors);
          if (uniqueColors.length > 0 && !uniqueColors.includes(selectedColor)) {
            const firstColor = uniqueColors[0];
            if (firstColor) {
              setSelectedColor(firstColor);
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch colors:', err);
      }
    }
    fetchColors();
  }, [selectedStyleNo]);

  // Aggregate data by size
  const aggregatedData = useMemo<AggregatedData[]>(() => {
    if (!salesData || salesData.length === 0) return [];

    const sizeMap = new Map<string, number>();
    for (const row of salesData) {
      const currentQty = sizeMap.get(row.size) || 0;
      sizeMap.set(row.size, currentQty + row.quantity);
    }

    const result = Array.from(sizeMap.entries())
      .map(([size, quantity]) => ({ size, quantity }))
      .sort((a, b) => {
        // Try to sort numerically if possible, otherwise alphabetically
        const aNum = parseInt(a.size);
        const bNum = parseInt(b.size);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return aNum - bNum;
        }
        return a.size.localeCompare(b.size);
      });

    return result;
  }, [salesData]);

  // Calculate max quantity for scaling
  const maxQuantity = useMemo(() => {
    return aggregatedData.reduce((max, item) => Math.max(max, item.quantity), 0);
  }, [aggregatedData]);

  async function fetchSalesData() {
    if (!selectedStyleNo || !selectedColor) {
      setError('Please select both a style and color.');
      return;
    }

    setError(null);
    setLoading(true);
    setSalesData([]);

    try {
      const payload: any = {
        style_nos: [selectedStyleNo],
        colors: [selectedColor]
      };
      if (dateFrom) payload.start_date = dateFrom;
      if (dateTo) payload.end_date = dateTo;

      const response = await fetch('/api/historical-sales/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const json = await response.json();
      if (!response.ok) {
        setError(json.error || 'Failed to fetch sales data');
        return;
      }

      setSalesData(json.data || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch sales data');
    } finally {
      setLoading(false);
    }
  }

  const styleOptions = (styles ?? []).map(s => ({
    value: s.style_no,
    label: `${s.style_no}${s.style_name ? ` - ${s.style_name}` : ''}`
  }));

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div>
        <div className="text-xs text-slate-500">Purchase</div>
        <h1 className="text-2xl font-semibold">Style Statistics</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Historical Sales by Size</CardTitle>
          <CardDescription>
            Select a style and color to view historical sales quantities by size. 
            Data is aggregated for the selected period.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">Style</label>
              <SearchSelect
                items={styleOptions}
                value={selectedStyleNo}
                onChange={setSelectedStyleNo}
                placeholder={!styles ? 'Loading styles...' : 'Select style...'}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">Color</label>
              <select
                className="w-full h-9 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                value={selectedColor}
                onChange={(e) => setSelectedColor(e.target.value)}
                disabled={!selectedStyleNo || colors.length === 0}
              >
                {colors.length === 0 ? (
                  <option value="">No colors available</option>
                ) : (
                  colors.map((color) => (
                    <option key={color} value={color}>
                      {color}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">From date</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700">To date</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Button
              onClick={fetchSalesData}
              disabled={loading || !selectedStyleNo || !selectedColor}
            >
              {loading ? 'Loading...' : 'Load Statistics'}
            </Button>
          </div>

          {error && (
            <div className="p-3 rounded-md text-sm bg-red-50 text-red-900 border border-red-200">
              {error}
            </div>
          )}

          {/* Color Switcher */}
          {aggregatedData.length > 0 && colors.length > 1 && (
            <div className="border-t pt-4">
              <div className="text-sm font-medium text-slate-700 mb-2">Switch Color:</div>
              <div className="flex flex-wrap gap-2">
                {colors.map((color) => (
                  <button
                    key={color}
                    onClick={() => {
                      setSelectedColor(color);
                      // Auto-reload data when color changes
                      setTimeout(() => {
                        if (selectedStyleNo) {
                          fetchSalesData();
                        }
                      }, 50);
                    }}
                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                      selectedColor === color
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {color}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Chart */}
          {aggregatedData.length > 0 && (
            <div className="border-t pt-4">
              <div className="mb-4">
                <h3 className="text-sm font-semibold">
                  {selectedStyleNo} - {selectedColor}
                </h3>
                <p className="text-xs text-slate-600">
                  Period: {dateFrom || 'All'} to {dateTo || 'All'} | 
                  Total Quantity: {aggregatedData.reduce((sum, d) => sum + d.quantity, 0)}
                </p>
              </div>

              {/* Simple Bar Chart */}
              <div className="bg-white border rounded-lg p-4">
                <div className="space-y-3">
                  {aggregatedData.map((item) => {
                    const percentage = maxQuantity > 0 ? (item.quantity / maxQuantity) * 100 : 0;
                    return (
                      <div key={item.size} className="flex items-center gap-3">
                        <div className="w-16 text-sm font-medium text-slate-700">
                          {item.size}
                        </div>
                        <div className="flex-1 bg-slate-100 rounded-md overflow-hidden h-8">
                          <div
                            className="h-full bg-slate-800 flex items-center justify-end px-2 transition-all"
                            style={{ width: `${Math.max(percentage, 2)}%` }}
                          >
                            <span className="text-xs font-medium text-white">
                              {item.quantity}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Data Table */}
              <div className="mt-4 border rounded-md overflow-hidden">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="p-2 text-left font-semibold">Size</th>
                      <th className="p-2 text-right font-semibold">Quantity</th>
                      <th className="p-2 text-right font-semibold">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aggregatedData.map((item) => {
                      const total = aggregatedData.reduce((sum, d) => sum + d.quantity, 0);
                      const percentage = total > 0 ? (item.quantity / total) * 100 : 0;
                      return (
                        <tr key={item.size} className="border-t">
                          <td className="p-2">{item.size}</td>
                          <td className="p-2 text-right font-medium">{item.quantity}</td>
                          <td className="p-2 text-right text-slate-600">
                            {percentage.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t-2">
                    <tr>
                      <td className="p-2 font-semibold">Total</td>
                      <td className="p-2 text-right font-semibold">
                        {aggregatedData.reduce((sum, d) => sum + d.quantity, 0)}
                      </td>
                      <td className="p-2 text-right font-semibold">100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {!loading && salesData.length === 0 && selectedStyleNo && selectedColor && (
            <div className="text-center py-8 text-slate-500">
              No sales data found for the selected criteria.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

