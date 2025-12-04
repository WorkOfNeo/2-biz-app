'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';

export default function PurchaseMakeOrderPage() {
  const STORAGE_KEYS = React.useMemo(() => ({
    started: 'makeOrder.process1.started',
    step: 'makeOrder.process1.step',
    returnPath: 'makeOrder.process1.returnPath',
    selectedStyles: 'makeOrder.process1.selectedStyles',
    selections: 'makeOrder.process1.selections',
    inputs: 'makeOrder.process1.inputs',
    manualSales: 'makeOrder.process1.manualSales'
  }), []);

  const [started, setStarted] = React.useState<boolean>(false);
  const [step, setStep] = React.useState<number>(1);
  const [returnPath, setReturnPath] = React.useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Step 1: Selected style numbers only
  const [selectedStyles, setSelectedStyles] = React.useState<string[]>([]);
  
  // Step 2: Selected style_no + color pairs
  type Selection = { style_no: string; color: string };
  const [selections, setSelections] = React.useState<Selection[]>([]);

  // Step 3: Inputs per style/color/size
  type InputRecord = Record<string, number[]>; // key: "style_no|color"
  const [inputsByKey, setInputsByKey] = React.useState<InputRecord>({});
  
  // Manual sales data per style/color/size
  const [manualSalesData, setManualSalesData] = React.useState<InputRecord>({});

  // Load persisted state
  React.useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEYS.started);
      const r = localStorage.getItem(STORAGE_KEYS.returnPath);
      const st = localStorage.getItem(STORAGE_KEYS.step);
      const styles = localStorage.getItem(STORAGE_KEYS.selectedStyles);
      const sel = localStorage.getItem(STORAGE_KEYS.selections);
      const inp = localStorage.getItem(STORAGE_KEYS.inputs);
      const manSales = localStorage.getItem(STORAGE_KEYS.manualSales);
      
      if (s === '1') setStarted(true);
      if (typeof r === 'string') setReturnPath(r);
      if (st) {
        const num = Number(st) || 1;
        setStep(num >= 1 && num <= 4 ? num : 1);
      }
      if (styles) {
        try { setSelectedStyles(JSON.parse(styles) as string[]); } catch {}
      }
      if (sel) {
        try { setSelections(JSON.parse(sel) as Selection[]); } catch {}
      }
      if (inp) {
        try { setInputsByKey(JSON.parse(inp) as InputRecord); } catch {}
      }
      if (manSales) {
        try { setManualSalesData(JSON.parse(manSales) as InputRecord); } catch {}
      }
    } catch {}
  }, [STORAGE_KEYS]);

  // Persist state
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.step, String(step)); } catch {}
  }, [step, STORAGE_KEYS.step]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selectedStyles, JSON.stringify(selectedStyles)); } catch {}
  }, [selectedStyles, STORAGE_KEYS.selectedStyles]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selections, JSON.stringify(selections)); } catch {}
  }, [selections, STORAGE_KEYS.selections]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.inputs, JSON.stringify(inputsByKey)); } catch {}
  }, [inputsByKey, STORAGE_KEYS.inputs]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.manualSales, JSON.stringify(manualSalesData)); } catch {}
  }, [manualSalesData, STORAGE_KEYS.manualSales]);

  function startProcess() {
    try {
      let from: string | null = null;
      try {
        const ref = document.referrer || '';
        if (ref) {
          const u = new URL(ref);
          const cur = new URL(window.location.href);
          if (u.origin === cur.origin) from = u.pathname + u.search + u.hash;
        }
      } catch {}
      if (!from) from = '/';
      localStorage.setItem(STORAGE_KEYS.returnPath, from);
      localStorage.setItem(STORAGE_KEYS.started, '1');
      setReturnPath(from);
      setStarted(true);
      setStep(1);
    } catch {}
  }

  function resetProcess() {
    try {
      Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
      setStarted(false);
      setStep(1);
      setSelectedStyles([]);
      setSelections([]);
      setInputsByKey({});
      setManualSalesData({});
      setReturnPath(null);
    } catch {}
  }

  // Sync step with URL slug
  React.useEffect(() => {
    try {
      const m = pathname?.match(/\/purchase\/make-order\/step\/(\d+)/i);
      if (m && m[1]) {
        const n = Math.max(1, Math.min(4, Number(m[1]) || 1));
        setStep(n);
      }
    } catch {}
  }, [pathname]);

  React.useEffect(() => {
    if (!started) return;
    const target = `/purchase/make-order/step/${step}`;
    if (pathname !== target) {
      try { router.push(target as any); } catch {}
    }
  }, [step, started, pathname, router]);

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase</div>
          <h1 className="text-2xl font-semibold">Make Order</h1>
        </div>
        {returnPath && (
          <a href={returnPath} className="text-sm underline text-blue-700 hover:text-blue-800">
            Back to previous page
          </a>
        )}
      </div>

      {/* Progress indicator */}
      {started && (
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
                  s === step
                    ? 'bg-slate-900 text-white'
                    : s < step
                    ? 'bg-green-500 text-white'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {s}
              </div>
              {s < 4 && (
                <div className={`w-16 h-0.5 ${s < step ? 'bg-green-500' : 'bg-slate-200'}`} />
              )}
            </div>
          ))}
          <div className="ml-4 text-sm text-slate-600">
            {step === 1 && 'Choose Styles'}
            {step === 2 && 'Choose Colors'}
            {step === 3 && 'Enter Order Quantities'}
            {step === 4 && 'Review & Confirm'}
          </div>
          <Button variant="ghost" size="sm" onClick={resetProcess} className="ml-auto">
            Reset Process
          </Button>
        </div>
      )}

      {!started && (
        <Card>
          <CardHeader>
            <CardTitle>Purchase Order Process</CardTitle>
            <CardDescription>
              Start the guided 4-step order flow to create your purchase order.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={startProcess}>Start Purchase Order</Button>
          </CardContent>
        </Card>
      )}

      {started && step === 1 && <Step1ChooseStyles selectedStyles={selectedStyles} setSelectedStyles={setSelectedStyles} onContinue={() => setStep(2)} />}
      {started && step === 2 && <Step2ChooseColors selectedStyles={selectedStyles} selections={selections} setSelections={setSelections} onBack={() => setStep(1)} onContinue={() => setStep(3)} />}
      {started && step === 3 && <Step3EnterQuantities selections={selections} inputsByKey={inputsByKey} setInputsByKey={setInputsByKey} manualSalesData={manualSalesData} setManualSalesData={setManualSalesData} onBack={() => setStep(2)} onContinue={() => setStep(4)} />}
      {started && step === 4 && <Step4Review selections={selections} inputsByKey={inputsByKey} onBack={() => setStep(3)} onReset={resetProcess} />}
    </div>
  );
}

