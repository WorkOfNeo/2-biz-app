'use client';
import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../../../lib/supabaseClient';
import useSWR from 'swr';
import { Save } from 'lucide-react';

type Salesperson = {
  id: string;
  name: string;
};

type StatisticInput = {
  salesperson_id: string;
  salesperson_name: string;
  total_leveret: number;
  telefon_stk: number;
  telefon_beløb: number;
  b2b_stk: number;
  b2b_beløb: number;
  krediteret_stk: number;
  krediteret_beløb: number;
  samlet_stk: number;
  samlet_beløb: number;
};

export default function HistoricalDataPage() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState(String(new Date().getMonth() + 1).padStart(2, '0'));
  const [inputs, setInputs] = useState<Map<string, StatisticInput>>(new Map());
  const [saving, setSaving] = useState(false);

  // Fetch salespersons
  const { data: salespersons } = useSWR('historical:salespersons', async () => {
    const { data, error } = await supabase
      .from('salespersons')
      .select('id, name')
      .order('sort_index', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Salesperson[];
  });

  // Load existing data for selected month/year
  useEffect(() => {
    async function loadExisting() {
      if (!salespersons || salespersons.length === 0) return;
      
      const yearMonth = `${selectedYear}-${selectedMonth}`;
      const { data, error } = await supabase
        .from('supp_statistic')
        .select('*')
        .eq('year_month', yearMonth)
        .order('salesperson_name');

      if (error) {
        console.error('Error loading existing data:', error);
        return;
      }

      const newInputs = new Map<string, StatisticInput>();
      
      // Initialize with salespersons
      for (const sp of salespersons) {
        const existing = (data ?? []).find((d: any) => d.salesperson_name === sp.name);
        newInputs.set(sp.id, {
          salesperson_id: sp.id,
          salesperson_name: sp.name,
          total_leveret: existing?.total_leveret ?? 0,
          telefon_stk: existing?.telefon_stk ?? 0,
          telefon_beløb: existing?.telefon_beløb ?? 0,
          b2b_stk: existing?.b2b_stk ?? 0,
          b2b_beløb: existing?.b2b_beløb ?? 0,
          krediteret_stk: existing?.krediteret_stk ?? 0,
          krediteret_beløb: existing?.krediteret_beløb ?? 0,
          samlet_stk: existing?.samlet_stk ?? 0,
          samlet_beløb: existing?.samlet_beløb ?? 0,
        });
      }

      setInputs(newInputs);
    }

    loadExisting();
  }, [selectedYear, selectedMonth, salespersons]);

  function updateInput(salespersonId: string, field: keyof StatisticInput, value: number) {
    setInputs((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(salespersonId);
      if (!existing) return prev;
      newMap.set(salespersonId, { ...existing, [field]: value });
      return newMap;
    });
  }

  async function saveAll() {
    if (!salespersons) return;
    
    setSaving(true);
    try {
      const yearMonth = `${selectedYear}-${selectedMonth}`;
      const recordsToSave = Array.from(inputs.values()).map((input) => ({
        year_month: yearMonth,
        salesperson_name: input.salesperson_name,
        total_leveret: input.total_leveret || 0,
        telefon_stk: input.telefon_stk || 0,
        telefon_beløb: input.telefon_beløb || 0,
        b2b_stk: input.b2b_stk || 0,
        b2b_beløb: input.b2b_beløb || 0,
        krediteret_stk: input.krediteret_stk || 0,
        krediteret_beløb: input.krediteret_beløb || 0,
        samlet_stk: input.samlet_stk || 0,
        samlet_beløb: input.samlet_beløb || 0,
      }));

      const { error } = await supabase
        .from('supp_statistic')
        .upsert(recordsToSave, {
          onConflict: 'year_month,salesperson_name',
        });

      if (error) throw error;

      alert(`Data gemt for ${formatMonthName(yearMonth)}`);
    } catch (err: any) {
      alert(`Fejl ved gemning: ${err.message}`);
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }

  function formatMonthName(yearMonth: string): string {
    const [year, month] = yearMonth.split('-');
    if (!year || !month) return yearMonth;
    const monthNum = parseInt(month, 10);
    const monthNames = [
      'Januar', 'Februar', 'Marts', 'April', 'Maj', 'Juni',
      'Juli', 'August', 'September', 'Oktober', 'November', 'December'
    ];
    const monthName = monthNames[monthNum - 1] || month;
    return `${monthName} ${year}`;
  }

  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const monthNum = String(i + 1).padStart(2, '0');
    return { value: monthNum, label: formatMonthName(`${selectedYear}-${monthNum}`) };
  });

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500">Statistics</div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Historisk Data - Suppleringer</h1>
        <button
          onClick={saveAll}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Gemmer...' : 'Gem Alle'}
        </button>
      </div>

      {/* Month and Year Selectors */}
      <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-md">
        <div className="flex items-center gap-2">
          <label htmlFor="year-select" className="text-sm font-medium">År:</label>
          <select
            id="year-select"
            value={selectedYear}
            onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
            className="text-sm border rounded px-3 py-1"
          >
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="month-select" className="text-sm font-medium">Måned:</label>
          <select
            id="month-select"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="text-sm border rounded px-3 py-1"
          >
            {monthOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Input Table */}
      {salespersons && salespersons.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-2 text-left border-r">Sælger</th>
                <th className="px-4 py-2 text-left border-r">Total leveret</th>
                <th className="px-4 py-2 text-left border-r">Telefon stk</th>
                <th className="px-4 py-2 text-right border-r">Telefon beløb</th>
                <th className="px-4 py-2 text-left border-r">B2B stk</th>
                <th className="px-4 py-2 text-right border-r">B2B beløb</th>
                <th className="px-4 py-2 text-left border-r">Krediteret stk</th>
                <th className="px-4 py-2 text-right border-r">Krediteret beløb</th>
                <th className="px-4 py-2 text-left border-r">Samlet stk</th>
                <th className="px-4 py-2 text-right">Samlet beløb</th>
              </tr>
            </thead>
            <tbody>
              {salespersons.map((sp) => {
                const input = inputs.get(sp.id);
                if (!input) return null;
                return (
                  <tr key={sp.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium border-r">{sp.name}</td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.total_leveret || ''}
                        onChange={(e) => updateInput(sp.id, 'total_leveret', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.telefon_stk || ''}
                        onChange={(e) => updateInput(sp.id, 'telefon_stk', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.telefon_beløb || ''}
                        onChange={(e) => updateInput(sp.id, 'telefon_beløb', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                        placeholder="i cents"
                      />
                    </td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.b2b_stk || ''}
                        onChange={(e) => updateInput(sp.id, 'b2b_stk', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.b2b_beløb || ''}
                        onChange={(e) => updateInput(sp.id, 'b2b_beløb', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                        placeholder="i cents"
                      />
                    </td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.krediteret_stk || ''}
                        onChange={(e) => updateInput(sp.id, 'krediteret_stk', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.krediteret_beløb || ''}
                        onChange={(e) => updateInput(sp.id, 'krediteret_beløb', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                        placeholder="i cents"
                      />
                    </td>
                    <td className="px-4 py-2 border-r">
                      <input
                        type="number"
                        value={input.samlet_stk || ''}
                        onChange={(e) => updateInput(sp.id, 'samlet_stk', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="number"
                        value={input.samlet_beløb || ''}
                        onChange={(e) => updateInput(sp.id, 'samlet_beløb', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border rounded"
                        placeholder="i cents"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

