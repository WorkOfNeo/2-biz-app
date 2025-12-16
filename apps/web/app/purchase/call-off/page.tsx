'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';

type Selection = { style_no: string; color: string };
type InputRecord = Record<string, number[]>;
type AISuggestion = {
  style_no: string;
  color: string;
  analysis: string;
  weekly_rate: number;
  current_available: number;
  target_stock: number;
  order_suggestion: number[];
  sizes: string[];
};

type FullAnalysisItem = {
  style_no: string;
  color: string;
  sizes: string[];
  stock: number[];
  sold: number[];
  netStock: number[];
  historical: number[];
  nextMonthHistorical: number[];
  totalStock: number;
  totalSold: number;
  totalNetStock: number;
  totalHistorical: number;
  totalNextMonthHistorical: number;
  weeklyRate: number;
  nextMonthWeeklyRate: number;
  targetStock: number;
  suggestedOrder: number;
  suggestedOrderBySize: number[];
  trendDirection: 'up' | 'down' | 'stable';
  trendPercent: number;
  status: 'critical' | 'low' | 'ok' | 'surplus';
  priority: number;
};

type OrderByStyle = {
  style_no: string;
  totalOrder: number;
  colors: Array<{
    color: string;
    order: number;
    status: 'critical' | 'low' | 'ok' | 'surplus';
  }>;
};

type FullAnalysisResult = {
  items: FullAnalysisItem[];
  ordersByStyle: OrderByStyle[];
  summary: {
    totalItems: number;
    criticalItems: number;
    lowItems: number;
    okItems: number;
    surplusItems: number;
    totalSuggestedOrder: number;
    aiSummary: string;
    trendSummary: string;
  };
  dateRange: {
    start: string;
    end: string;
    display: string;
  };
  nextMonthRange: {
    start: string;
    end: string;
    display: string;
  };
};

export default function CallOffPage() {
  const STORAGE_KEYS = React.useMemo(() => ({
    started: 'callOff.process.started',
    step: 'callOff.process.step',
    returnPath: 'callOff.process.returnPath',
    selections: 'callOff.process.selections',
    inputs: 'callOff.process.inputs',
    weeksCover: 'callOff.process.weeksCover',
    startDate: 'callOff.process.startDate',
    endDate: 'callOff.process.endDate',
  }), []);

  const [started, setStarted] = React.useState<boolean>(false);
  const [step, setStep] = React.useState<number>(1);
  const [returnPath, setReturnPath] = React.useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // NOOS styles (auto-loaded)
  const [noosStyles, setNoosStyles] = React.useState<string[]>([]);
  
  // Selected style_no + color pairs
  const [selections, setSelections] = React.useState<Selection[]>([]);

  // Inputs per style/color/size
  const [inputsByKey, setInputsByKey] = React.useState<InputRecord>({});
  
  // Weeks cover for AI analysis
  const [weeksCover, setWeeksCover] = React.useState<number>(4);
  
  // Date range for historical analysis (default: same month last year)
  const getDefaultDateRange = React.useCallback((): { start: string; end: string } => {
    const now = new Date();
    const lastYear = now.getFullYear() - 1;
    const month = now.getMonth() + 1;
    const startDate = new Date(lastYear, month - 1, 1);
    const endDate = new Date(lastYear, month, 0);
    return {
      start: startDate.toISOString().split('T')[0] || '',
      end: endDate.toISOString().split('T')[0] || ''
    };
  }, []);
  
  const [dateRange, setDateRange] = React.useState<{ start: string; end: string }>(() => {
    try {
      const stored = localStorage.getItem('callOff.process.startDate');
      const storedEnd = localStorage.getItem('callOff.process.endDate');
      if (stored && storedEnd) {
        return { start: stored, end: storedEnd };
      }
    } catch {}
    return getDefaultDateRange();
  });

  // Format date range for display
  const dateRangeDisplay = React.useMemo(() => {
    try {
      const start = new Date(dateRange.start);
      const end = new Date(dateRange.end);
      const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `${startStr} - ${endStr}`;
    } catch {
      return dateRange.start + ' - ' + dateRange.end;
    }
  }, [dateRange]);

  // AI suggestions state
  const [aiSuggestions, setAiSuggestions] = React.useState<Record<string, AISuggestion>>({});
  const [aiLoading, setAiLoading] = React.useState<boolean>(false);
  const [aiPanelOpen, setAiPanelOpen] = React.useState<boolean>(false);
  
  // Full AI analysis state
  const [fullAnalysisOpen, setFullAnalysisOpen] = React.useState<boolean>(false);
  const [fullAnalysisLoading, setFullAnalysisLoading] = React.useState<boolean>(false);
  const [fullAnalysisResult, setFullAnalysisResult] = React.useState<FullAnalysisResult | null>(null);
  const [fullAnalysisDateRange, setFullAnalysisDateRange] = React.useState<{ start: string; end: string }>(() => {
    const now = new Date();
    const lastYear = now.getFullYear() - 1;
    const month = now.getMonth() + 1;
    const startDate = new Date(lastYear, month - 1, 1);
    const endDate = new Date(lastYear, month, 0);
    return {
      start: startDate.toISOString().split('T')[0] || '',
      end: endDate.toISOString().split('T')[0] || ''
    };
  });
  const [fullAnalysisWeeksCover, setFullAnalysisWeeksCover] = React.useState<number>(4);

  // Fetch NOOS stock list styles
  const { data: noosData } = useSWR('callOff:noosStyles', async () => {
    // First get the NOOS stock list ID
    const { data: stockLists } = await supabase
      .from('stock_lists')
      .select('id, name')
      .eq('name', 'NOOS')
      .single();
    
    if (!stockLists) return [];

    // Then get the styles in that list
    const { data: listStyles } = await supabase
      .from('stock_list_styles')
      .select('style_id')
      .eq('list_id', stockLists.id);

    if (!listStyles || listStyles.length === 0) return [];

    const styleIds = listStyles.map((s: any) => s.style_id);

    // Get the style details
    const { data: styles } = await supabase
      .from('styles')
      .select('id, style_no, style_name, supplier, image_url')
      .in('id', styleIds)
      .order('style_no', { ascending: true });

    return (styles ?? []) as Array<{
      id: string;
      style_no: string;
      style_name: string | null;
      supplier: string | null;
      image_url: string | null;
    }>;
  });

  // Set NOOS styles when data loads
  React.useEffect(() => {
    if (noosData && noosData.length > 0) {
      setNoosStyles(noosData.map(s => s.style_no));
    }
  }, [noosData]);

  // Load persisted state
  React.useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEYS.started);
      const r = localStorage.getItem(STORAGE_KEYS.returnPath);
      const st = localStorage.getItem(STORAGE_KEYS.step);
      const sel = localStorage.getItem(STORAGE_KEYS.selections);
      const inp = localStorage.getItem(STORAGE_KEYS.inputs);
      const wc = localStorage.getItem(STORAGE_KEYS.weeksCover);
      const startDate = localStorage.getItem(STORAGE_KEYS.startDate);
      const endDate = localStorage.getItem(STORAGE_KEYS.endDate);
      
      if (s === '1') setStarted(true);
      if (typeof r === 'string') setReturnPath(r);
      if (st) {
        const num = Number(st) || 1;
        setStep(num >= 1 && num <= 4 ? num : 1);
      }
      if (sel) {
        try { setSelections(JSON.parse(sel) as Selection[]); } catch {}
      }
      if (inp) {
        try { setInputsByKey(JSON.parse(inp) as InputRecord); } catch {}
      }
      if (wc) {
        const num = Number(wc) || 4;
        setWeeksCover(num);
      }
      if (startDate && endDate) {
        setDateRange({ start: startDate, end: endDate });
      }
    } catch {}
  }, [STORAGE_KEYS]);

  // Persist state
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.step, String(step)); } catch {}
  }, [step, STORAGE_KEYS.step]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selections, JSON.stringify(selections)); } catch {}
  }, [selections, STORAGE_KEYS.selections]);
  
  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.inputs, JSON.stringify(inputsByKey)); } catch {}
  }, [inputsByKey, STORAGE_KEYS.inputs]);

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.weeksCover, String(weeksCover)); } catch {}
  }, [weeksCover, STORAGE_KEYS.weeksCover]);

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.startDate, dateRange.start);
      localStorage.setItem(STORAGE_KEYS.endDate, dateRange.end);
    } catch {}
  }, [dateRange, STORAGE_KEYS.startDate, STORAGE_KEYS.endDate]);

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
      setSelections([]);
      setInputsByKey({});
      setAiSuggestions({});
      setAiPanelOpen(false);
      setReturnPath(null);
    } catch {}
  }

  return (
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">Purchase</div>
          <h1 className="text-2xl font-semibold">NOOS Call Off</h1>
        </div>
        <div className="flex items-center gap-3">
          {returnPath && (
            <a href={returnPath} className="text-sm underline text-[#8FA894] hover:text-[#C5D5CA]">
              Back to previous page
            </a>
          )}
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => router.push('/purchase/make-order')}
            className="border-slate-300"
          >
            Switch to Make Order
          </Button>
        </div>
      </div>

      {/* Progress indicator */}
      {started && (
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
                  s === step
                    ? 'bg-[#8FA894] text-white'
                    : s < step
                    ? 'bg-[#C5D5CA] text-white'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {s}
              </div>
              {s < 4 && (
                <div className={`w-16 h-0.5 ${s < step ? 'bg-[#C5D5CA]' : 'bg-slate-200'}`} />
              )}
            </div>
          ))}
          <div className="ml-4 text-sm text-slate-600">
            {step === 1 && 'NOOS Styles Loaded'}
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
        <Card className="border-2 border-[#C5D5CA]">
          <CardHeader>
            <CardTitle>NOOS Call Off Process</CardTitle>
            <CardDescription>
              Replenish NOOS (Never Out Of Stock) items based on current stock levels 
              and AI-powered analysis using same-month-last-year sales data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="text-sm text-slate-600">
                <strong>{noosData?.length ?? 0}</strong> NOOS styles available
              </div>
            </div>
            <Button 
              onClick={startProcess}
              className="bg-[#8FA894] hover:bg-[#C5D5CA] text-white"
              disabled={!noosData || noosData.length === 0}
            >
              Start Call Off
            </Button>
          </CardContent>
        </Card>
      )}

      {started && step === 1 && (
        <Step1NoosStyles 
          noosStyles={noosData ?? []} 
          onContinue={() => setStep(2)} 
        />
      )}
      {started && step === 2 && (
        <Step2ChooseColors 
          noosStyles={noosData ?? []} 
          selections={selections} 
          setSelections={setSelections} 
          onBack={() => setStep(1)} 
          onContinue={() => setStep(3)}
          fullAnalysisOpen={fullAnalysisOpen}
          setFullAnalysisOpen={setFullAnalysisOpen}
          fullAnalysisLoading={fullAnalysisLoading}
          setFullAnalysisLoading={setFullAnalysisLoading}
          fullAnalysisResult={fullAnalysisResult}
          setFullAnalysisResult={setFullAnalysisResult}
          fullAnalysisDateRange={fullAnalysisDateRange}
          setFullAnalysisDateRange={setFullAnalysisDateRange}
          fullAnalysisWeeksCover={fullAnalysisWeeksCover}
          setFullAnalysisWeeksCover={setFullAnalysisWeeksCover}
        />
      )}
      {started && step === 3 && (
        <Step3EnterQuantities 
          selections={selections} 
          inputsByKey={inputsByKey} 
          setInputsByKey={setInputsByKey}
          weeksCover={weeksCover}
          setWeeksCover={setWeeksCover}
          dateRange={dateRange}
          setDateRange={setDateRange}
          dateRangeDisplay={dateRangeDisplay}
          aiSuggestions={aiSuggestions}
          setAiSuggestions={setAiSuggestions}
          aiLoading={aiLoading}
          setAiLoading={setAiLoading}
          aiPanelOpen={aiPanelOpen}
          setAiPanelOpen={setAiPanelOpen}
          onBack={() => setStep(2)} 
          onContinue={() => setStep(4)} 
        />
      )}
      {started && step === 4 && (
        <Step4Review 
          selections={selections} 
          inputsByKey={inputsByKey} 
          onBack={() => setStep(3)} 
          onReset={resetProcess} 
        />
      )}
    </div>
  );
}

