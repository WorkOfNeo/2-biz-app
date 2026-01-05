'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type PoRow = {
  status: string | null;
  po_no: string;
  supplier: string | null;
  styles: number | null;
  ordered: number | null;
  etd: string | null;
  eta: string | null;
  purchaser: string | null;
  po_link: string | null;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Get Monday of the current week */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // Adjust to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Build array of 7 dates (Mon-Sun) for the current week */
function buildWeekDates(weekStart: Date): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    dates.push(d);
  }
  return dates;
}

/** Format date to MM/DD (zero-padded) */
function formatMMDD(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

/** 
 * Normalize ETA string to MM/DD format
 * Handles: "1/5", "01/05", "2025-01-05", etc.
 */
function normalizeEta(eta: string | null | undefined): string | null {
  if (!eta) return null;
  const trimmed = eta.trim();
  if (!trimmed) return null;

  // Try MM/DD or M/D pattern first
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const mm = slashMatch[1]!.padStart(2, '0');
    const dd = slashMatch[2]!.padStart(2, '0');
    return `${mm}/${dd}`;
  }

  // Try ISO date (YYYY-MM-DD or with time)
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[2]}/${isoMatch[3]}`;
  }

  // Try other common formats like DD/MM/YYYY or MM/DD/YYYY
  const fullSlashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (fullSlashMatch) {
    // Assume MM/DD/YYYY for US format
    const mm = fullSlashMatch[1]!.padStart(2, '0');
    const dd = fullSlashMatch[2]!.padStart(2, '0');
    return `${mm}/${dd}`;
  }

  return null;
}

export default function PurchaseDashboardPage() {
  const supabase = createClientComponentClient();
  const [rows, setRows] = useState<PoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSupplier, setSelectedSupplier] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0); // 0 = current week, -1 = last week, 1 = next week
  const [showWeekends, setShowWeekends] = useState(false);

  async function fetchRows() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('status, po_no, supplier, styles, ordered, etd, eta, purchaser, po_link')
        .order('status', { ascending: true })
        .order('updated_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      setRows((data ?? []) as PoRow[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRows();
    const id = setInterval(fetchRows, 30000); // Refresh every 30s
    return () => clearInterval(id);
  }, []);

  // Build week dates and MM/DD keys based on offset
  const { weekDates, weekKeys, today } = useMemo(() => {
    const now = new Date();
    const todayKey = formatMMDD(now);
    const baseWeekStart = getWeekStart(now);
    // Apply week offset
    const weekStart = new Date(baseWeekStart);
    weekStart.setDate(weekStart.getDate() + weekOffset * 7);
    const dates = buildWeekDates(weekStart);
    const keys = dates.map(formatMMDD);
    return { weekDates: dates, weekKeys: keys, today: todayKey };
  }, [weekOffset]);

  // Get unique suppliers sorted alphabetically
  const suppliers = useMemo(() => {
    const set = new Set<string>();
    for (const po of rows) {
      set.add(po.supplier || 'Unknown');
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Filter rows by selected supplier
  const filteredRows = useMemo(() => {
    if (!selectedSupplier) return rows;
    return rows.filter((po) => (po.supplier || 'Unknown') === selectedSupplier);
  }, [rows, selectedSupplier]);

  // Group POs by weekday column, then by supplier
  const { columns, outsideWeek } = useMemo(() => {
    type SupplierGroup = { supplier: string; pos: PoRow[] };
    const cols: SupplierGroup[][] = Array.from({ length: 7 }, () => []);
    const outside: PoRow[] = [];

    // First pass: group by day
    const dayPOs: PoRow[][] = Array.from({ length: 7 }, () => []);
    for (const po of filteredRows) {
      const normalized = normalizeEta(po.eta);
      if (!normalized) {
        outside.push(po);
        continue;
      }
      const idx = weekKeys.indexOf(normalized);
      if (idx >= 0) {
        dayPOs[idx]!.push(po);
      } else {
        outside.push(po);
      }
    }

    // Second pass: group each day's POs by supplier
    for (let i = 0; i < 7; i++) {
      const supplierMap = new Map<string, PoRow[]>();
      for (const po of dayPOs[i]!) {
        const key = po.supplier || 'Unknown';
        if (!supplierMap.has(key)) {
          supplierMap.set(key, []);
        }
        supplierMap.get(key)!.push(po);
      }
      // Convert to array and sort by supplier name
      cols[i] = Array.from(supplierMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([supplier, pos]) => ({ supplier, pos }));
    }

    return { columns: cols, outsideWeek: outside };
  }, [filteredRows, weekKeys]);

  // Days to display (5 or 7 based on showWeekends)
  const displayDays = showWeekends ? WEEKDAYS : WEEKDAYS.slice(0, 5);

  return (
    <div className="p-4 space-y-4 max-w-full">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase</div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
        </div>
        
        {/* Week Navigation & Controls */}
        <div className="flex items-center gap-4">
          {/* Show Weekends Checkbox */}
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showWeekends}
              onChange={(e) => setShowWeekends(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-slate-800 focus:ring-slate-500"
            />
            Show weekends
          </label>
          
          {/* Week Navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setWeekOffset((prev) => prev - 1)}
              className="p-1.5 rounded hover:bg-slate-100 transition-colors"
              title="Previous week"
            >
              <ChevronLeft className="w-5 h-5 text-slate-600" />
            </button>
            <button
              onClick={() => setWeekOffset(0)}
              className={`
                px-3 py-1 text-xs rounded border transition-colors
                ${weekOffset === 0
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                }
              `}
            >
              Today
            </button>
            <button
              onClick={() => setWeekOffset((prev) => prev + 1)}
              className="p-1.5 rounded hover:bg-slate-100 transition-colors"
              title="Next week"
            >
              <ChevronRight className="w-5 h-5 text-slate-600" />
            </button>
          </div>
        </div>
      </div>
      
      {/* Week Label */}
      <p className="text-sm text-slate-600">
        Week of {weekDates[0]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {weekDates[6]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        {weekOffset !== 0 && (
          <span className="ml-2 text-xs text-slate-400">
            ({weekOffset > 0 ? `+${weekOffset}` : weekOffset} week{Math.abs(weekOffset) !== 1 ? 's' : ''})
          </span>
        )}
      </p>

      {loading && rows.length === 0 && (
        <div className="text-center py-8 text-slate-500">Loading...</div>
      )}

      {/* Supplier Filter Tabs */}
      {suppliers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500 mr-1">Filter by supplier:</span>
          <button
            onClick={() => setSelectedSupplier(null)}
            className={`
              px-3 py-1.5 text-xs rounded-full border transition-colors
              ${selectedSupplier === null
                ? 'bg-slate-800 text-white border-slate-800'
                : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400 hover:bg-slate-50'
              }
            `}
          >
            All ({rows.length})
          </button>
          {suppliers.map((supplier) => {
            const count = rows.filter((po) => (po.supplier || 'Unknown') === supplier).length;
            const isActive = selectedSupplier === supplier;
            return (
              <button
                key={supplier}
                onClick={() => setSelectedSupplier(supplier)}
                className={`
                  px-3 py-1.5 text-xs rounded-full border transition-colors
                  ${isActive
                    ? 'bg-slate-800 text-white border-slate-800'
                    : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400 hover:bg-slate-50'
                  }
                `}
              >
                {supplier} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Kanban Board */}
      <div className={`grid gap-3 min-h-[60vh] ${showWeekends ? 'grid-cols-7' : 'grid-cols-5'}`}>
        {displayDays.map((day, displayIdx) => {
          // Map display index to actual weekday index
          const idx = WEEKDAYS.indexOf(day);
          const isWeekend = idx >= 5;
          const isToday = weekKeys[idx] === today;
          const columnGroups = columns[idx] ?? [];

          return (
            <div
              key={day}
              className={`
                flex flex-col rounded-lg border
                ${isWeekend ? 'bg-slate-100 border-slate-200' : 'bg-white border-slate-200'}
                ${isToday ? 'ring-2 ring-blue-400' : ''}
              `}
            >
              {/* Column Header */}
              <div
                className={`
                  px-3 py-2 border-b font-medium text-sm flex items-center justify-between
                  ${isWeekend ? 'bg-slate-200 text-slate-500' : 'bg-slate-50 text-slate-700'}
                `}
              >
                <span>{day}</span>
                <span className="text-xs font-normal">{weekKeys[idx]}</span>
              </div>

              {/* Column Content */}
              <div className={`flex-1 p-2 space-y-3 overflow-y-auto ${isWeekend ? 'opacity-60' : ''}`}>
                {columnGroups.length === 0 && (
                  <div className="text-xs text-slate-400 text-center py-4">No POs</div>
                )}
                {columnGroups.map((group) => (
                  <div key={group.supplier} className="space-y-1.5">
                    {/* Supplier Header */}
                    <div className="px-2 py-1 bg-slate-100 rounded text-xs font-semibold text-slate-700 sticky top-0">
                      {group.supplier}
                      <span className="ml-1 font-normal text-slate-500">({group.pos.length})</span>
                    </div>
                    {/* PO Cards for this supplier */}
                    {group.pos.map((po) => (
                      <Card key={po.po_no} className="shadow-sm hover:shadow-md transition-shadow">
                        <CardContent className="p-2.5 space-y-1">
                          <div className="font-semibold text-sm">
                            {po.po_link ? (
                              <a
                                href={po.po_link}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                {po.po_no}
                              </a>
                            ) : (
                              po.po_no
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            {po.status && (
                              <span
                                className={`
                                  px-1.5 py-0.5 rounded text-xs
                                  ${po.status === 'Shipped' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}
                                `}
                              >
                                {po.status}
                              </span>
                            )}
                            {po.ordered !== null && (
                              <span>{po.ordered} pcs</span>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Outside this week / No ETA */}
      {outsideWeek.length > 0 && (
        <Card className="border-slate-300 bg-slate-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-slate-600">
              Outside this week / No ETA ({outsideWeek.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {outsideWeek.slice(0, 20).map((po) => (
                <div
                  key={po.po_no}
                  className="px-2 py-1 bg-white border rounded text-xs"
                >
                  {po.po_link ? (
                    <a
                      href={po.po_link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {po.po_no}
                    </a>
                  ) : (
                    po.po_no
                  )}
                  <span className="text-slate-400 ml-1">
                    {po.eta ? `(${po.eta})` : '(no ETA)'}
                  </span>
                </div>
              ))}
              {outsideWeek.length > 20 && (
                <div className="px-2 py-1 text-xs text-slate-500">
                  +{outsideWeek.length - 20} more
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