// ==================== STEP 1: Choose Styles ====================
function Step1ChooseStyles({
  selectedStyles,
  setSelectedStyles,
  onContinue
}: {
  selectedStyles: string[];
  setSelectedStyles: React.Dispatch<React.SetStateAction<string[]>>;
  onContinue: () => void;
}) {
  const [q, setQ] = React.useState('');
  const { data: styleList } = useSWR(
    ['makeOrder:styles', q],
    async () => {
      let query = supabase
        .from('styles')
        .select('id, style_no, style_name, supplier, image_url')
        .order('style_no', { ascending: true })
        .limit(200);
    const qq = q.trim();
    if (qq) {
      query = query.or(`style_no.ilike.%${qq}%,style_name.ilike.%${qq}%`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
      return (data ?? []) as Array<{
        id: string;
        style_no: string;
        style_name: string | null;
        supplier: string | null;
        image_url: string | null;
      }>;
    }
  );

  function toggleStyle(styleNo: string) {
    setSelectedStyles(
      selectedStyles.includes(styleNo)
        ? selectedStyles.filter((s) => s !== styleNo)
        : [...selectedStyles, styleNo]
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 1: Choose Styles</CardTitle>
          <CardDescription>
            Select the styles you want to create a purchase order for.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="Search by style number or name..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-md"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(styleList ?? []).map((style) => {
              const isSelected = selectedStyles.includes(style.style_no);
              return (
                <div
                  key={style.id}
                  onClick={() => toggleStyle(style.style_no)}
                  className={`border rounded-lg p-3 cursor-pointer transition-all ${
                    isSelected
                      ? 'border-slate-900 bg-slate-50 ring-2 ring-slate-900'
                      : 'border-slate-200 hover:border-slate-400'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {style.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={style.image_url}
                        alt={style.style_name || style.style_no}
                        className="h-16 w-16 object-cover rounded border"
                      />
                    ) : (
                      <div className="h-16 w-16 rounded border bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                        No image
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-semibold">{style.style_no}</div>
                        {isSelected && (
                          <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {style.style_name || '—'}
                      </div>
                      {style.supplier && (
                        <Badge className="mt-1 text-[10px]">{style.supplier}</Badge>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {selectedStyles.length > 0 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <div className="text-sm text-slate-600">
                Selected: <strong>{selectedStyles.length}</strong> style{selectedStyles.length !== 1 ? 's' : ''}
              </div>
              <Button onClick={onContinue}>Continue to Step 2</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== STEP 2: Choose Colors ====================
function Step2ChooseColors({
  selectedStyles,
  selections,
  setSelections,
  onBack,
  onContinue
}: {
  selectedStyles: string[];
  selections: Array<{ style_no: string; color: string }>;
  setSelections: React.Dispatch<React.SetStateAction<Array<{ style_no: string; color: string }>>>;
  onBack: () => void;
  onContinue: () => void;
}) {
  // Fetch style details
  const { data: styleDetails } = useSWR(
    selectedStyles.length ? ['makeOrder:styleDetails', selectedStyles.join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name, supplier, image_url')
        .in('style_no', selectedStyles);
    if (error) throw new Error(error.message);
      return (data ?? []) as Array<{
        style_no: string;
        style_name: string | null;
        supplier: string | null;
        image_url: string | null;
      }>;
    }
  );

  // Fetch colors for selected styles
  const { data: colorData } = useSWR(
    selectedStyles.length ? ['makeOrder:colors', selectedStyles.join(',')] : null,
    async () => {
      const { data: styleIds } = await supabase
        .from('styles')
        .select('id, style_no')
        .in('style_no', selectedStyles);
      
      if (!styleIds || styleIds.length === 0) return [];

      const { data, error } = await supabase
        .from('style_colors')
        .select('style_id, color')
        .in('style_id', styleIds.map((s: any) => s.id))
        .order('color', { ascending: true });
      
    if (error) throw new Error(error.message);

      // Map style_id back to style_no
      const idToNo = new Map(styleIds.map((s: any) => [s.id, s.style_no]));
      return (data ?? []).map((row: any) => ({
        style_no: idToNo.get(row.style_id),
        color: row.color
      }));
    }
  );

  function toggleColor(style_no: string, color: string) {
    const key = `${style_no}|${color}`.toLowerCase();
    const exists = selections.some(
      (s) => `${s.style_no}|${s.color}`.toLowerCase() === key
    );
    if (exists) {
      setSelections(selections.filter((s) => `${s.style_no}|${s.color}`.toLowerCase() !== key));
    } else {
      setSelections([...selections, { style_no, color }]);
    }
  }

  // Group colors by style
  const colorsByStyle = React.useMemo(() => {
    const map = new Map<string, string[]>();
    (colorData ?? []).forEach((item) => {
      if (!item.style_no) return;
      if (!map.has(item.style_no)) map.set(item.style_no, []);
      map.get(item.style_no)!.push(item.color);
    });
    return map;
  }, [colorData]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 2: Choose Colors</CardTitle>
          <CardDescription>
            Select the colors from your chosen styles.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {(styleDetails ?? []).map((style) => {
            const colors = colorsByStyle.get(style.style_no) || [];
            return (
              <div key={style.style_no} className="space-y-3 pb-6 border-b last:border-b-0 last:pb-0">
                <div className="flex items-start gap-3">
                  {style.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={style.image_url}
                      alt={style.style_name || style.style_no}
                      className="h-16 w-16 object-cover rounded border"
                    />
                  ) : (
                    <div className="h-16 w-16 rounded border bg-gray-100" />
                  )}
                  <div>
                    <div className="text-sm font-semibold">{style.style_no}</div>
                    <div className="text-xs text-slate-600">{style.style_name || '—'}</div>
                    {style.supplier && <Badge className="mt-1 text-[10px]">{style.supplier}</Badge>}
                  </div>
                </div>

                {colors.length === 0 ? (
                  <div className="text-sm text-slate-500">No colors available for this style.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {colors.map((color) => {
                      const isSelected = selections.some(
                        (s) => s.style_no === style.style_no && s.color === color
                      );
                      return (
                        <button
                          key={color}
                          onClick={() => toggleColor(style.style_no, color)}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                            isSelected
                              ? 'bg-slate-900 text-white ring-2 ring-slate-900 ring-offset-2'
                              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                          }`}
                        >
                          {color}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex items-center justify-between pt-4 border-t">
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
            <div className="flex items-center gap-3">
              <div className="text-sm text-slate-600">
                Selected: <strong>{selections.length}</strong> color{selections.length !== 1 ? 's' : ''}
              </div>
              <Button onClick={onContinue} disabled={selections.length === 0}>
                Continue to Step 3
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Helper function to distribute total by pressure array (generic)
function distributeByPressure(total: number, pressureArray: number[]): number[] {
  const pressureTotal = pressureArray.reduce((a, b) => a + b, 0);
  
  if (pressureTotal === 0) {
    // If no pressure data, distribute evenly
    const perSize = Math.floor(total / pressureArray.length);
    const remainder = total % pressureArray.length;
    return pressureArray.map((_, i) => perSize + (i < remainder ? 1 : 0));
  }

  // Calculate pressure percentages
  const pressures = pressureArray.map((s) => s / pressureTotal);
  
  // Distribute with largest remainder method
  const exact = pressures.map((p) => p * total);
  const floored = exact.map((v) => Math.floor(v));
  let remaining = total - floored.reduce((a, b) => a + b, 0);
  
  // Sort indices by fractional part (descending)
  const fractional = exact.map((v, i) => ({ i, frac: v - Math.floor(v) }));
  fractional.sort((a, b) => b.frac - a.frac);
  
  // Add 1 to the sizes with largest fractional parts
  for (let k = 0; k < remaining && k < fractional.length; k++) {
    const item = fractional[k];
    if (item && item.i >= 0 && item.i < floored.length) {
      const currentValue = floored[item.i];
      if (typeof currentValue === 'number') {
        floored[item.i] = currentValue + 1;
      }
    }
  }
  
  return floored;
}

// ==================== STEP 3: Enter Quantities (Grouped by Supplier) ====================
function Step3EnterQuantities({
  selections,
  inputsByKey,
  setInputsByKey,
  manualSalesData,
  setManualSalesData,
  onBack,
  onContinue
}: {
  selections: Array<{ style_no: string; color: string }>;
  inputsByKey: Record<string, number[]>;
  setInputsByKey: React.Dispatch<React.SetStateAction<Record<string, number[]>>>;
  manualSalesData: Record<string, number[]>;
  setManualSalesData: React.Dispatch<React.SetStateAction<Record<string, number[]>>>;
  onBack: () => void;
  onContinue: () => void;
}) {
  const selectedStyleNos = React.useMemo(
    () => Array.from(new Set(selections.map((s) => s.style_no))),
    [selections]
  );

  // State for fill option inputs (3 new options)
  const [fillOption1Amount, setFillOption1Amount] = React.useState<Record<string, string>>({});
  const [fillOption2Amount, setFillOption2Amount] = React.useState<Record<string, string>>({});
  const [fillOption3Amount, setFillOption3Amount] = React.useState<Record<string, string>>({});
  
  // State for historical sales data per color
  const [historicalDataOpen, setHistoricalDataOpen] = React.useState<Record<string, boolean>>({});
  const [historicalData, setHistoricalData] = React.useState<Record<string, number[]>>({});
  
  // Global navigation state - single index across all items
  const [globalIndex, setGlobalIndex] = React.useState<number>(0);
  
  // Helper functions defined early
  function sum(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0);
  }
  
  function calculatePressure(arr: number[]): string[] {
    const total = sum(arr);
    return arr.map((v) => total > 0 ? ((v / total) * 100).toFixed(1) : '0.0');
  }

  // Fetch style metadata (including supplier)
  const { data: styleMetadata } = useSWR(
    selectedStyleNos.length ? ['makeOrder:styleMeta', selectedStyleNos.join(',')] : null,
    async () => {
      const { data, error } = await supabase
        .from('styles')
        .select('style_no, style_name, supplier, image_url')
        .in('style_no', selectedStyleNos);
      if (error) throw new Error(error.message);
      const map = new Map<string, { name: string | null; supplier: string | null; image: string | null }>();
      (data ?? []).forEach((r: any) => {
        map.set(r.style_no, { name: r.style_name, supplier: r.supplier, image: r.image_url });
      });
      return map;
    }
  );

  // Fetch stock data
  type StockRow = {
    style_no: string;
    color: string;
    sizes: string[];
    section: string;
    row_label: string | null;
    values: number[];
    scraped_at: string;
  };

  const { data: stockData } = useSWR(
    selectedStyleNos.length ? ['makeOrder:stock', selectedStyleNos.join(',')] : null,
    async () => {
      const selectedColors = Array.from(new Set(selections.map((s) => s.color)));
    const { data, error } = await supabase
      .from('style_stock')
      .select('style_no, color, sizes, section, row_label, values, scraped_at')
      .in('style_no', selectedStyleNos)
      .in('color', selectedColors);
    if (error) throw new Error(error.message);
    return (data ?? []) as StockRow[];
    }
  );

  // Fetch historical sales data
  const { data: historicalSalesData } = useSWR(
    selections.length ? ['makeOrder:historicalSales', selections.map(s => `${s.style_no}|${s.color}`).join(',')] : null,
    async () => {
      const response = await fetch('/api/historical-sales/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections, days: 90 })
      });
      if (!response.ok) throw new Error('Failed to fetch historical sales');
      const json = await response.json();
      return json.data as Record<string, Record<string, number>>; // { "style_no|color": { "34": 10, "36": 20 } }
    }
  );

  // Auto-populate historical data when it loads
  React.useEffect(() => {
    if (!historicalSalesData) return;
    
    setHistoricalData((prev) => {
      const updated = { ...prev };
      
      // For each selection, check if we have historical data
      selections.forEach(({ style_no, color }) => {
        const key = `${style_no}|${color}`.toLowerCase();
        const histData = historicalSalesData[key];
        
        if (histData && !updated[key]) {
          // Find the sizes for this style+color from stockData
          const stockRows = stockData?.filter(
            (r) => r.style_no === style_no && r.color === color
          );
          
          if (stockRows && stockRows.length > 0) {
            const sizes = (stockRows.find((r) => r.section === 'Stock') || stockRows[0])?.sizes || [];
            
            // Map historical data to size array
            const histArray = sizes.map((size) => histData[size] || 0);
            updated[key] = histArray;
          }
        }
      });
      
      return updated;
    });
  }, [historicalSalesData, selections, stockData, setHistoricalData]);

  // Group data by supplier, then by style/color
  const groupedBySupplier = React.useMemo(() => {
    if (!styleMetadata || !stockData) return [];

    const selectionKeys = new Set(selections.map((s) => `${s.style_no}|${s.color}`.toLowerCase()));

    type ColorGroup = {
      style_no: string;
      color: string;
      sizes: string[];
      stock: number[];
      sold: number[];
      purchase: number[];
      available: number[];
    };

    type SupplierGroup = {
      supplier: string;
      colors: ColorGroup[];
    };

    const bySupplier = new Map<string, ColorGroup[]>();

    // Process each selection
    selections.forEach(({ style_no, color }) => {
      const meta = styleMetadata.get(style_no);
      if (!meta) return;

      const supplier = meta.supplier || 'Unknown Supplier';
      const key = `${style_no}|${color}`.toLowerCase();

      // Find relevant stock rows
      const rows = stockData.filter(
        (r) => r.style_no === style_no && r.color === color
      );

      if (rows.length === 0) return;

      // Get latest row per section
      const latestBySection = new Map<string, StockRow>();
      rows.forEach((r) => {
        const sectionKey = `${r.section}|${r.row_label ?? ''}`;
        const current = latestBySection.get(sectionKey);
        if (!current || new Date(r.scraped_at) > new Date(current.scraped_at)) {
          latestBySection.set(sectionKey, r);
      }
      });

      const latestRows = Array.from(latestBySection.values());
      const sizes = (latestRows.find((r) => r.section === 'Stock') || latestRows[0])?.sizes || [];
      const num = sizes.length;
      const zero = Array(num).fill(0);

      const ensureNums = (arr: any[], len: number) =>
        Array.from({ length: len }, (_, i) => Number(arr?.[i] ?? 0) || 0);

      const stockRow = latestRows.find((r) => r.section === 'Stock');
      const stock = stockRow
        ? ensureNums(
            Array.isArray(stockRow.values) ? stockRow.values : JSON.parse(String(stockRow.values || '[]')),
            num
          )
        : zero.slice();

      const soldRows = latestRows.filter((r) => r.section === 'Sold');
      const sold = soldRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + vals[i]);
      }, zero.slice());

      const purchaseRows = latestRows.filter((r) => r.section === 'Purchase (Running + Shipped)');
      const purchase = purchaseRows.reduce((acc, r) => {
        const vals = ensureNums(
          Array.isArray(r.values) ? r.values : JSON.parse(String(r.values || '[]')),
          num
        );
        return acc.map((v, i) => v + vals[i]);
      }, zero.slice());

      const available = stock.map((v, i) => v - sold[i] + purchase[i]);

      const colorGroup: ColorGroup = {
        style_no,
        color,
        sizes,
        stock,
        sold,
        purchase,
        available
      };

      if (!bySupplier.has(supplier)) bySupplier.set(supplier, []);
      bySupplier.get(supplier)!.push(colorGroup);
    });

    // Convert to array
    const result: SupplierGroup[] = [];
    bySupplier.forEach((colors, supplier) => {
      result.push({ supplier, colors });
    });

    return result;
  }, [selections, styleMetadata, stockData]);

  // Flatten grouped items for global navigation
  const flattenedItems = React.useMemo(() => {
    if (!groupedBySupplier || groupedBySupplier.length === 0) return [];
    
    type FlatItem = {
      supplier: string;
      supplierIndex: number;
      supplierItemIndex: number;
      supplierTotalItems: number;
      colorGroup: any;
      key: string;
    };
    
    const items: FlatItem[] = [];
    groupedBySupplier.forEach((supplierGroup, supplierIndex) => {
      supplierGroup.colors.forEach((colorGroup, itemIndex) => {
        items.push({
          supplier: supplierGroup.supplier,
          supplierIndex,
          supplierItemIndex: itemIndex,
          supplierTotalItems: supplierGroup.colors.length,
          colorGroup,
          key: `${colorGroup.style_no}|${colorGroup.color}`.toLowerCase()
        });
      });
    });
    return items;
  }, [groupedBySupplier]);

  // Get current item
  const currentItem = flattenedItems[globalIndex];
  const totalItems = flattenedItems.length;
  const totalSuppliers = groupedBySupplier.length;

  // Navigation functions
  const goToPrevious = () => {
    if (globalIndex > 0) setGlobalIndex(globalIndex - 1);
  };
  
  const goToNext = () => {
    if (globalIndex < totalItems - 1) setGlobalIndex(globalIndex + 1);
  };

  function setInput(key: string, sizeIndex: number, value: number, sizesLength: number) {
    setInputsByKey((prev) => {
      const base = prev[key]?.length === sizesLength ? [...prev[key]] : Array(sizesLength).fill(0);
      base[sizeIndex] = Math.max(0, value);
      return { ...prev, [key]: base };
    });
  }
  
  function setSalesInput(key: string, sizeIndex: number, value: number, sizesLength: number) {
    setManualSalesData((prev) => {
      const base = prev[key]?.length === sizesLength ? [...prev[key]] : Array(sizesLength).fill(0);
      base[sizeIndex] = Math.max(0, value);
      return { ...prev, [key]: base };
    });
  }

  // Option 1: Distribute by Sales Pressure
  const fillBySalesPressure = (key: string, colorGroup: any) => {
    const total = Number(fillOption1Amount[key] || 0);
    if (total <= 0) return;

    const salesTotal = manualSalesData[key];
    if (!salesTotal || salesTotal.length !== colorGroup.sizes.length) {
      alert('Please enter Sales Total data first');
      return;
    }

    // Distribute based on sales pressure
    const distributed = distributeByPressure(total, salesTotal);
    
    setInputsByKey((prev) => ({
      ...prev,
      [key]: distributed
    }));
    
    // Clear the input
    setFillOption1Amount((prev) => ({ ...prev, [key]: '' }));
  };

  // Option 2: Match Sales Pressure
  const matchSalesPressure = (key: string, colorGroup: any) => {
    const total = Number(fillOption2Amount[key] || 0);
    if (total <= 0) return;

    const salesTotal = manualSalesData[key];
    if (!salesTotal || salesTotal.length !== colorGroup.sizes.length) {
      alert('Please enter Sales Total data first');
      return;
    }

    // Calculate target New Net Need distribution using Sales Total pressure
    const targetDistribution = distributeByPressure(total, salesTotal);
    
    // Calculate current Net Need
    const netNeed = colorGroup.stock.map((stock: number, i: number) => 
      stock + (colorGroup.purchase[i] ?? 0) - (colorGroup.sold[i] ?? 0)
    );
    
    // Calculate Order = Target - Current Net Need
    const order = targetDistribution.map((target, i) => Math.max(0, target - netNeed[i]));
    
    setInputsByKey((prev) => ({
      ...prev,
      [key]: order
    }));
    
    // Clear the input
    setFillOption2Amount((prev) => ({ ...prev, [key]: '' }));
  };

  // Option 3: Fill Gaps to Target
  const fillGapsToTarget = (key: string, colorGroup: any) => {
    const targetTotal = Number(fillOption3Amount[key] || 0);
    if (targetTotal <= 0) return;

    const salesTotal = manualSalesData[key];
    if (!salesTotal || salesTotal.length !== colorGroup.sizes.length) {
      alert('Please enter Sales Total data first');
      return;
    }

    // Calculate what target should look like using Sales Total pressure
    const targetDistribution = distributeByPressure(targetTotal, salesTotal);
    
    // Calculate current Net Need
    const netNeed = colorGroup.stock.map((stock: number, i: number) => 
      stock + (colorGroup.purchase[i] ?? 0) - (colorGroup.sold[i] ?? 0)
    );
    
    // Calculate Order = Target - Current Net Need
    const order = targetDistribution.map((target, i) => Math.max(0, target - netNeed[i]));
    
    setInputsByKey((prev) => ({
      ...prev,
      [key]: order
    }));
    
    // Clear the input
    setFillOption3Amount((prev) => ({ ...prev, [key]: '' }));
  };

  // Show loading state if no items
  if (!currentItem || totalItems === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Step 3: Enter Order Quantities</CardTitle>
            <CardDescription>
              Review stock data and enter order quantities.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8 text-slate-500">
              {totalItems === 0 ? 'No items to display. Please go back and select colors.' : 'Loading...'}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { colorGroup, key, supplier, supplierItemIndex, supplierTotalItems } = currentItem;
  const meta = styleMetadata?.get(colorGroup.style_no);
  const inputs =
    inputsByKey[key]?.length === colorGroup.sizes.length
      ? inputsByKey[key]
      : Array(colorGroup.sizes.length).fill(0);

  const salesInputs =
    manualSalesData[key]?.length === colorGroup.sizes.length
      ? manualSalesData[key]
      : Array(colorGroup.sizes.length).fill(0);

  const historical = historicalData[key] || [];
  const hasHistorical = historical.length === colorGroup.sizes.length;
  const hasHistoricalFromDB = historicalSalesData && historicalSalesData[key] && Object.keys(historicalSalesData[key]).length > 0;
  const historicalTotal = hasHistorical ? historical.reduce((a, b) => a + b, 0) : 0;
  const historicalPressure = hasHistorical && historicalTotal > 0
    ? historical.map((h) => ((h / historicalTotal) * 100).toFixed(1))
    : [];

  // Calculate Net Need = Stock + Purchase - Sold
  const netNeed = colorGroup.stock.map((stock: number, i: number) => 
    stock + (colorGroup.purchase[i] ?? 0) - (colorGroup.sold[i] ?? 0)
  );
  const netNeedTotal = sum(netNeed);
  
  // Calculate New Net Need = Net Need + Order
  const newNetNeed = netNeed.map((n, i) => n + (inputs[i] ?? 0));

  // Calculate pressure for each row
  const stockPressure = calculatePressure(colorGroup.stock);
  const soldPressure = calculatePressure(colorGroup.sold);
  const purchasePressure = calculatePressure(colorGroup.purchase);
  const salesPressure = calculatePressure(salesInputs);
  const netNeedPressure = calculatePressure(netNeed.map((v) => Math.abs(v)));
  const orderPressure = calculatePressure(inputs);
  const newNetNeedPressure = calculatePressure(newNetNeed.map((v) => Math.abs(v)));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 3: Enter Order Quantities</CardTitle>
          <CardDescription>
            Review stock data and enter order quantities - one style/color at a time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Top Navigation Bar */}
          <div className="flex items-center justify-between gap-4 p-4 bg-gradient-to-r from-slate-50 to-slate-100 rounded-lg border-2 border-slate-200">
            <Button
              size="lg"
              variant="outline"
              onClick={goToPrevious}
              disabled={globalIndex === 0}
              className="px-6 py-3 rounded-full font-semibold disabled:opacity-50"
            >
              ← PREVIOUS
            </Button>
            
            <div className="flex-1 text-center space-y-1">
              <div className="text-lg font-bold text-slate-900">{supplier}</div>
              <div className="text-sm text-slate-600">
                Item {supplierItemIndex + 1} of {supplierTotalItems} in Supplier | 
                Supplier {currentItem.supplierIndex + 1} of {totalSuppliers}
              </div>
              <div className="text-xs text-slate-500">
                Overall: {globalIndex + 1} of {totalItems}
              </div>
            </div>
            
            <Button
              size="lg"
              variant="outline"
              onClick={goToNext}
              disabled={globalIndex === totalItems - 1}
              className="px-6 py-3 rounded-full font-semibold disabled:opacity-50"
            >
              NEXT →
            </Button>
          </div>

          {/* Style/Color Header */}
          <div className="space-y-3 pb-4 border-b">
            <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        {meta?.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={meta.image}
                            alt={colorGroup.style_no}
                            className="h-16 w-16 object-cover rounded border"
                          />
                        ) : (
                          <div className="h-16 w-16 rounded border bg-gray-100" />
                        )}
                        <div className="flex-1">
                          <div className="text-sm font-semibold">{colorGroup.style_no}</div>
                          <div className="text-xs text-slate-600">{meta?.name || '—'}</div>
                          <div className="text-xs text-slate-600">Color: {colorGroup.color}</div>
                          {hasHistoricalFromDB && (
                            <div className="mt-1">
                              <Badge className="bg-purple-100 text-purple-900 border-purple-300">
                                Historical data loaded (90 days)
                              </Badge>
            </div>
                          )}
            </div>
          </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setHistoricalDataOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
                      >
                        {historicalDataOpen[key] ? 'Hide' : hasHistoricalFromDB ? 'View/Edit Data' : 'Add Historical Data'}
                      </Button>
            </div>

                    {/* Historical Sales Data Input */}
                    {historicalDataOpen[key] && (
                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-2">
                        <div className="text-xs font-semibold text-purple-900">Historical Sales Data</div>
                        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${colorGroup.sizes.length}, minmax(0, 1fr))` }}>
                          {colorGroup.sizes.map((size, i) => (
                            <div key={i} className="space-y-1">
                              <label className="text-[10px] text-slate-600 font-medium block text-center">
                                {size}
                              </label>
                              <Input
                                type="number"
                                inputMode="numeric"
                                className="h-8 text-xs text-center"
                                value={historical[i] ?? ''}
                                onChange={(e) => {
                                  const val = Number(e.target.value || 0);
                                  setHistoricalData((prev) => {
                                    const base = prev[key] || Array(colorGroup.sizes.length).fill(0);
                                    const updated = [...base];
                                    updated[i] = val;
                                    return { ...prev, [key]: updated };
                                  });
                                }}
                                min={0}
                              />
                              {hasHistorical && historicalPressure[i] && (
                                <div className="text-[10px] text-purple-700 text-center font-medium">
                                  {historicalPressure[i]}%
        </div>
      )}
          </div>
                          ))}
          </div>
                        {hasHistorical && (
                          <div className="text-xs text-purple-900 pt-1">
                            Total: <strong>{historicalTotal}</strong>
                    </div>
                              )}
                            </div>
                    )}

                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm border border-slate-300">
                        <thead className="bg-slate-100">
                          <tr>
                            <th className="p-3 text-left font-semibold border-r border-slate-300 w-32">Metric</th>
                            {colorGroup.sizes.map((size, i) => (
                              <th key={i} className="p-3 text-center font-semibold border-r border-slate-300 min-w-[80px]">
                                {size}
                                    </th>
                                  ))}
                            <th className="p-3 text-center font-semibold min-w-[90px]">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                          <tr className="border-t border-slate-300 hover:bg-slate-50">
                            <td className="p-3 font-medium border-r border-slate-300 bg-slate-50">Stock</td>
                            {colorGroup.stock.map((v, i) => (
                              <td key={i} className="p-3 text-center border-r border-slate-300">
                                <div className="font-semibold text-slate-900">
                                  {v}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1">
                                  {stockPressure[i]}%
                                </div>
                                    </td>
                                  ))}
                            <td className="p-3 text-center font-bold text-slate-900">
                              {sum(colorGroup.stock)}
                            </td>
                                </tr>
                          <tr className="border-t border-slate-300 hover:bg-slate-50">
                            <td className="p-3 font-medium border-r border-slate-300 bg-slate-50">Sold</td>
                            {colorGroup.sold.map((v, i) => (
                              <td key={i} className="p-3 text-center border-r border-slate-300">
                                <div className="font-semibold text-slate-900">
                                  {v}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1">
                                  {soldPressure[i]}%
                                </div>
                                      </td>
                                    ))}
                            <td className="p-3 text-center font-bold text-slate-900">
                              {sum(colorGroup.sold)}
                            </td>
                                  </tr>
                          <tr className="border-t border-slate-300 hover:bg-slate-50">
                            <td className="p-3 font-medium border-r border-slate-300 bg-slate-50">Purchase</td>
                            {colorGroup.purchase.map((v, i) => (
                              <td key={i} className="p-3 text-center border-r border-slate-300">
                                <div className="font-semibold text-slate-900">
                                  {v}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1">
                                  {purchasePressure[i]}%
                                </div>
                              </td>
                            ))}
                            <td className="p-3 text-center font-bold text-slate-900">
                              {sum(colorGroup.purchase)}
                            </td>
                          </tr>
                          <tr className="border-t border-slate-300 bg-purple-50/50">
                            <td className="p-3 font-medium border-r border-slate-300 bg-purple-100/70">Sales Total</td>
                            {colorGroup.sizes.map((_, i) => (
                              <td key={i} className="p-3 border-r border-slate-300">
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  className="w-full h-9 text-center mb-1 rounded-lg border-purple-200"
                                  value={salesInputs[i]}
                                  onChange={(e) =>
                                    setSalesInput(key, i, Number(e.target.value || 0), colorGroup.sizes.length)
                                  }
                                  min={0}
                                />
                                <div className="text-[10px] text-[#B8A8D8] text-center font-medium">
                                  {salesPressure[i]}%
                                </div>
                              </td>
                            ))}
                            <td className="p-3 text-center font-bold text-purple-900">
                              {sum(salesInputs)}
                            </td>
                          </tr>
                          <tr className="border-t border-slate-300 bg-amber-50">
                            <td className="p-3 font-medium border-r border-slate-300 bg-amber-100">Net Need</td>
                            {netNeed.map((v, i) => (
                              <td key={i} className="p-3 text-center border-r border-slate-300">
                                <div className={`font-semibold ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : 'text-slate-900'}`}>
                                  {v}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1">
                                  {netNeedPressure[i]}%
                                </div>
                              </td>
                            ))}
                            <td className={`p-3 text-center font-bold ${netNeedTotal < 0 ? 'text-red-700' : netNeedTotal > 0 ? 'text-green-700' : 'text-slate-900'}`}>
                              {netNeedTotal}
                            </td>
                          </tr>
                          <tr className="border-t border-slate-300 bg-blue-50">
                            <td className="p-3 font-medium border-r border-slate-300 bg-blue-100">Order</td>
                            {colorGroup.sizes.map((_, i) => (
                              <td key={i} className="p-3 border-r border-slate-300">
                                <Input
                                            type="number"
                                            inputMode="numeric"
                                  className="w-full h-9 text-center mb-1"
                                  value={inputs[i]}
                                  onChange={(e) =>
                                    setInput(key, i, Number(e.target.value || 0), colorGroup.sizes.length)
                                  }
                                            min={0}
                                          />
                                <div className="text-[10px] text-slate-400 text-center">
                                  {orderPressure[i]}%
                                        </div>
                              </td>
                            ))}
                            <td className="p-3 text-center font-bold text-blue-900">
                              {sum(inputs)}
                                      </td>
                                    </tr>
                          <tr className="border-t border-slate-300 bg-green-50">
                            <td className="p-3 font-medium border-r border-slate-300 bg-green-100">New Net Need</td>
                            {newNetNeed.map((v, i) => (
                              <td key={i} className="p-3 text-center border-r border-slate-300">
                                <div className={`font-semibold ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : 'text-slate-900'}`}>
                                  {v}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-1">
                                  {newNetNeedPressure[i]}%
                                        </div>
                                    </td>
                                  ))}
                            <td className={`p-3 text-center font-bold ${sum(newNetNeed) < 0 ? 'text-red-700' : sum(newNetNeed) > 0 ? 'text-green-700' : 'text-slate-900'}`}>
                              {sum(newNetNeed)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>

          {/* New Fill Options - Using Sales Total Pressure */}
          <div className="space-y-4 pt-4 border-t-2 border-slate-200">
            <div className="text-sm font-semibold text-slate-700">Fill Order Using Sales Total Pressure:</div>
            
            {/* Option 1: Fill by Sales Pressure */}
            <div className="bg-gradient-to-r from-blue-50 to-blue-100/50 border border-blue-200 rounded-lg p-4 space-y-2">
              <div className="text-xs font-semibold text-blue-900">Option 1: Distribute by Sales Pressure</div>
              <div className="text-xs text-blue-700 mb-2">Distributes the total across sizes by Sales Total pressure</div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-600 font-medium whitespace-nowrap">Total Order:</label>
                <Input
                  type="number"
                  inputMode="numeric"
                  className="w-28 h-9 text-sm rounded-lg"
                  placeholder="0"
                  value={fillOption1Amount[key] || ''}
                  onChange={(e) => setFillOption1Amount((prev) => ({ ...prev, [key]: e.target.value }))}
                  min={0}
                />
                <Button
                  size="sm"
                  onClick={() => fillBySalesPressure(key, colorGroup)}
                  disabled={!fillOption1Amount[key] || Number(fillOption1Amount[key]) <= 0}
                  className="rounded-full px-4"
                >
                  Fill by Sales %
                </Button>
              </div>
            </div>

            {/* Option 2: Match Sales Pressure */}
            <div className="bg-gradient-to-r from-purple-50 to-purple-100/50 border border-purple-200 rounded-lg p-4 space-y-2">
              <div className="text-xs font-semibold text-purple-900">Option 2: Match Sales Pressure</div>
              <div className="text-xs text-purple-700 mb-2">Makes New Net Need percentages match Sales Total pressure</div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-600 font-medium whitespace-nowrap">New Net Need Total:</label>
                <Input
                  type="number"
                  inputMode="numeric"
                  className="w-28 h-9 text-sm rounded-lg"
                  placeholder="0"
                  value={fillOption2Amount[key] || ''}
                  onChange={(e) => setFillOption2Amount((prev) => ({ ...prev, [key]: e.target.value }))}
                  min={0}
                />
                <Button
                  size="sm"
                  onClick={() => matchSalesPressure(key, colorGroup)}
                  disabled={!fillOption2Amount[key] || Number(fillOption2Amount[key]) <= 0}
                  className="rounded-full px-4"
                >
                  Match Sales %
                </Button>
              </div>
            </div>

            {/* Option 3: Fill Gaps to Target */}
            <div className="bg-gradient-to-r from-green-50 to-green-100/50 border border-green-200 rounded-lg p-4 space-y-2">
              <div className="text-xs font-semibold text-green-900">Option 3: Fill Gaps to Target</div>
              <div className="text-xs text-green-700 mb-2">Fills to target using Sales Total pressure distribution</div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-600 font-medium whitespace-nowrap">Target Net Need:</label>
                <Input
                  type="number"
                  inputMode="numeric"
                  className="w-28 h-9 text-sm rounded-lg"
                  placeholder="0"
                  value={fillOption3Amount[key] || ''}
                  onChange={(e) => setFillOption3Amount((prev) => ({ ...prev, [key]: e.target.value }))}
                  min={0}
                />
                <Button
                  size="sm"
                  onClick={() => fillGapsToTarget(key, colorGroup)}
                  disabled={!fillOption3Amount[key] || Number(fillOption3Amount[key]) <= 0}
                  className="rounded-full px-4"
                >
                  Fill Gaps to Target
                </Button>
              </div>
            </div>
          </div>

          {/* Bottom Navigation Bar */}
          <div className="flex items-center justify-between gap-4 pt-6 mt-6 border-t-2 border-slate-200">
            <Button
              size="lg"
              variant="outline"
              onClick={goToPrevious}
              disabled={globalIndex === 0}
              className="px-6 py-3 rounded-full font-semibold disabled:opacity-50"
            >
              ← PREVIOUS
            </Button>
            
            <div className="text-sm text-slate-600">
              {globalIndex + 1} of {totalItems}
            </div>
            
            <Button
              size="lg"
              variant="outline"
              onClick={goToNext}
              disabled={globalIndex === totalItems - 1}
              className="px-6 py-3 rounded-full font-semibold disabled:opacity-50"
            >
              NEXT →
            </Button>
          </div>

          <div className="flex items-center justify-between pt-4 border-t">
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
            <Button onClick={onContinue}>Continue to Review</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== STEP 4: Review & Confirm ====================
function Step4Review({
  selections,
  inputsByKey,
  onBack,
  onReset
}: {
  selections: Array<{ style_no: string; color: string }>;
  inputsByKey: Record<string, number[]>;
  onBack: () => void;
  onReset: () => void;
}) {
  const router = useRouter();
  const [finalizing, setFinalizing] = React.useState(false);

  // Calculate order summary
  const orderItems = React.useMemo(() => {
    const items: Array<{
      style_no: string;
      color: string;
      quantities: number[];
      total: number;
    }> = [];

    selections.forEach(({ style_no, color }) => {
      const key = `${style_no}|${color}`.toLowerCase();
      const quantities = inputsByKey[key] || [];
      const total = quantities.reduce((a, b) => a + b, 0);
      if (total > 0) {
        items.push({ style_no, color, quantities, total });
    }
    });

    return items;
  }, [selections, inputsByKey]);

  const grandTotal = orderItems.reduce((sum, item) => sum + item.total, 0);

  async function handleFinalizeOrder() {
    if (orderItems.length === 0) return;
    
    setFinalizing(true);
    try {
      // Generate PO number (format: APP-YYYYMMDD-HHMMSS)
      const now = new Date();
      const poNo = `APP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      
      // Prepare order data
      const orderData = {
        po_no: poNo,
        status: 'Running',
        styles: orderItems.length,
        ordered: grandTotal,
        shipped: 0,
        meta: {
          items: orderItems,
          created_from: 'make-order',
          created_at: now.toISOString()
        }
      };

      // Insert into database
      const { data, error } = await supabase
        .from('app_pos')
        .insert(orderData)
        .select()
        .single();

      if (error) throw error;

      // Reset the process
      onReset();

      // Navigate to the new PO detail page
      router.push(`/purchase/app-pos/${data.id}`);
    } catch (error) {
      console.error('Failed to finalize order:', error);
      alert('Failed to create purchase order. Please try again.');
    } finally {
      setFinalizing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Step 4: Review Order</CardTitle>
          <CardDescription>
            Review your order before finalizing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {orderItems.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <p className="mb-2">No items with quantities entered.</p>
              <Button variant="outline" onClick={onBack}>
                Go back to add quantities
              </Button>
        </div>
          ) : (
            <>
              <div className="space-y-3">
                {orderItems.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <div className="font-semibold text-sm">
                        {item.style_no} - {item.color}
      </div>
                      <div className="text-xs text-slate-600">
                        Quantities: {item.quantities.join(', ')}
      </div>
            </div>
                    <div className="text-lg font-bold">{item.total}</div>
        </div>
                ))}
              </div>

              <div className="pt-4 border-t">
                <div className="flex items-center justify-between text-lg font-bold">
                  <span>Grand Total:</span>
                  <span>{grandTotal}</span>
        </div>
      </div>

              <div className="flex items-center justify-between pt-4 border-t">
                <Button variant="outline" onClick={onBack} disabled={finalizing}>
                  Back
                </Button>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={onReset} disabled={finalizing}>
                    Start New Order
                  </Button>
                  <Button onClick={handleFinalizeOrder} disabled={finalizing}>
                    {finalizing ? 'Creating Order...' : 'Finalize Order'}
                  </Button>
      </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
