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

type MonthlyAggregatedData = {
  month: string;
  data: AggregatedData[];
};

type WeeklyAggregatedData = {
  week: string;
  data: AggregatedData[];
};

type ViewType = 'total' | 'month' | 'week';

type DateRangePreset = 'custom' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'last_3_months' | 'last_6_months' | 'this_year';

export default function StyleStatisticsPage() {
  const supabase = createClientComponentClient();
  const [selectedStyleNo, setSelectedStyleNo] = useState<string>('');
  const [colors, setColors] = useState<string[]>([]);
  const [selectedColor, setSelectedColor] = useState<string>('');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [datePreset, setDatePreset] = useState<DateRangePreset>('last_3_months');
  const [salesData, setSalesData] = useState<SalesRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewType, setViewType] = useState<ViewType>('total');
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

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

  // Function to calculate date range based on preset
  const getDateRangeFromPreset = (preset: DateRangePreset): { from: string; to: string } => {
    const today = new Date();
    const formatDate = (date: Date) => date.toISOString().split('T')[0] ?? '';
    
    switch (preset) {
      case 'this_week': {
        const dayOfWeek = today.getDay();
        const monday = new Date(today);
        monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
        return { from: formatDate(monday) ?? '', to: formatDate(today) ?? '' };
      }
      case 'last_week': {
        const dayOfWeek = today.getDay();
        const lastMonday = new Date(today);
        lastMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) - 7);
        const lastSunday = new Date(lastMonday);
        lastSunday.setDate(lastMonday.getDate() + 6);
        return { from: formatDate(lastMonday) ?? '', to: formatDate(lastSunday) ?? '' };
      }
      case 'this_month': {
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        return { from: formatDate(firstDay) ?? '', to: formatDate(today) ?? '' };
      }
      case 'last_month': {
        const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
        return { from: formatDate(firstDay) ?? '', to: formatDate(lastDay) ?? '' };
      }
      case 'last_3_months': {
        const threeMonthsAgo = new Date(today);
        threeMonthsAgo.setMonth(today.getMonth() - 3);
        return { from: formatDate(threeMonthsAgo) ?? '', to: formatDate(today) ?? '' };
      }
      case 'last_6_months': {
        const sixMonthsAgo = new Date(today);
        sixMonthsAgo.setMonth(today.getMonth() - 6);
        return { from: formatDate(sixMonthsAgo) ?? '', to: formatDate(today) ?? '' };
      }
      case 'this_year': {
        const firstDay = new Date(today.getFullYear(), 0, 1);
        return { from: formatDate(firstDay) ?? '', to: formatDate(today) ?? '' };
      }
      case 'custom':
      default:
        return { from: dateFrom, to: dateTo };
    }
  };

  // Update dates when preset changes
  useEffect(() => {
    if (datePreset !== 'custom') {
      const { from, to } = getDateRangeFromPreset(datePreset);
      setDateFrom(from);
      setDateTo(to);
    }
  }, [datePreset]);

  // Fetch available colors when style is selected
  useEffect(() => {
    async function fetchColors() {
      if (!selectedStyleNo) {
        setColors([]);
        setSelectedColor('');
        setHasLoadedOnce(false);
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

  // Auto-load data after first selection and on subsequent changes
  useEffect(() => {
    if (hasLoadedOnce && selectedStyleNo && selectedColor) {
      fetchSalesData();
    }
  }, [selectedColor, dateFrom, dateTo]);

  // Check if multiple months or weeks are selected
  const hasMultipleMonths = useMemo(() => {
    if (!dateFrom || !dateTo) return false;
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    const monthsDiff = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    return monthsDiff >= 1;
  }, [dateFrom, dateTo]);

  const hasMultipleWeeks = useMemo(() => {
    if (!dateFrom || !dateTo) return false;
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    const daysDiff = Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    return daysDiff >= 7;
  }, [dateFrom, dateTo]);

  // Aggregate data by size (total view)
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

  // Aggregate data by month and size (month view)
  const monthlyAggregatedData = useMemo<MonthlyAggregatedData[]>(() => {
    if (!salesData || salesData.length === 0) return [];

    const monthMap = new Map<string, Map<string, number>>();
    
    for (const row of salesData) {
      const date = new Date(row.date);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, new Map<string, number>());
      }
      
      const sizeMap = monthMap.get(monthKey)!;
      const currentQty = sizeMap.get(row.size) || 0;
      sizeMap.set(row.size, currentQty + row.quantity);
    }

    const result = Array.from(monthMap.entries())
      .map(([month, sizeMap]) => ({
        month,
        data: Array.from(sizeMap.entries())
          .map(([size, quantity]) => ({ size, quantity }))
          .sort((a, b) => {
            const aNum = parseInt(a.size);
            const bNum = parseInt(b.size);
            if (!isNaN(aNum) && !isNaN(bNum)) {
              return aNum - bNum;
            }
            return a.size.localeCompare(b.size);
          })
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return result;
  }, [salesData]);

  // Aggregate data by week and size (week view)
  const weeklyAggregatedData = useMemo<WeeklyAggregatedData[]>(() => {
    if (!salesData || salesData.length === 0) return [];

    const weekMap = new Map<string, Map<string, number>>();
    
    for (const row of salesData) {
      const date = new Date(row.date);
      // Get week number (ISO week)
      const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
      const dayOfWeek = date.getDay() === 0 ? 6 : date.getDay() - 1; // Monday = 0
      const daysSinceMonday = date.getDate() - dayOfWeek;
      const mondayOfWeek = new Date(date.getFullYear(), date.getMonth(), daysSinceMonday);
      const weekKey = `${mondayOfWeek.getFullYear()}-W${String(Math.ceil((mondayOfWeek.getTime() - firstDayOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000))).padStart(2, '0')} (${mondayOfWeek.toISOString().split('T')[0]})`;
      
      if (!weekMap.has(weekKey)) {
        weekMap.set(weekKey, new Map<string, number>());
      }
      
      const sizeMap = weekMap.get(weekKey)!;
      const currentQty = sizeMap.get(row.size) || 0;
      sizeMap.set(row.size, currentQty + row.quantity);
    }

    const result = Array.from(weekMap.entries())
      .map(([week, sizeMap]) => ({
        week,
        data: Array.from(sizeMap.entries())
          .map(([size, quantity]) => ({ size, quantity }))
          .sort((a, b) => {
            const aNum = parseInt(a.size);
            const bNum = parseInt(b.size);
            if (!isNaN(aNum) && !isNaN(bNum)) {
              return aNum - bNum;
            }
            return a.size.localeCompare(b.size);
          })
      }))
      .sort((a, b) => a.week.localeCompare(b.week));

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
      setHasLoadedOnce(true);
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
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
              <label className="text-xs font-medium text-slate-700">Date Range</label>
              <select
                className="w-full h-9 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm"
                value={datePreset}
                onChange={(e) => setDatePreset(e.target.value as DateRangePreset)}
              >
                <option value="this_week">This Week</option>
                <option value="last_week">Last Week</option>
                <option value="this_month">This Month</option>
                <option value="last_month">Last Month</option>
                <option value="last_3_months">Last 3 Months</option>
                <option value="last_6_months">Last 6 Months</option>
                <option value="this_year">This Year</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>
          </div>

          {/* Custom Date Range Inputs */}
          {datePreset === 'custom' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700">From Date</label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700">To Date</label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              onClick={fetchSalesData}
              disabled={loading || !selectedStyleNo || !selectedColor}
            >
              {loading ? 'Loading...' : 'Load Statistics'}
            </Button>
            {dateFrom && dateTo && (
              <span className="text-xs text-slate-500">
                {dateFrom} to {dateTo}
              </span>
            )}
          </div>

          {error && (
            <div className="p-3 rounded-md text-sm bg-red-50 text-red-900 border border-red-200">
              {error}
            </div>
          )}

          {/* Color Switcher */}
          {(aggregatedData.length > 0 || loading) && colors.length > 1 && (
            <div className="border-t pt-4">
              <div className="text-sm font-medium text-slate-700 mb-2">Switch Color:</div>
              <div className="flex flex-wrap gap-2">
                {colors.map((color) => (
                  <button
                    key={color}
                    onClick={() => setSelectedColor(color)}
                    disabled={loading}
                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                      selectedColor === color
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {color}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* View Type Selector */}
          {aggregatedData.length > 0 && (hasMultipleMonths || hasMultipleWeeks) && (
            <div className="border-t pt-4">
              <div className="text-sm font-medium text-slate-700 mb-2">View Type:</div>
              <div className="flex gap-2">
                <Button
                  onClick={() => setViewType('total')}
                  variant={viewType === 'total' ? 'default' : 'outline'}
                  size="sm"
                >
                  Total
                </Button>
                {hasMultipleWeeks && (
                  <Button
                    onClick={() => setViewType('week')}
                    variant={viewType === 'week' ? 'default' : 'outline'}
                    size="sm"
                  >
                    By Week
                  </Button>
                )}
                {hasMultipleMonths && (
                  <Button
                    onClick={() => setViewType('month')}
                    variant={viewType === 'month' ? 'default' : 'outline'}
                    size="sm"
                  >
                    By Month
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Chart */}
          {loading && (
            <div className="border-t pt-4">
              <div className="text-center py-8 text-slate-500">
                Loading data...
              </div>
            </div>
          )}

          {!loading && aggregatedData.length > 0 && viewType === 'total' && (
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

              {/* Vertical Bar Chart */}
              <div className="bg-white border rounded-lg p-6">
                <div className="flex items-end justify-around gap-2 h-64">
                  {aggregatedData.map((item) => {
                    const total = aggregatedData.reduce((sum, d) => sum + d.quantity, 0);
                    const percentage = maxQuantity > 0 ? (item.quantity / maxQuantity) * 100 : 0;
                    const percentOfTotal = total > 0 ? (item.quantity / total) * 100 : 0;
                    return (
                      <div key={item.size} className="flex flex-col items-center flex-1 min-w-0">
                        <div className="flex-1 w-full flex flex-col justify-end items-center">
                          <div className="text-xs font-medium text-slate-700 mb-1">
                            {item.quantity}
                          </div>
                          <div className="text-xs text-slate-500 mb-1">
                            {percentOfTotal.toFixed(1)}%
                          </div>
                          <div
                            className="w-full bg-slate-800 rounded-t-md transition-all hover:bg-slate-700 flex items-end justify-center pb-2"
                            style={{ height: `${Math.max(percentage, 5)}%`, minHeight: '20px' }}
                          >
                          </div>
                        </div>
                        <div className="text-sm font-medium text-slate-700 mt-2 whitespace-nowrap">
                          {item.size}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Week View Charts */}
          {!loading && weeklyAggregatedData.length > 0 && viewType === 'week' && (
            <div className="border-t pt-4 space-y-8">
              {weeklyAggregatedData.map((weekData) => {
                const weekTotal = weekData.data.reduce((sum, d) => sum + d.quantity, 0);
                const weekMax = weekData.data.reduce((max, item) => Math.max(max, item.quantity), 0);
                
                return (
                  <div key={weekData.week}>
                    <div className="mb-4">
                      <h3 className="text-sm font-semibold">
                        {selectedStyleNo} - {selectedColor} - {weekData.week}
                      </h3>
                      <p className="text-xs text-slate-600">
                        Total Quantity: {weekTotal}
                      </p>
                    </div>

                    {/* Vertical Bar Chart */}
                    <div className="bg-white border rounded-lg p-6">
                      <div className="flex items-end justify-around gap-2 h-64">
                        {weekData.data.map((item) => {
                          const percentage = weekMax > 0 ? (item.quantity / weekMax) * 100 : 0;
                          const percentOfTotal = weekTotal > 0 ? (item.quantity / weekTotal) * 100 : 0;
                          return (
                            <div key={item.size} className="flex flex-col items-center flex-1 min-w-0">
                              <div className="flex-1 w-full flex flex-col justify-end items-center">
                                <div className="text-xs font-medium text-slate-700 mb-1">
                                  {item.quantity}
                                </div>
                                <div className="text-xs text-slate-500 mb-1">
                                  {percentOfTotal.toFixed(1)}%
                                </div>
                                <div
                                  className="w-full bg-slate-800 rounded-t-md transition-all hover:bg-slate-700"
                                  style={{ height: `${Math.max(percentage, 5)}%`, minHeight: '20px' }}
                                >
                                </div>
                              </div>
                              <div className="text-sm font-medium text-slate-700 mt-2 whitespace-nowrap">
                                {item.size}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Month View Charts */}
          {!loading && monthlyAggregatedData.length > 0 && viewType === 'month' && (
            <div className="border-t pt-4 space-y-8">
              {monthlyAggregatedData.map((monthData) => {
                const monthTotal = monthData.data.reduce((sum, d) => sum + d.quantity, 0);
                const monthMax = monthData.data.reduce((max, item) => Math.max(max, item.quantity), 0);
                
                return (
                  <div key={monthData.month}>
                    <div className="mb-4">
                      <h3 className="text-sm font-semibold">
                        {selectedStyleNo} - {selectedColor} - {monthData.month}
                      </h3>
                      <p className="text-xs text-slate-600">
                        Total Quantity: {monthTotal}
                      </p>
                    </div>

                    {/* Vertical Bar Chart */}
                    <div className="bg-white border rounded-lg p-6">
                      <div className="flex items-end justify-around gap-2 h-64">
                        {monthData.data.map((item) => {
                          const percentage = monthMax > 0 ? (item.quantity / monthMax) * 100 : 0;
                          const percentOfTotal = monthTotal > 0 ? (item.quantity / monthTotal) * 100 : 0;
                          return (
                            <div key={item.size} className="flex flex-col items-center flex-1 min-w-0">
                              <div className="flex-1 w-full flex flex-col justify-end items-center">
                                <div className="text-xs font-medium text-slate-700 mb-1">
                                  {item.quantity}
                                </div>
                                <div className="text-xs text-slate-500 mb-1">
                                  {percentOfTotal.toFixed(1)}%
                                </div>
                                <div
                                  className="w-full bg-slate-800 rounded-t-md transition-all hover:bg-slate-700"
                                  style={{ height: `${Math.max(percentage, 5)}%`, minHeight: '20px' }}
                                >
                                </div>
                              </div>
                              <div className="text-sm font-medium text-slate-700 mt-2 whitespace-nowrap">
                                {item.size}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
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