// ==================== STEP 1: NOOS Styles (Auto-loaded) ====================
function Step1NoosStyles({
  noosStyles,
  onContinue
}: {
  noosStyles: Array<{
    id: string;
    style_no: string;
    style_name: string | null;
    supplier: string | null;
    image_url: string | null;
  }>;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Step 1: NOOS Styles</CardTitle>
          <CardDescription>
            The following NOOS styles will be included in this call off. 
            All styles from the NOOS stock list are automatically loaded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {noosStyles.map((style) => (
              <div
                key={style.id}
                className="border rounded-lg p-3 border-[#C5D5CA] bg-[#F5F3F0]/30"
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
                      <Badge className="bg-[#C5D5CA] text-slate-800 text-[10px]">NOOS</Badge>
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
            ))}
          </div>

          {noosStyles.length > 0 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <div className="text-sm text-slate-600">
                <strong>{noosStyles.length}</strong> NOOS style{noosStyles.length !== 1 ? 's' : ''} loaded
              </div>
              <Button onClick={onContinue} className="bg-[#8FA894] hover:bg-[#C5D5CA]">
                Continue to Choose Colors
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== STEP 2: Choose Colors ====================
function Step2ChooseColors({
  noosStyles,
  selections,
  setSelections,
  onBack,
  onContinue,
  fullAnalysisOpen,
  setFullAnalysisOpen,
  fullAnalysisLoading,
  setFullAnalysisLoading,
  fullAnalysisResult,
  setFullAnalysisResult,
  fullAnalysisDateRange,
  setFullAnalysisDateRange,
  fullAnalysisWeeksCover,
  setFullAnalysisWeeksCover
}: {
  noosStyles: Array<{
    id: string;
    style_no: string;
    style_name: string | null;
    supplier: string | null;
    image_url: string | null;
  }>;
  selections: Selection[];
  setSelections: React.Dispatch<React.SetStateAction<Selection[]>>;
  onBack: () => void;
  onContinue: () => void;
  fullAnalysisOpen: boolean;
  setFullAnalysisOpen: React.Dispatch<React.SetStateAction<boolean>>;
  fullAnalysisLoading: boolean;
  setFullAnalysisLoading: React.Dispatch<React.SetStateAction<boolean>>;
  fullAnalysisResult: FullAnalysisResult | null;
  setFullAnalysisResult: React.Dispatch<React.SetStateAction<FullAnalysisResult | null>>;
  fullAnalysisDateRange: { start: string; end: string };
  setFullAnalysisDateRange: React.Dispatch<React.SetStateAction<{ start: string; end: string }>>;
  fullAnalysisWeeksCover: number;
  setFullAnalysisWeeksCover: React.Dispatch<React.SetStateAction<number>>;
}) {
  const styleNos = React.useMemo(() => noosStyles.map(s => s.style_no), [noosStyles]);

  // Fetch colors for NOOS styles
  const { data: colorData } = useSWR(
    styleNos.length ? ['callOff:colors', styleNos.join(',')] : null,
    async () => {
      const { data: styleIds } = await supabase
        .from('styles')
        .select('id, style_no')
        .in('style_no', styleNos);
      
      if (!styleIds || styleIds.length === 0) return [];

      const { data, error } = await supabase
        .from('style_colors')
        .select('style_id, color')
        .in('style_id', styleIds.map((s: any) => s.id))
        .order('color', { ascending: true });
      
      if (error) throw new Error(error.message);

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

  function selectAllColors() {
    const allColors: Selection[] = [];
    noosStyles.forEach((style) => {
      const colors = colorsByStyle.get(style.style_no) || [];
      colors.forEach((color) => {
        allColors.push({ style_no: style.style_no, color });
      });
    });
    setSelections(allColors);
  }

  function clearAllColors() {
    setSelections([]);
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

  // Run full AI analysis
  async function runFullAnalysis() {
    if (selections.length === 0) return;
    
    setFullAnalysisLoading(true);
    setFullAnalysisResult(null);
    setFullAnalysisOpen(true);
    
    try {
      const res = await fetch('/api/call-off/full-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections,
          weeks_cover: fullAnalysisWeeksCover,
          startDate: fullAnalysisDateRange.start,
          endDate: fullAnalysisDateRange.end
        })
      });
      
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Analysis failed');
      }
      
      const data = await res.json();
      setFullAnalysisResult(data);
    } catch (error: any) {
      console.error('Full analysis error:', error);
      alert('Analysis failed: ' + (error.message || 'Unknown error'));
    } finally {
      setFullAnalysisLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Step 2: Choose Colors</CardTitle>
          <CardDescription>
            Select the colors you want to include in this call off.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={selectAllColors}>
              Select All Colors
            </Button>
            <Button variant="outline" size="sm" onClick={clearAllColors}>
              Clear All
            </Button>
          </div>

          {noosStyles.map((style) => {
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
                          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                            isSelected
                              ? 'bg-[#8FA894] text-white ring-2 ring-[#8FA894] ring-offset-2'
                              : 'bg-[#F5F3F0] text-slate-700 hover:bg-[#C5D5CA]/50'
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
              <Button 
                onClick={() => setFullAnalysisOpen(true)} 
                disabled={selections.length === 0} 
                variant="outline"
                className="border-[#B8A8D8] text-[#B8A8D8] hover:bg-[#B8A8D8]/10"
              >
                Full AI Analysis
              </Button>
              <Button onClick={onContinue} disabled={selections.length === 0} className="bg-[#8FA894] hover:bg-[#C5D5CA]">
                Continue to Step 3
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Full Analysis Modal */}
      {fullAnalysisOpen && (
        <FullAnalysisModal
          isOpen={fullAnalysisOpen}
          onClose={() => setFullAnalysisOpen(false)}
          selections={selections}
          dateRange={fullAnalysisDateRange}
          setDateRange={setFullAnalysisDateRange}
          weeksCover={fullAnalysisWeeksCover}
          setWeeksCover={setFullAnalysisWeeksCover}
          loading={fullAnalysisLoading}
          result={fullAnalysisResult}
          onRunAnalysis={runFullAnalysis}
        />
      )}
    </div>
  );
}

// Helper function to distribute total by pressure array
function distributeByPressure(total: number, pressureArray: number[]): number[] {
  const pressureTotal = pressureArray.reduce((a, b) => a + b, 0);
  
  if (pressureTotal === 0) {
    const perSize = Math.floor(total / pressureArray.length);
    const remainder = total % pressureArray.length;
    return pressureArray.map((_, i) => perSize + (i < remainder ? 1 : 0));
  }

  const pressures = pressureArray.map((s) => s / pressureTotal);
  const exact = pressures.map((p) => p * total);
  const floored = exact.map((v) => Math.floor(v));
  let remaining = total - floored.reduce((a, b) => a + b, 0);
  
  const fractional = exact.map((v, i) => ({ i, frac: v - Math.floor(v) }));
  fractional.sort((a, b) => b.frac - a.frac);
  
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

// ==================== STEP 3: Enter Quantities ====================
function Step3EnterQuantities({
  selections,
  inputsByKey,
  setInputsByKey,
  weeksCover,
  setWeeksCover,
  dateRange,
  setDateRange,
  dateRangeDisplay,
  aiSuggestions,
  setAiSuggestions,
  aiLoading,
  setAiLoading,
  aiPanelOpen,
  setAiPanelOpen,
  onBack,
  onContinue
}: {
  selections: Selection[];
  inputsByKey: InputRecord;
  setInputsByKey: React.Dispatch<React.SetStateAction<InputRecord>>;
  weeksCover: number;
  setWeeksCover: React.Dispatch<React.SetStateAction<number>>;
  dateRange: { start: string; end: string };
  setDateRange: React.Dispatch<React.SetStateAction<{ start: string; end: string }>>;
  dateRangeDisplay: string;
  aiSuggestions: Record<string, AISuggestion>;
  setAiSuggestions: React.Dispatch<React.SetStateAction<Record<string, AISuggestion>>>;
  aiLoading: boolean;
  setAiLoading: React.Dispatch<React.SetStateAction<boolean>>;
  aiPanelOpen: boolean;
  setAiPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onBack: () => void;
  onContinue: () => void;
}) {
  const selectedStyleNos = React.useMemo(
    () => Array.from(new Set(selections.map((s) => s.style_no))),
    [selections]
  );

  const [globalIndex, setGlobalIndex] = React.useState<number>(0);
  const [fillOption, setFillOption] = React.useState<Record<string, 1 | 2 | 3>>({});
  const [fillAmount, setFillAmount] = React.useState<Record<string, string>>({});

  // Fetch style metadata
  const { data: styleMetadata } = useSWR(
    selectedStyleNos.length ? ['callOff:styleMeta', selectedStyleNos.join(',')] : null,
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
    selectedStyleNos.length ? ['callOff:stock', selectedStyleNos.join(',')] : null,
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

  // Fetch historical sales for selected date range
  const { data: historicalData } = useSWR(
    selections.length && dateRange.start && dateRange.end 
      ? ['callOff:historical', selections.map(s => `${s.style_no}|${s.color}`).join(','), dateRange.start, dateRange.end] 
      : null,
    async () => {
      const response = await fetch('/api/call-off/historical', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections, startDate: dateRange.start, endDate: dateRange.end })
      });
      if (!response.ok) return {};
      const json = await response.json();
      return json.data as Record<string, Record<string, number>>;
    }
  );

  // Group data by style/color
  const groupedItems = React.useMemo(() => {
    if (!styleMetadata || !stockData) return [];

    type ColorGroup = {
      style_no: string;
      color: string;
      sizes: string[];
      stock: number[];
      sold: number[];
      netStock: number[];  // Stock - Sold (actual inventory after commitments)
      historical: number[];
    };

    const items: ColorGroup[] = [];

    selections.forEach(({ style_no, color }) => {
      const rows = stockData.filter(
        (r) => r.style_no === style_no && r.color === color
      );

      if (rows.length === 0) return;

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

      // Net Stock = Stock - Sold (no purchase included for NOOS)
      const netStock = stock.map((v, i) => v - sold[i]);

      // Get historical data for this color
      const key = `${style_no}|${color}`.toLowerCase();
      const histData = historicalData?.[key] || {};
      const historical = sizes.map((size) => histData[size] || 0);

      items.push({
        style_no,
        color,
        sizes,
        stock,
        sold,
        netStock,
        historical
      });
    });

    return items;
  }, [selections, styleMetadata, stockData, historicalData]);

  const currentItem = groupedItems[globalIndex];
  const totalItems = groupedItems.length;

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

  function sum(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0);
  }

  function calculatePressure(arr: number[]): string[] {
    const total = sum(arr);
    return arr.map((v) => total > 0 ? ((v / total) * 100).toFixed(1) : '0.0');
  }

  // AI Analysis function
  async function runAiAnalysis() {
    setAiLoading(true);
    setAiPanelOpen(true);
    try {
      const response = await fetch('/api/call-off/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections,
          weeks_cover: weeksCover,
          startDate: dateRange.start,
          endDate: dateRange.end
        })
      });
      
      if (!response.ok) throw new Error('Analysis failed');
      
      const json = await response.json();
      const suggestionsMap: Record<string, AISuggestion> = {};
      (json.suggestions || []).forEach((s: AISuggestion) => {
        const key = `${s.style_no}|${s.color}`.toLowerCase();
        suggestionsMap[key] = s;
      });
      setAiSuggestions(suggestionsMap);
    } catch (error) {
      console.error('AI analysis error:', error);
    } finally {
      setAiLoading(false);
    }
  }

  function applySuggestion(key: string, suggestion: number[]) {
    setInputsByKey((prev) => ({
      ...prev,
      [key]: suggestion
    }));
  }

  // Fill functions
  const fillBySalesPressure = React.useCallback((key: string, colorGroup: any) => {
    const total = Number(fillAmount[key] || 0);
    if (total <= 0) return;
    const pressureSource = colorGroup.historical.some((v: number) => v > 0) ? colorGroup.historical : colorGroup.sold;
    const distributed = distributeByPressure(total, pressureSource);
    setInputsByKey((prev) => ({ ...prev, [key]: distributed }));
    setFillAmount((prev) => ({ ...prev, [key]: '' }));
  }, [fillAmount]);

  const matchSalesPressure = React.useCallback((key: string, colorGroup: any) => {
    const total = Number(fillAmount[key] || 0);
    if (total <= 0) return;
    const pressureSource = colorGroup.historical.some((v: number) => v > 0) ? colorGroup.historical : colorGroup.sold;
    const targetDistribution = distributeByPressure(total, pressureSource);
    const netStock = colorGroup.netStock;
    const order = targetDistribution.map((target, i) => Math.max(0, target - netStock[i]));
    setInputsByKey((prev) => ({ ...prev, [key]: order }));
    setFillAmount((prev) => ({ ...prev, [key]: '' }));
  }, [fillAmount]);

  const fillGapsToTarget = React.useCallback((key: string, colorGroup: any) => {
    const targetTotal = Number(fillAmount[key] || 0);
    if (targetTotal <= 0) return;
    const pressureSource = colorGroup.historical.some((v: number) => v > 0) ? colorGroup.historical : colorGroup.sold;
    const targetDistribution = distributeByPressure(targetTotal, pressureSource);
    const netStock = colorGroup.netStock;
    const order = targetDistribution.map((target, i) => Math.max(0, target - netStock[i]));
    setInputsByKey((prev) => ({ ...prev, [key]: order }));
    setFillAmount((prev) => ({ ...prev, [key]: '' }));
  }, [fillAmount]);

  if (!currentItem || totalItems === 0) {
    return (
      <div className="space-y-4">
        <Card className="border-[#C5D5CA]">
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

  const key = `${currentItem.style_no}|${currentItem.color}`.toLowerCase();
  const meta = styleMetadata?.get(currentItem.style_no);
  const inputs = inputsByKey[key]?.length === currentItem.sizes.length
    ? inputsByKey[key]
    : Array(currentItem.sizes.length).fill(0);

  // Net Stock = Stock - Sold (no purchase included for NOOS)
  const netStock = currentItem.netStock;
  const newNetStock = netStock.map((n: number, i: number) => n + (inputs?.[i] ?? 0));
  
  const stockPressure = calculatePressure(currentItem.stock);
  const soldPressure = calculatePressure(currentItem.sold);
  const netStockPressure = calculatePressure(netStock.map((v: number) => Math.abs(v)));
  const historicalPressure = calculatePressure(currentItem.historical);
  const orderPressure = calculatePressure(inputs || []);
  const newNetStockPressure = calculatePressure(newNetStock.map((v: number) => Math.abs(v)));

  const currentSuggestion = aiSuggestions[key];

  return (
    <div className="flex gap-4">
      {/* Main content */}
      <div className={`flex-1 space-y-4 transition-all ${aiPanelOpen ? 'pr-0' : ''}`}>
        <Card className="border-[#C5D5CA]">
          <CardHeader>
            <CardTitle>Step 3: Enter Order Quantities</CardTitle>
            <CardDescription>
              Review stock data and enter order quantities. Use AI analysis to get suggestions based on {weeksCover} weeks of stock cover.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* AI Analysis Controls */}
            <div className="flex items-center justify-between gap-4 p-4 bg-gradient-to-r from-[#B8A8D8]/20 to-[#D4E4E8]/20 rounded-lg border border-[#B8A8D8]/30">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-slate-700">Weeks Cover:</label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={weeksCover}
                    onChange={(e) => setWeeksCover(Number(e.target.value) || 4)}
                    className="w-20 h-9"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-slate-700">Period:</label>
                  <Input
                    type="date"
                    value={dateRange.start}
                    onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                    className="w-40 h-9"
                  />
                  <span className="text-sm text-slate-500">to</span>
                  <Input
                    type="date"
                    value={dateRange.end}
                    onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                    className="w-40 h-9"
                  />
                </div>
                <div className="text-xs text-slate-500">
                  {dateRangeDisplay}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={runAiAnalysis}
                  disabled={aiLoading}
                  className="bg-[#B8A8D8] hover:bg-[#B8A8D8]/80 text-white"
                >
                  {aiLoading ? 'Analyzing...' : 'Start AI Analysis'}
                </Button>
                {Object.keys(aiSuggestions).length > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => setAiPanelOpen(!aiPanelOpen)}
                  >
                    {aiPanelOpen ? 'Hide Panel' : 'Show Panel'}
                  </Button>
                )}
              </div>
            </div>

            {/* Navigation */}
            <div className="flex items-center justify-between gap-4 p-4 bg-[#F5F3F0] rounded-lg border border-[#C5D5CA]">
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
                <div className="text-lg font-bold text-slate-900">{currentItem.style_no} - {currentItem.color}</div>
                <div className="text-sm text-slate-600">
                  Item {globalIndex + 1} of {totalItems}
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
            <div className="flex items-start gap-3 pb-4 border-b">
              {meta?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={meta.image}
                  alt={currentItem.style_no}
                  className="h-16 w-16 object-cover rounded border"
                />
              ) : (
                <div className="h-16 w-16 rounded border bg-gray-100" />
              )}
              <div className="flex-1">
                <div className="text-sm font-semibold">{currentItem.style_no}</div>
                <div className="text-xs text-slate-600">{meta?.name || '—'}</div>
                <div className="text-xs text-slate-600">Color: {currentItem.color}</div>
                <Badge className="mt-1 bg-[#C5D5CA] text-slate-800 text-[10px]">NOOS</Badge>
              </div>
            </div>

            {/* Stock Table */}
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm border border-slate-300">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="p-3 text-left font-semibold border-r border-slate-300 w-40">Metric</th>
                    {currentItem.sizes.map((size: string, i: number) => (
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
                    {currentItem.stock.map((v: number, i: number) => (
                      <td key={i} className="p-3 text-center border-r border-slate-300">
                        <div className="font-semibold text-slate-900">{v}</div>
                        <div className="text-[10px] text-slate-400 mt-1">{stockPressure[i]}%</div>
                      </td>
                    ))}
                    <td className="p-3 text-center font-bold text-slate-900">{sum(currentItem.stock)}</td>
                  </tr>
                  <tr className="border-t border-slate-300 hover:bg-slate-50">
                    <td className="p-3 font-medium border-r border-slate-300 bg-slate-50">Sold</td>
                    {currentItem.sold.map((v: number, i: number) => (
                      <td key={i} className="p-3 text-center border-r border-slate-300">
                        <div className="font-semibold text-slate-900">{v}</div>
                        <div className="text-[10px] text-slate-400 mt-1">{soldPressure[i]}%</div>
                      </td>
                    ))}
                    <td className="p-3 text-center font-bold text-slate-900">{sum(currentItem.sold)}</td>
                  </tr>
                  <tr className="border-t border-slate-300 bg-amber-50">
                    <td className="p-3 font-medium border-r border-slate-300 bg-amber-100">
                      <div>Net Stock</div>
                      <div className="text-[10px] text-slate-500 font-normal">(Stock - Sold)</div>
                    </td>
                    {netStock.map((v: number, i: number) => (
                      <td key={i} className="p-3 text-center border-r border-slate-300">
                        <div className={`font-semibold ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : 'text-slate-900'}`}>
                          {v}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">{netStockPressure[i]}%</div>
                      </td>
                    ))}
                    <td className={`p-3 text-center font-bold ${sum(netStock) < 0 ? 'text-red-700' : 'text-green-700'}`}>
                      {sum(netStock)}
                    </td>
                  </tr>
                  <tr className="border-t border-slate-300 bg-[#B8A8D8]/20">
                    <td className="p-3 font-medium border-r border-slate-300 bg-[#B8A8D8]/30">
                      Historical ({dateRangeDisplay})
                    </td>
                    {currentItem.historical.map((v: number, i: number) => (
                      <td key={i} className="p-3 text-center border-r border-slate-300">
                        <div className="font-semibold text-[#B8A8D8]">{v}</div>
                        <div className="text-[10px] text-[#B8A8D8] mt-1">{historicalPressure[i]}%</div>
                      </td>
                    ))}
                    <td className="p-3 text-center font-bold text-[#B8A8D8]">{sum(currentItem.historical)}</td>
                  </tr>
                  <tr className="border-t border-slate-300 bg-[#8FA894]/20">
                    <td className="p-3 font-medium border-r border-slate-300 bg-[#8FA894]/30">Order</td>
                    {currentItem.sizes.map((_: string, i: number) => (
                      <td key={i} className="p-3 border-r border-slate-300">
                        <Input
                          type="number"
                          inputMode="numeric"
                          className="w-full h-9 text-center mb-1"
                          value={inputs ? inputs[i] : 0}
                          onChange={(e) =>
                            setInput(key, i, Number(e.target.value || 0), currentItem.sizes.length)
                          }
                          min={0}
                        />
                        <div className="text-[10px] text-slate-400 text-center">{orderPressure[i]}%</div>
                      </td>
                    ))}
                    <td className="p-3 text-center font-bold text-[#8FA894]">{sum(inputs || [])}</td>
                  </tr>
                  <tr className="border-t border-slate-300 bg-green-50">
                    <td className="p-3 font-medium border-r border-slate-300 bg-green-100">
                      <div>New Net Stock</div>
                      <div className="text-[10px] text-slate-500 font-normal">(After Order)</div>
                    </td>
                    {newNetStock.map((v: number, i: number) => (
                      <td key={i} className="p-3 text-center border-r border-slate-300">
                        <div className={`font-semibold ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : 'text-slate-900'}`}>
                          {v}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">{newNetStockPressure[i]}%</div>
                      </td>
                    ))}
                    <td className={`p-3 text-center font-bold ${sum(newNetStock) < 0 ? 'text-red-700' : 'text-green-700'}`}>
                      {sum(newNetStock)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Fill Options */}
            <div className="pt-4 border-t-2 border-slate-200">
              <div className="bg-slate-50 rounded-lg border border-slate-200 p-4 space-y-3">
                <div className="text-sm font-semibold text-slate-700">Fill Order Using Historical Sales Pressure</div>
                
                <div className="flex gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`fillOption-${key}`}
                      checked={(fillOption[key] || 1) === 1}
                      onChange={() => setFillOption((prev) => ({ ...prev, [key]: 1 }))}
                      className="h-4 w-4 accent-[#8FA894]"
                    />
                    <span className="text-xs font-medium text-slate-700">By Sales %</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`fillOption-${key}`}
                      checked={fillOption[key] === 2}
                      onChange={() => setFillOption((prev) => ({ ...prev, [key]: 2 }))}
                      className="h-4 w-4 accent-[#B8A8D8]"
                    />
                    <span className="text-xs font-medium text-slate-700">Match %</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={`fillOption-${key}`}
                      checked={fillOption[key] === 3}
                      onChange={() => setFillOption((prev) => ({ ...prev, [key]: 3 }))}
                      className="h-4 w-4 accent-green-600"
                    />
                    <span className="text-xs font-medium text-slate-700">Fill to Target</span>
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-600 font-medium whitespace-nowrap">Amount:</label>
                  <Input
                    type="number"
                    inputMode="numeric"
                    className="w-28 h-9 text-sm rounded-lg"
                    placeholder="0"
                    value={fillAmount[key] || ''}
                    onChange={(e) => setFillAmount((prev) => ({ ...prev, [key]: e.target.value }))}
                    min={0}
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const opt = fillOption[key] || 1;
                      if (opt === 1) fillBySalesPressure(key, currentItem);
                      else if (opt === 2) matchSalesPressure(key, currentItem);
                      else fillGapsToTarget(key, currentItem);
                    }}
                    disabled={!fillAmount[key] || Number(fillAmount[key]) <= 0}
                    className="rounded-full px-4 bg-[#8FA894] hover:bg-[#C5D5CA]"
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>

            {/* Bottom Navigation */}
            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="outline" onClick={onBack}>
                Back
              </Button>
              <Button onClick={onContinue} className="bg-[#8FA894] hover:bg-[#C5D5CA]">
                Continue to Review
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* AI Suggestions Side Panel */}
      {aiPanelOpen && (
        <div className="w-80 shrink-0">
          <Card className="sticky top-4 border-[#B8A8D8]">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">AI Suggestions</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setAiPanelOpen(false)}>
                  ✕
                </Button>
              </div>
              <CardDescription>
                Based on {weeksCover} weeks cover using {dateRangeDisplay} sales
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {aiLoading ? (
                <div className="text-center py-8 text-slate-500">
                  <div className="animate-spin h-8 w-8 border-4 border-[#B8A8D8] border-t-transparent rounded-full mx-auto mb-2"></div>
                  Analyzing...
                </div>
              ) : currentSuggestion ? (
                <div className="space-y-3">
                  <div className="text-sm text-slate-700 leading-relaxed">
                    {currentSuggestion.analysis}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-slate-50 p-2 rounded">
                      <div className="text-slate-500">Weekly Rate</div>
                      <div className="font-semibold">{currentSuggestion.weekly_rate.toFixed(1)}</div>
                    </div>
                    <div className="bg-slate-50 p-2 rounded">
                      <div className="text-slate-500">Target Stock</div>
                      <div className="font-semibold">{currentSuggestion.target_stock}</div>
                    </div>
                    <div className="bg-slate-50 p-2 rounded">
                      <div className="text-slate-500">Net Stock</div>
                      <div className="font-semibold">{currentSuggestion.current_available}</div>
                    </div>
                    <div className="bg-[#8FA894]/20 p-2 rounded">
                      <div className="text-slate-500">Suggested Order</div>
                      <div className="font-semibold text-[#8FA894]">
                        {sum(currentSuggestion.order_suggestion)}
                      </div>
                    </div>
                  </div>
                  <div className="pt-2 border-t">
                    <div className="text-xs font-medium text-slate-600 mb-2">Suggested per size:</div>
                    <div className="flex flex-wrap gap-1">
                      {currentSuggestion.sizes.map((size, i) => (
                        <div key={size} className="px-2 py-1 bg-[#8FA894]/20 rounded text-xs">
                          {size}: <strong>{currentSuggestion.order_suggestion[i]}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                  <Button
                    className="w-full bg-[#8FA894] hover:bg-[#C5D5CA]"
                    onClick={() => applySuggestion(key, currentSuggestion.order_suggestion)}
                  >
                    Apply Suggestion
                  </Button>
                </div>
              ) : (
                <div className="text-center py-8 text-slate-500 text-sm">
                  No suggestion available for this item. Run AI Analysis to generate suggestions.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
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
  selections: Selection[];
  inputsByKey: InputRecord;
  onBack: () => void;
  onReset: () => void;
}) {
  const router = useRouter();
  const [finalizing, setFinalizing] = React.useState(false);

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
      const now = new Date();
      const poNo = `NOOS-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      
      const orderData = {
        po_no: poNo,
        status: 'Running',
        styles: orderItems.length,
        ordered: grandTotal,
        shipped: 0,
        meta: {
          items: orderItems,
          created_from: 'call-off',
          type: 'noos',
          created_at: now.toISOString()
        }
      };

      const { data, error } = await supabase
        .from('app_pos')
        .insert(orderData)
        .select()
        .single();

      if (error) throw error;

      onReset();
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
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Step 4: Review NOOS Call Off</CardTitle>
          <CardDescription>
            Review your call off order before finalizing.
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
                  <div key={idx} className="flex items-center justify-between p-3 border rounded-lg border-[#C5D5CA]">
                    <div>
                      <div className="font-semibold text-sm">
                        {item.style_no} - {item.color}
                      </div>
                      <div className="text-xs text-slate-600">
                        Quantities: {item.quantities.join(', ')}
                      </div>
                    </div>
                    <div className="text-lg font-bold text-[#8FA894]">{item.total}</div>
                  </div>
                ))}
              </div>

              <div className="pt-4 border-t">
                <div className="flex items-center justify-between text-lg font-bold">
                  <span>Grand Total:</span>
                  <span className="text-[#8FA894]">{grandTotal}</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t">
                <Button variant="outline" onClick={onBack} disabled={finalizing}>
                  Back
                </Button>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={onReset} disabled={finalizing}>
                    Start New Call Off
                  </Button>
                  <Button 
                    onClick={handleFinalizeOrder} 
                    disabled={finalizing}
                    className="bg-[#8FA894] hover:bg-[#C5D5CA]"
                  >
                    {finalizing ? 'Creating Order...' : 'Finalize Call Off'}
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

// ==================== FULL ANALYSIS MODAL ====================
function FullAnalysisModal({
  isOpen,
  onClose,
  selections,
  dateRange,
  setDateRange,
  weeksCover,
  setWeeksCover,
  loading,
  result,
  onRunAnalysis
}: {
  isOpen: boolean;
  onClose: () => void;
  selections: Selection[];
  dateRange: { start: string; end: string };
  setDateRange: React.Dispatch<React.SetStateAction<{ start: string; end: string }>>;
  weeksCover: number;
  setWeeksCover: React.Dispatch<React.SetStateAction<number>>;
  loading: boolean;
  result: FullAnalysisResult | null;
  onRunAnalysis: () => void;
}) {
  const [filter, setFilter] = React.useState<'all' | 'critical' | 'low' | 'ok' | 'surplus'>('all');
  const [expandedItem, setExpandedItem] = React.useState<string | null>(null);

  if (!isOpen) return null;

  const toggleExpand = (key: string) => {
    setExpandedItem(expandedItem === key ? null : key);
  };

  const filteredItems = result?.items.filter(item => {
    if (filter === 'all') return true;
    return item.status === filter;
  }) || [];

  const getStatusBadge = (status: 'critical' | 'low' | 'ok' | 'surplus') => {
    switch (status) {
      case 'critical':
        return <Badge className="bg-red-500 text-white text-[10px]">Critical</Badge>;
      case 'low':
        return <Badge className="bg-amber-500 text-white text-[10px]">Low</Badge>;
      case 'ok':
        return <Badge className="bg-green-500 text-white text-[10px]">OK</Badge>;
      case 'surplus':
        return <Badge className="bg-blue-500 text-white text-[10px]">Surplus</Badge>;
    }
  };

  // Generate and download PDF report
  const downloadPDF = () => {
    if (!result) return;

    // Create a printable HTML document
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow popups to download the PDF report');
      return;
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>NOOS Call Off Analysis Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
    h1 { color: #8FA894; margin-bottom: 5px; }
    h2 { color: #666; margin-top: 30px; border-bottom: 2px solid #C5D5CA; padding-bottom: 5px; }
    h3 { color: #888; margin-top: 20px; }
    .meta { color: #888; font-size: 12px; margin-bottom: 30px; }
    .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 20px 0; }
    .summary-box { padding: 15px; border-radius: 8px; text-align: center; }
    .summary-box.critical { background: #FEE2E2; color: #991B1B; }
    .summary-box.low { background: #FEF3C7; color: #92400E; }
    .summary-box.ok { background: #D1FAE5; color: #065F46; }
    .summary-box.surplus { background: #DBEAFE; color: #1E40AF; }
    .summary-box.total { background: #F3F4F6; color: #374151; }
    .summary-box .number { font-size: 24px; font-weight: bold; }
    .summary-box .label { font-size: 11px; text-transform: uppercase; }
    .order-section { background: #F0FDF4; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .order-total { font-size: 28px; font-weight: bold; color: #8FA894; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 11px; }
    th, td { padding: 8px; text-align: left; border: 1px solid #E5E7EB; }
    th { background: #F5F3F0; font-weight: 600; }
    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .badge { padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
    .badge.critical { background: #EF4444; color: white; }
    .badge.low { background: #F59E0B; color: white; }
    .badge.ok { background: #22C55E; color: white; }
    .badge.surplus { background: #3B82F6; color: white; }
    .trend-up { color: #16A34A; }
    .trend-down { color: #DC2626; }
    .ai-summary { background: #F5F3FF; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B8A8D8; }
    .ai-summary pre { white-space: pre-wrap; font-family: inherit; margin: 0; }
    .page-break { page-break-before: always; }
    @media print { 
      body { margin: 20px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <h1>NOOS Call Off Analysis Report</h1>
  <div class="meta">
    Generated: ${new Date().toLocaleString()}<br>
    Analysis Period: ${result.dateRange.display}<br>
    ${result.nextMonthRange ? `Next Month Comparison: ${result.nextMonthRange.display}<br>` : ''}
    Target Coverage: ${weeksCover} weeks
  </div>

  <h2>Summary</h2>
  <div class="summary-grid">
    <div class="summary-box total">
      <div class="number">${result.summary.totalItems}</div>
      <div class="label">Total Items</div>
    </div>
    <div class="summary-box critical">
      <div class="number">${result.summary.criticalItems}</div>
      <div class="label">Critical</div>
    </div>
    <div class="summary-box low">
      <div class="number">${result.summary.lowItems}</div>
      <div class="label">Low Stock</div>
    </div>
    <div class="summary-box ok">
      <div class="number">${result.summary.okItems}</div>
      <div class="label">OK</div>
    </div>
    <div class="summary-box surplus">
      <div class="number">${result.summary.surplusItems}</div>
      <div class="label">Surplus</div>
    </div>
  </div>

  <div class="order-section">
    <h3 style="margin-top: 0;">📦 Total Suggested Order</h3>
    <div class="order-total">+${result.summary.totalSuggestedOrder} units</div>
    ${result.summary.trendSummary ? `<div style="margin-top: 10px; color: #666;">📊 ${result.summary.trendSummary}</div>` : ''}
  </div>

  ${result.ordersByStyle && result.ordersByStyle.length > 0 ? `
  <h2>Order by Style</h2>
  <table>
    <thead>
      <tr>
        <th>Style</th>
        <th class="text-right">Total Order</th>
        <th>Colors Breakdown</th>
      </tr>
    </thead>
    <tbody>
      ${result.ordersByStyle.map(s => `
        <tr>
          <td><strong>${s.style_no}</strong></td>
          <td class="text-right"><strong>+${s.totalOrder}</strong></td>
          <td>${s.colors.map(c => `${c.color}: +${c.order}`).join(', ')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  ` : ''}

  <h2>AI Analysis & Recommendations</h2>
  <div class="ai-summary">
    <pre>${result.summary.aiSummary}</pre>
  </div>

  <div class="page-break"></div>
  <h2>Detailed Item Analysis</h2>
  <table>
    <thead>
      <tr>
        <th>Style</th>
        <th>Color</th>
        <th class="text-center">Status</th>
        <th class="text-center">Trend</th>
        <th class="text-right">Stock</th>
        <th class="text-right">Sold</th>
        <th class="text-right">Net Stock</th>
        <th class="text-right">Historical</th>
        <th class="text-right">Target</th>
        <th class="text-right">Order</th>
      </tr>
    </thead>
    <tbody>
      ${result.items.map(item => `
        <tr>
          <td>${item.style_no}</td>
          <td>${item.color}</td>
          <td class="text-center"><span class="badge ${item.status}">${item.status.toUpperCase()}</span></td>
          <td class="text-center ${item.trendDirection === 'up' ? 'trend-up' : item.trendDirection === 'down' ? 'trend-down' : ''}">
            ${item.trendDirection === 'up' ? `↑ +${item.trendPercent.toFixed(0)}%` : item.trendDirection === 'down' ? `↓ ${item.trendPercent.toFixed(0)}%` : '—'}
          </td>
          <td class="text-right">${item.totalStock}</td>
          <td class="text-right">${item.totalSold}</td>
          <td class="text-right" style="color: ${item.totalNetStock < 0 ? '#DC2626' : 'inherit'}; font-weight: ${item.totalNetStock < 0 ? 'bold' : 'normal'};">${item.totalNetStock}</td>
          <td class="text-right">${item.totalHistorical}</td>
          <td class="text-right">${item.targetStock}</td>
          <td class="text-right" style="color: #8FA894; font-weight: bold;">${item.suggestedOrder > 0 ? `+${item.suggestedOrder}` : '—'}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="no-print" style="margin-top: 40px; text-align: center;">
    <button onclick="window.print()" style="padding: 10px 30px; background: #8FA894; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px;">
      Print / Save as PDF
    </button>
  </div>
</body>
</html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b bg-[#F5F3F0]">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Full AI Analysis</h2>
            <p className="text-sm text-slate-600">
              Comprehensive stock analysis for {selections.length} selected items
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-full transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* Configuration */}
          {!result && (
            <Card className="border-[#C5D5CA]">
              <CardHeader>
                <CardTitle className="text-lg">Analysis Configuration</CardTitle>
                <CardDescription>
                  Set the comparison date range and target weeks cover for the analysis
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Start Date</label>
                    <Input
                      type="date"
                      value={dateRange.start}
                      onChange={(e) => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                      className="border-[#C5D5CA]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">End Date</label>
                    <Input
                      type="date"
                      value={dateRange.end}
                      onChange={(e) => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                      className="border-[#C5D5CA]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Target Weeks Cover</label>
                    <Input
                      type="number"
                      min={1}
                      max={52}
                      value={weeksCover}
                      onChange={(e) => setWeeksCover(Math.max(1, parseInt(e.target.value) || 4))}
                      className="border-[#C5D5CA]"
                    />
                  </div>
                </div>
                
                <Button
                  onClick={onRunAnalysis}
                  disabled={loading || !dateRange.start || !dateRange.end}
                  className="w-full bg-[#B8A8D8] hover:bg-[#B8A8D8]/80 text-white"
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Analyzing {selections.length} items...
                    </span>
                  ) : (
                    `Run Full AI Analysis (${selections.length} items)`
                  )}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Loading State */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <div className="text-center space-y-4">
                <svg className="animate-spin h-12 w-12 mx-auto text-[#B8A8D8]" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <p className="text-slate-600">Analyzing stock levels and generating AI insights...</p>
                <p className="text-sm text-slate-400">This may take a moment for {selections.length} items</p>
              </div>
            </div>
          )}

          {/* Results */}
          {result && !loading && (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="bg-slate-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-slate-900">{result.summary.totalItems}</div>
                  <div className="text-xs text-slate-600">Total Items</div>
                </div>
                <div className="bg-red-50 rounded-lg p-4 text-center cursor-pointer hover:bg-red-100 transition-colors" onClick={() => setFilter('critical')}>
                  <div className="text-2xl font-bold text-red-600">{result.summary.criticalItems}</div>
                  <div className="text-xs text-red-700">Critical</div>
                </div>
                <div className="bg-amber-50 rounded-lg p-4 text-center cursor-pointer hover:bg-amber-100 transition-colors" onClick={() => setFilter('low')}>
                  <div className="text-2xl font-bold text-amber-600">{result.summary.lowItems}</div>
                  <div className="text-xs text-amber-700">Low Stock</div>
                </div>
                <div className="bg-green-50 rounded-lg p-4 text-center cursor-pointer hover:bg-green-100 transition-colors" onClick={() => setFilter('ok')}>
                  <div className="text-2xl font-bold text-green-600">{result.summary.okItems}</div>
                  <div className="text-xs text-green-700">OK</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-4 text-center cursor-pointer hover:bg-blue-100 transition-colors" onClick={() => setFilter('surplus')}>
                  <div className="text-2xl font-bold text-blue-600">{result.summary.surplusItems}</div>
                  <div className="text-xs text-blue-700">Surplus</div>
                </div>
              </div>

              {/* Order Overview by Style */}
              {result.ordersByStyle && result.ordersByStyle.length > 0 && (
                <Card className="border-[#8FA894] bg-[#8FA894]/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <svg className="w-4 h-4 text-[#8FA894]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                      </svg>
                      Suggested Order Summary
                      <Badge className="ml-2 bg-[#8FA894] text-white">{result.summary.totalSuggestedOrder} units total</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {result.ordersByStyle.map((style) => (
                        <div key={style.style_no} className="border rounded-lg p-3 bg-white">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-sm">{style.style_no}</span>
                            <span className="text-lg font-bold text-[#8FA894]">+{style.totalOrder}</span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {style.colors.map((c, i) => (
                              <span 
                                key={i} 
                                className={`text-[10px] px-2 py-0.5 rounded-full ${
                                  c.status === 'critical' ? 'bg-red-100 text-red-700' :
                                  c.status === 'low' ? 'bg-amber-100 text-amber-700' :
                                  'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {c.color}: +{c.order}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* AI Summary */}
              <Card className="border-[#B8A8D8] bg-[#B8A8D8]/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <svg className="w-4 h-4 text-[#B8A8D8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    AI Analysis & Recommendations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="prose prose-sm max-w-none text-slate-700">
                    <div className="whitespace-pre-wrap text-sm">{result.summary.aiSummary}</div>
                  </div>
                  <div className="mt-4 pt-3 border-t flex items-center gap-4 text-xs text-slate-500">
                    <span>Analysis Period: {result.dateRange.display}</span>
                    {result.nextMonthRange && (
                      <span>Next Month Comparison: {result.nextMonthRange.display}</span>
                    )}
                  </div>
                  {result.summary.trendSummary && (
                    <div className="mt-2 text-xs text-slate-600">
                      📊 {result.summary.trendSummary}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Filter Tabs */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">Filter:</span>
                {(['all', 'critical', 'low', 'ok', 'surplus'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                      filter === f
                        ? 'bg-[#8FA894] text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)} 
                    ({f === 'all' ? result.items.length : result.items.filter(i => i.status === f).length})
                  </button>
                ))}
              </div>

              {/* Items Table */}
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#F5F3F0]">
                    <tr>
                      <th className="text-left p-3 font-medium w-8"></th>
                      <th className="text-left p-3 font-medium">Style / Color</th>
                      <th className="text-center p-3 font-medium">Status</th>
                      <th className="text-center p-3 font-medium">Trend</th>
                      <th className="text-right p-3 font-medium">Stock</th>
                      <th className="text-right p-3 font-medium">Sold</th>
                      <th className="text-right p-3 font-medium">Net Stock</th>
                      <th className="text-right p-3 font-medium">Historical</th>
                      <th className="text-right p-3 font-medium">Target</th>
                      <th className="text-right p-3 font-medium">Suggested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item, idx) => {
                      const itemKey = `${item.style_no}|${item.color}`;
                      const isExpanded = expandedItem === itemKey;
                      return (
                        <React.Fragment key={idx}>
                          <tr 
                            className={`border-t hover:bg-slate-50 cursor-pointer ${isExpanded ? 'bg-[#F5F3F0]' : ''}`}
                            onClick={() => toggleExpand(itemKey)}
                          >
                            <td className="p-3 text-center">
                              <svg 
                                className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} 
                                fill="none" 
                                stroke="currentColor" 
                                viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </td>
                            <td className="p-3">
                              <div className="font-medium">{item.style_no}</div>
                              <div className="text-xs text-slate-500">{item.color}</div>
                            </td>
                            <td className="p-3 text-center">
                              {getStatusBadge(item.status)}
                            </td>
                            <td className="p-3 text-center">
                              {item.trendDirection === 'up' && (
                                <span className="text-green-600 text-xs font-medium" title={`+${item.trendPercent.toFixed(0)}%`}>
                                  ↑ +{item.trendPercent.toFixed(0)}%
                                </span>
                              )}
                              {item.trendDirection === 'down' && (
                                <span className="text-red-600 text-xs font-medium" title={`${item.trendPercent.toFixed(0)}%`}>
                                  ↓ {item.trendPercent.toFixed(0)}%
                                </span>
                              )}
                              {item.trendDirection === 'stable' && (
                                <span className="text-slate-400 text-xs">—</span>
                              )}
                            </td>
                            <td className="p-3 text-right text-slate-600">
                              {item.totalStock}
                            </td>
                            <td className="p-3 text-right text-slate-600">
                              {item.totalSold}
                            </td>
                            <td className={`p-3 text-right font-medium ${item.totalNetStock < 0 ? 'text-red-600' : ''}`}>
                              {item.totalNetStock}
                            </td>
                            <td className="p-3 text-right text-slate-600">
                              {item.totalHistorical}
                            </td>
                            <td className="p-3 text-right text-slate-600">
                              {item.targetStock}
                            </td>
                            <td className="p-3 text-right">
                              <span className={`font-bold ${item.suggestedOrder > 0 ? 'text-[#8FA894]' : 'text-slate-400'}`}>
                                {item.suggestedOrder > 0 ? `+${item.suggestedOrder}` : '—'}
                              </span>
                            </td>
                          </tr>
                          {/* Expanded Detail Row */}
                          {isExpanded && (
                            <tr className="border-t bg-slate-50">
                              <td colSpan={10} className="p-4">
                                <div className="space-y-3">
                                  <div className="text-xs font-semibold text-slate-600 uppercase">Size Breakdown</div>
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-xs border">
                                      <thead className="bg-slate-100">
                                        <tr>
                                          <th className="p-2 text-left border-r font-medium">Metric</th>
                                          {item.sizes.map((size, i) => (
                                            <th key={i} className="p-2 text-center border-r font-medium min-w-[50px]">{size}</th>
                                          ))}
                                          <th className="p-2 text-center font-bold bg-slate-200">Total</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        <tr className="border-t">
                                          <td className="p-2 font-medium border-r bg-slate-50">Stock</td>
                                          {item.stock.map((v, i) => (
                                            <td key={i} className="p-2 text-center border-r">{v}</td>
                                          ))}
                                          <td className="p-2 text-center font-bold bg-slate-100">{item.totalStock}</td>
                                        </tr>
                                        <tr className="border-t">
                                          <td className="p-2 font-medium border-r bg-slate-50">Sold</td>
                                          {item.sold.map((v, i) => (
                                            <td key={i} className="p-2 text-center border-r text-red-600">{v > 0 ? `-${v}` : '0'}</td>
                                          ))}
                                          <td className="p-2 text-center font-bold bg-slate-100 text-red-600">{item.totalSold > 0 ? `-${item.totalSold}` : '0'}</td>
                                        </tr>
                                        <tr className="border-t bg-amber-50">
                                          <td className="p-2 font-medium border-r bg-amber-100">Net Stock</td>
                                          {item.netStock.map((v, i) => (
                                            <td key={i} className={`p-2 text-center border-r font-semibold ${v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : ''}`}>{v}</td>
                                          ))}
                                          <td className={`p-2 text-center font-bold bg-amber-100 ${item.totalNetStock < 0 ? 'text-red-700' : 'text-green-700'}`}>{item.totalNetStock}</td>
                                        </tr>
                                        <tr className="border-t">
                                          <td className="p-2 font-medium border-r bg-slate-50">Historical Sales</td>
                                          {item.historical.map((v, i) => (
                                            <td key={i} className="p-2 text-center border-r text-blue-600">{v}</td>
                                          ))}
                                          <td className="p-2 text-center font-bold bg-slate-100 text-blue-600">{item.totalHistorical}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                  <div className="flex items-center gap-6 text-xs text-slate-600 pt-2 border-t">
                                    <div>
                                      <span className="text-slate-500">Weekly Rate:</span>{' '}
                                      <strong>{item.weeklyRate.toFixed(1)} units/wk</strong>
                                    </div>
                                    <div>
                                      <span className="text-slate-500">Target Stock:</span>{' '}
                                      <strong>{item.targetStock} units</strong>
                                    </div>
                                    <div>
                                      <span className="text-slate-500">Suggested Order:</span>{' '}
                                      <strong className="text-[#8FA894]">{item.suggestedOrder > 0 ? `+${item.suggestedOrder}` : 'None needed'}</strong>
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {filteredItems.length === 0 && (
                  <div className="p-8 text-center text-slate-500">
                    No items match the selected filter
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t bg-[#F5F3F0]">
          {result && !loading ? (
            <>
              <Button variant="outline" onClick={() => {
                setFilter('all');
                onRunAnalysis();
              }}>
                Re-run Analysis
              </Button>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={downloadPDF}
                  className="border-[#8FA894] text-[#8FA894] hover:bg-[#8FA894]/10"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Download PDF Report
                </Button>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <div className="w-full flex justify-end">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
