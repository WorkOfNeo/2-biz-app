'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';

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

  // Build current week dates and MM/DD keys
  const { weekDates, weekKeys, today } = useMemo(() => {
    const now = new Date();
    const weekStart = getWeekStart(now);
    const dates = buildWeekDates(weekStart);
    const keys = dates.map(formatMMDD);
    return { weekDates: dates, weekKeys: keys, today: formatMMDD(now) };
  }, []);

  // Group POs by weekday column
  const { columns, outsideWeek } = useMemo(() => {
    const cols: PoRow[][] = Array.from({ length: 7 }, () => []);
    const outside: PoRow[] = [];

    for (const po of rows) {
      const normalized = normalizeEta(po.eta);
      if (!normalized) {
        outside.push(po);
        continue;
      }
      const idx = weekKeys.indexOf(normalized);
      if (idx >= 0) {
        cols[idx]!.push(po);
      } else {
        outside.push(po);
      }
    }

    return { columns: cols, outsideWeek: outside };
  }, [rows, weekKeys]);

  return (
    <div className="p-4 space-y-4 max-w-full">
      <div>
        <div className="text-xs text-slate-500">Purchase</div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-slate-600 mt-1">
          Week of {weekDates[0]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {weekDates[6]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </p>
      </div>

      {loading && rows.length === 0 && (
        <div className="text-center py-8 text-slate-500">Loading...</div>
      )}

      {/* Kanban Board */}
      <div className="grid grid-cols-7 gap-3 min-h-[60vh]">
        {WEEKDAYS.map((day, idx) => {
          const isWeekend = idx >= 5;
          const isToday = weekKeys[idx] === today;
          const columnPOs = columns[idx] ?? [];

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
              <div className={`flex-1 p-2 space-y-2 overflow-y-auto ${isWeekend ? 'opacity-60' : ''}`}>
                {columnPOs.length === 0 && (
                  <div className="text-xs text-slate-400 text-center py-4">No POs</div>
                )}
                {columnPOs.map((po) => (
                  <Card key={po.po_no} className="shadow-sm hover:shadow-md transition-shadow">
                    <CardContent className="p-3 space-y-1">
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
                      {po.supplier && (
                        <div className="text-xs text-slate-600">{po.supplier}</div>
                      )}
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

