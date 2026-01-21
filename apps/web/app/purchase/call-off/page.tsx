'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { Settings } from 'lucide-react';
import FullAnalysisModal from './FullAnalysisModal';
import CallOffSetsModal from './CallOffSetsModal';

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
  style_name: string;
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
  style_name: string;
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
    selectedSetId: 'callOff.process.selectedSetId',
    selectedMonths: 'callOff.process.selectedMonths',
  }), []);

  const [started, setStarted] = React.useState<boolean>(false);
  const [step, setStep] = React.useState<number>(1);
  const [returnPath, setReturnPath] = React.useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Selected Set (Stock List) ID
  const [selectedSetId, setSelectedSetId] = React.useState<string>('');
  
  // Modal for managing sets
  const [setsModalOpen, setSetsModalOpen] = React.useState(false);
  
  // Selected months for multi-month historical analysis (e.g. ['2024-01', '2024-02'])
  const [selectedMonths, setSelectedMonths] = React.useState<string[]>([]);
  
  // NOOS styles (auto-loaded) - fallback when no set selected
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

  // Fetch all stock lists (sets)
  const { data: stockLists } = useSWR('callOff:stockLists', async () => {
    const { data, error } = await supabase
      .from('stock_lists')
      .select('id, name, fixed')
      .order('name');
    if (error) throw error;
    
    // Sort: NOOS first, then other fixed, then custom
    const sortOrder: Record<string, number> = { 'NOOS': 1, 'Aktiv': 2, 'Passiv': 3 };
    return ((data ?? []) as Array<{ id: string; name: string; fixed: boolean }>).sort((a, b) => {
      const aOrder = sortOrder[a.name] ?? (a.fixed ? 10 : 100);
      const bOrder = sortOrder[b.name] ?? (b.fixed ? 10 : 100);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });
  });

  // Fetch styles from selected set (or fallback to NOOS)
  const effectiveSetId = selectedSetId || stockLists?.find(l => l.name === 'NOOS')?.id || '';
  
  const { data: setStylesData } = useSWR(
    effectiveSetId ? ['callOff:setStyles', effectiveSetId] : null,
    async () => {
      // Get styles in this set
      const { data: listStyles, error: listError } = await supabase
        .from('stock_list_styles')
        .select('style_id')
        .eq('list_id', effectiveSetId);
      
      if (listError) throw listError;
      if (!listStyles || listStyles.length === 0) return [];

      const styleIds = listStyles.map((s: any) => s.style_id);

      // Get style details
      const { data: styles, error: stylesError } = await supabase
        .from('styles')
        .select('id, style_no, style_name, supplier, image_url')
        .in('id', styleIds)
        .order('style_no', { ascending: true });
      
      if (stylesError) throw stylesError;

      return (styles ?? []) as Array<{
        id: string;
        style_no: string;
        style_name: string | null;
        supplier: string | null;
        image_url: string | null;
      }>;
    }
  );

  // Fetch included colors from selected set
  const { data: setColorsData } = useSWR(
    effectiveSetId ? ['callOff:setColors', effectiveSetId] : null,
    async () => {
      const { data, error } = await supabase
        .from('stock_list_colors')
        .select('style_id, style_color_id, include, style_colors!inner(id, color, style_id)')
        .eq('list_id', effectiveSetId)
        .eq('include', true);
      
      if (error) throw error;
      
      // Supabase returns joined relations - normalize the response
      return (data ?? []).map((row: any) => ({
        style_id: row.style_id as string,
        style_color_id: row.style_color_id as string,
        include: row.include as boolean,
        style_colors: Array.isArray(row.style_colors) 
          ? row.style_colors[0] as { id: string; color: string; style_id: string }
          : row.style_colors as { id: string; color: string; style_id: string }
      }));
    }
  );

  // Legacy alias for NOOS data (for backward compat with existing components)
  const noosData = setStylesData;

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
      const setId = localStorage.getItem(STORAGE_KEYS.selectedSetId);
      const months = localStorage.getItem(STORAGE_KEYS.selectedMonths);
      
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
      if (setId) {
        setSelectedSetId(setId);
      }
      if (months) {
        try { setSelectedMonths(JSON.parse(months) as string[]); } catch {}
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

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selectedSetId, selectedSetId); } catch {}
  }, [selectedSetId, STORAGE_KEYS.selectedSetId]);

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.selectedMonths, JSON.stringify(selectedMonths)); } catch {}
  }, [selectedMonths, STORAGE_KEYS.selectedMonths]);

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
      setSelectedSetId('');
      setSelectedMonths([]);
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
            onClick={() => router.push('/ai-analysis')}
            className="border-slate-300"
          >
            AI Purchase Analysis
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
            {step === 1 && 'Select Set & Months'}
            {step === 2 && 'AI Analysis & Proposal'}
            {step === 3 && 'Review & Confirm'}
            {step === 4 && 'Push to PO'}
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
              and AI-powered analysis using historical sales data from selected months.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="text-sm text-slate-600">
                <strong>{stockLists?.length ?? 0}</strong> sets available · 
                <strong className="ml-1">{noosData?.length ?? 0}</strong> styles in default NOOS set
              </div>
            </div>
            <Button 
              onClick={startProcess}
              className="bg-[#8FA894] hover:bg-[#C5D5CA] text-white"
            >
              Start Call Off
            </Button>
          </CardContent>
        </Card>
      )}

      {started && step === 1 && (
        <Step1SelectSet
          stockLists={stockLists ?? []}
          selectedSetId={selectedSetId}
          setSelectedSetId={setSelectedSetId}
          setStylesData={setStylesData ?? []}
          setColorsData={setColorsData ?? []}
          selectedMonths={selectedMonths}
          setSelectedMonths={setSelectedMonths}
          selections={selections}
          setSelections={setSelections}
          weeksCover={weeksCover}
          setWeeksCover={setWeeksCover}
          onRunAIAnalysis={async () => {
            // Move to step 2 and trigger AI analysis
            setStep(2);
            setFullAnalysisLoading(true);
            setFullAnalysisResult(null);
            
            try {
              const res = await fetch('/api/call-off/full-analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  selections,
                  weeks_cover: weeksCover,
                  months: selectedMonths.length > 0 ? selectedMonths : undefined,
                })
              });
              
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Analysis failed');
              
              setFullAnalysisResult(data);
            } catch (err: any) {
              console.error('AI Analysis failed:', err);
              alert('AI Analysis failed: ' + err.message);
            } finally {
              setFullAnalysisLoading(false);
            }
          }}
          onOpenSetsModal={() => setSetsModalOpen(true)}
          isAnalysisReady={selections.length > 0 && selectedMonths.length > 0}
        />
      )}
      
      {/* Call-Off Sets Modal */}
      <CallOffSetsModal 
        isOpen={setsModalOpen} 
        onClose={() => setSetsModalOpen(false)} 
        onSelectSet={(setId, setName) => {
          setSelectedSetId(setId);
          setSetsModalOpen(false);
        }}
      />
      {started && step === 2 && (
        <Step2AIResults 
          selections={selections}
          selectedMonths={selectedMonths}
          weeksCover={weeksCover}
          loading={fullAnalysisLoading}
          result={fullAnalysisResult}
          onBack={() => setStep(1)} 
          onContinue={() => setStep(3)}
          onRerunAnalysis={async () => {
            setFullAnalysisLoading(true);
            setFullAnalysisResult(null);
            try {
              const res = await fetch('/api/call-off/full-analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  selections,
                  weeks_cover: weeksCover,
                  months: selectedMonths.length > 0 ? selectedMonths : undefined,
                })
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Analysis failed');
              setFullAnalysisResult(data);
            } catch (err: any) {
              console.error('AI Analysis failed:', err);
              alert('AI Analysis failed: ' + err.message);
            } finally {
              setFullAnalysisLoading(false);
            }
          }}
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
          selectedMonths={selectedMonths}
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

// ==================== STEP 1: Select Set or Styles ====================
function Step1SelectSet({
  stockLists,
  selectedSetId,
  setSelectedSetId,
  setStylesData,
  setColorsData,
  selectedMonths,
  setSelectedMonths,
  selections,
  setSelections,
  weeksCover,
  setWeeksCover,
  onRunAIAnalysis,
  onOpenSetsModal,
  isAnalysisReady
}: {
  stockLists: Array<{ id: string; name: string; fixed: boolean }>;
  selectedSetId: string;
  setSelectedSetId: React.Dispatch<React.SetStateAction<string>>;
  setStylesData: Array<{
    id: string;
    style_no: string;
    style_name: string | null;
    supplier: string | null;
    image_url: string | null;
  }>;
  setColorsData: Array<{
    style_id: string;
    style_color_id: string;
    include: boolean;
    style_colors: { id: string; color: string; style_id: string };
  }>;
  selectedMonths: string[];
  setSelectedMonths: React.Dispatch<React.SetStateAction<string[]>>;
  selections: Selection[];
  setSelections: React.Dispatch<React.SetStateAction<Selection[]>>;
  weeksCover: number;
  setWeeksCover: React.Dispatch<React.SetStateAction<number>>;
  onRunAIAnalysis: () => void;
  onOpenSetsModal: () => void;
  isAnalysisReady: boolean;
}) {
  // Build style_id -> style_no map
  const styleIdToNo = React.useMemo(() => {
    const map = new Map<string, string>();
    setStylesData.forEach(s => map.set(s.id, s.style_no));
    return map;
  }, [setStylesData]);

  // Auto-select colors from set when set changes
  React.useEffect(() => {
    if (setColorsData && setColorsData.length > 0) {
      const newSelections: Selection[] = [];
      setColorsData.forEach(c => {
        const style_no = styleIdToNo.get(c.style_id);
        if (style_no && c.include) {
          newSelections.push({ style_no, color: c.style_colors.color });
        }
      });
      setSelections(newSelections);
    }
  }, [setColorsData, styleIdToNo, setSelections]);

  // Generate month options (last 24 months)
  const monthOptions = React.useMemo(() => {
    const options: { value: string; label: string }[] = [];
    const now = new Date();
    for (let i = 1; i <= 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      options.push({ value, label });
    }
    return options;
  }, []);

  // Default to same month last year if no months selected
  React.useEffect(() => {
    if (selectedMonths.length === 0) {
      const now = new Date();
      const lastYear = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      const defaultMonth = `${lastYear.getFullYear()}-${String(lastYear.getMonth() + 1).padStart(2, '0')}`;
      setSelectedMonths([defaultMonth]);
    }
  }, [selectedMonths.length, setSelectedMonths]);

  function toggleMonth(month: string) {
    setSelectedMonths(prev => {
      if (prev.includes(month)) {
        return prev.filter(m => m !== month);
      }
      return [...prev, month].sort();
    });
  }

  const selectedSetName = stockLists.find(l => l.id === selectedSetId)?.name || 'NOOS';

  return (
    <div className="space-y-4">
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Step 1: Select Set & Historical Months</CardTitle>
          <CardDescription>
            Choose a Style/Color Set to load, and select which months of historical data to use for analysis.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Set Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Select Set</label>
            <select
              value={selectedSetId}
              onChange={(e) => setSelectedSetId(e.target.value)}
              className="w-full h-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#8FA894]"
            >
              <option value="">NOOS (default)</option>
              {stockLists.map(list => (
                <option key={list.id} value={list.id}>
                  {list.name} {list.fixed ? '(System)' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onOpenSetsModal}
              className="flex items-center gap-1.5 text-xs text-[#8FA894] hover:text-[#7a9381] transition-colors"
            >
              <Settings className="h-3.5 w-3.5" />
              Manage Sets
            </button>
          </div>

          {/* Multi-Month Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              Historical Months <span className="font-normal text-slate-500">(select one or more)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {monthOptions.slice(0, 12).map(opt => {
                const isSelected = selectedMonths.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    onClick={() => toggleMonth(opt.value)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                      isSelected
                        ? 'bg-[#8FA894] text-white ring-2 ring-[#8FA894] ring-offset-1'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {selectedMonths.length > 0 && (
              <p className="text-xs text-slate-600">
                Selected: <strong>{selectedMonths.length}</strong> month{selectedMonths.length !== 1 ? 's' : ''}
                {' — '}{selectedMonths.map(m => {
                  const d = new Date(m + '-01');
                  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                }).join(', ')}
              </p>
            )}
          </div>

          {/* Styles Preview */}
          <div className="border-t pt-4">
            <h3 className="text-sm font-medium text-slate-700 mb-3">
              Styles in "{selectedSetName}" ({setStylesData.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-96 overflow-y-auto">
              {setStylesData.map((style) => (
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
                        className="h-12 w-12 object-cover rounded border"
                      />
                    ) : (
                      <div className="h-12 w-12 rounded border bg-gray-100 flex items-center justify-center text-xs text-gray-400">
                        —
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{style.style_no}</div>
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
          </div>

          {/* Weeks Cover Setting */}
          <div className="space-y-2 border-t pt-4">
            <label className="text-sm font-medium text-slate-700">
              Target Stock Cover (weeks)
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={2}
                max={12}
                value={weeksCover}
                onChange={(e) => setWeeksCover(Number(e.target.value))}
                className="flex-1"
              />
              <span className="text-lg font-semibold text-[#8FA894] w-12 text-center">{weeksCover}</span>
            </div>
            <p className="text-xs text-slate-500">
              AI will suggest order quantities to cover {weeksCover} weeks of projected sales
            </p>
          </div>

          {/* Run Analysis Button */}
          <div className="flex items-center justify-between pt-4 border-t">
            <div className="text-sm text-slate-600">
              <strong>{setStylesData.length}</strong> style{setStylesData.length !== 1 ? 's' : ''} · 
              <strong className="ml-1">{selections.length}</strong> color{selections.length !== 1 ? 's' : ''} selected ·
              <strong className="ml-1">{selectedMonths.length}</strong> month{selectedMonths.length !== 1 ? 's' : ''} of history
            </div>
            <Button 
              onClick={onRunAIAnalysis} 
              className="bg-[#8FA894] hover:bg-[#C5D5CA]"
              disabled={!isAnalysisReady}
            >
              🤖 Run AI Analysis
            </Button>
          </div>
          {!isAnalysisReady && (
            <p className="text-xs text-amber-600">
              Select at least one style/color and one historical month to run AI analysis
            </p>
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
  selectedMonths,
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
  selectedMonths: string[];
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
    
    const requestPayload = {
      selections,
      weeks_cover: fullAnalysisWeeksCover,
      months: selectedMonths.length > 0 ? selectedMonths : undefined,
      startDate: selectedMonths.length === 0 ? fullAnalysisDateRange.start : undefined,
      endDate: selectedMonths.length === 0 ? fullAnalysisDateRange.end : undefined
    };
    
    console.group('🔍 NOOS Call-Off Analysis Debug');
    console.log('📤 Request payload:', requestPayload);
    console.log('📅 Months:', selectedMonths.length > 0 ? selectedMonths : `${fullAnalysisDateRange.start} to ${fullAnalysisDateRange.end}`);
    console.log('📊 Selections:', selections.length, 'items');
    selections.forEach((s, i) => console.log(`   ${i + 1}. ${s.style_no} - ${s.color}`));
    
    try {
      const res = await fetch('/api/call-off/full-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload)
      });
      
      if (!res.ok) {
        const error = await res.json();
        console.error('❌ API Error:', error);
        console.groupEnd();
        throw new Error(error.error || 'Analysis failed');
      }
      
      const data = await res.json();
      
      console.log('📥 Response received:');
      console.log('   Date range used:', data.dateRange?.display);
      console.log('   Next month range:', data.nextMonthRange?.display);
      console.log('   Total items:', data.items?.length);
      console.log('   Total suggested order:', data.summary?.totalSuggestedOrder);
      
      // Debug info from server
      if (data._debug) {
        console.log('\n🔧 SERVER DEBUG INFO:');
        console.log('   Historical rows loaded:', data._debug.historicalRowsLoaded);
        console.log('   Historical total count (in DB):', data._debug.historicalTotalCount);
        console.log('   Total historical quantity:', data._debug.totalHistoricalQty);
        console.log('   Stock rows loaded:', data._debug.stockRowsLoaded);
        console.log('   Query date range:', data._debug.queryDateRange);
        console.log('   Query styles:', data._debug.queryStyleNos);
        console.log('   Query colors:', data._debug.queryColors);
      }
      
      // Debug each item's data
      console.log('\n📋 Item-by-Item Breakdown:');
      data.items?.forEach((item: any, i: number) => {
        console.group(`   ${i + 1}. ${item.style_name || item.style_no} - ${item.color}`);
        console.log('Stock:', item.stock, '→ Total:', item.totalStock);
        console.log('Sold:', item.sold, '→ Total:', item.totalSold);
        console.log('Net Stock:', item.netStock, '→ Total:', item.totalNetStock);
        console.log('Historical:', item.historical, '→ Total:', item.totalHistorical);
        console.log('Weekly Rate:', item.weeklyRate?.toFixed(2));
        console.log('Target:', item.targetStock);
        console.log('Suggested Order:', item.suggestedOrder);
        console.log('Status:', item.status);
        console.groupEnd();
      });
      
      console.groupEnd();
      
      setFullAnalysisResult(data);
    } catch (error: any) {
      console.error('❌ Full analysis error:', error);
      console.groupEnd();
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

// ==================== STEP 2: AI Results ====================
function Step2AIResults({
  selections,
  selectedMonths,
  weeksCover,
  loading,
  result,
  onBack,
  onContinue,
  onRerunAnalysis
}: {
  selections: Selection[];
  selectedMonths: string[];
  weeksCover: number;
  loading: boolean;
  result: FullAnalysisResult | null;
  onBack: () => void;
  onContinue: () => void;
  onRerunAnalysis: () => void;
}) {
  // Editable order quantities: key = style_no|color, value = per-size order values
  const [orderEdits, setOrderEdits] = React.useState<Record<string, number[]>>({});
  
  // Initialize order edits from AI suggestions when result loads
  React.useEffect(() => {
    if (result?.items) {
      const initialEdits: Record<string, number[]> = {};
      result.items.forEach(item => {
        const key = `${item.style_no}|${item.color}`;
        // Use newOrderNeededBySize if available (Bell Rain adjusted), otherwise suggestedOrderBySize
        initialEdits[key] = (item as any).newOrderNeededBySize || item.suggestedOrderBySize || [];
      });
      setOrderEdits(initialEdits);
    }
  }, [result]);

  // Update a single size value
  const updateOrderValue = (styleNo: string, color: string, sizeIndex: number, value: number) => {
    const key = `${styleNo}|${color}`;
    setOrderEdits(prev => {
      const current = prev[key] || [];
      const updated = [...current];
      updated[sizeIndex] = Math.max(0, value);
      return { ...prev, [key]: updated };
    });
  };

  // Calculate totals
  const totalUnits = React.useMemo(() => {
    return Object.values(orderEdits).reduce((sum, arr) => 
      sum + arr.reduce((a, b) => a + b, 0), 0);
  }, [orderEdits]);

  if (loading) {
    return (
      <Card className="border-[#C5D5CA]">
        <CardContent className="py-16">
          <div className="flex flex-col items-center justify-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-[#8FA894] border-t-transparent"></div>
            <div className="text-lg font-medium text-slate-700">Running AI Analysis...</div>
            <div className="text-sm text-slate-500">
              Analyzing {selections.length} style/color combinations using {selectedMonths.length} month(s) of historical data
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card className="border-red-200">
        <CardContent className="py-8">
          <div className="text-center">
            <div className="text-red-600 font-medium mb-4">Analysis failed or no results</div>
            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={onBack}>Back to Step 1</Button>
              <Button onClick={onRerunAnalysis} className="bg-[#8FA894]">Retry Analysis</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { items, summary, dateRange } = result;

  return (
    <div className="space-y-4">
      {/* Summary Card */}
      <Card className="border-[#C5D5CA] bg-gradient-to-r from-[#F5F3F0] to-white">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            🤖 AI Analysis Complete
          </CardTitle>
          <CardDescription>
            Based on {dateRange.display} historical data · {weeksCover} weeks target cover
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
            <div className="text-center p-3 bg-white rounded-lg border">
              <div className="text-2xl font-bold text-slate-800">{summary.totalItems}</div>
              <div className="text-xs text-slate-500">Items</div>
            </div>
            <div className="text-center p-3 bg-red-50 rounded-lg border border-red-200">
              <div className="text-2xl font-bold text-red-600">{summary.criticalItems}</div>
              <div className="text-xs text-red-600">Critical</div>
            </div>
            <div className="text-center p-3 bg-amber-50 rounded-lg border border-amber-200">
              <div className="text-2xl font-bold text-amber-600">{summary.lowItems}</div>
              <div className="text-xs text-amber-600">Low</div>
            </div>
            <div className="text-center p-3 bg-green-50 rounded-lg border border-green-200">
              <div className="text-2xl font-bold text-green-600">{summary.okItems}</div>
              <div className="text-xs text-green-600">OK</div>
            </div>
            <div className="text-center p-3 bg-blue-50 rounded-lg border border-blue-200">
              <div className="text-2xl font-bold text-blue-600">{totalUnits}</div>
              <div className="text-xs text-blue-600">Total Order</div>
            </div>
          </div>
          
          {summary.aiSummary && (
            <div className="bg-white p-4 rounded-lg border text-sm text-slate-700">
              <div className="font-medium text-slate-800 mb-1">AI Recommendation:</div>
              {summary.aiSummary}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Order Details */}
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Order Proposal</CardTitle>
          <CardDescription>
            Review and adjust quantities. Click on any number to edit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 max-h-[500px] overflow-y-auto">
            {items.map((item, idx) => {
              const key = `${item.style_no}|${item.color}`;
              const editedValues = orderEdits[key] || item.suggestedOrderBySize || [];
              const editedTotal = editedValues.reduce((a, b) => a + b, 0);
              const hasBellRain = (item as any).bellRainCallHome > 0;
              
              return (
                <div 
                  key={key}
                  className={`p-4 rounded-lg border ${
                    item.status === 'critical' ? 'border-red-300 bg-red-50' :
                    item.status === 'low' ? 'border-amber-300 bg-amber-50' :
                    item.status === 'ok' ? 'border-green-300 bg-green-50' :
                    'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="font-semibold">{item.style_name || item.style_no}</div>
                      <div className="text-sm text-slate-600">{item.style_no} · {item.color}</div>
                      {hasBellRain && (
                        <Badge className="mt-1 bg-purple-100 text-purple-700 text-[10px]">
                          🔔 Bell Rain: Call home {(item as any).bellRainCallHome} first
                        </Badge>
                      )}
                    </div>
                    <div className="text-right">
                      <Badge className={
                        item.status === 'critical' ? 'bg-red-600' :
                        item.status === 'low' ? 'bg-amber-500' :
                        item.status === 'ok' ? 'bg-green-600' :
                        'bg-blue-500'
                      }>
                        {item.status.toUpperCase()}
                      </Badge>
                      <div className="text-xs text-slate-500 mt-1">
                        Stock: {item.totalNetStock} · Weekly: {item.weeklyRate.toFixed(1)}
                      </div>
                    </div>
                  </div>
                  
                  {/* Size grid */}
                  <div className="grid grid-cols-7 gap-2">
                    {item.sizes.map((size, sizeIdx) => (
                      <div key={size} className="text-center">
                        <div className="text-[10px] text-slate-500 mb-1">{size}</div>
                        <Input
                          type="number"
                          min={0}
                          value={editedValues[sizeIdx] ?? 0}
                          onChange={(e) => updateOrderValue(item.style_no, item.color, sizeIdx, parseInt(e.target.value) || 0)}
                          className="h-8 text-center text-sm p-1"
                        />
                        <div className="text-[9px] text-slate-400 mt-0.5">
                          hist: {item.historical[sizeIdx] ?? 0}
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  <div className="flex justify-between items-center mt-2 pt-2 border-t">
                    <div className="text-xs text-slate-500">
                      AI suggested: {item.suggestedOrder}
                    </div>
                    <div className="text-sm font-semibold">
                      Order: {editedTotal}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={onBack}>Back to Step 1</Button>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onRerunAnalysis}>
            🔄 Re-run Analysis
          </Button>
          <Button 
            onClick={onContinue} 
            className="bg-[#8FA894] hover:bg-[#C5D5CA]"
            disabled={totalUnits === 0}
          >
            Continue to Review ({totalUnits} units)
          </Button>
        </div>
      </div>
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
  selectedMonths,
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
  selectedMonths: string[];
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
      ? ['callOff:historical', selections.map(s => `${s.style_no}|${s.color}`).join(','), selectedMonths.join(',') || `${dateRange.start}-${dateRange.end}`] 
      : null,
    async () => {
      const response = await fetch('/api/call-off/historical', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          selections, 
          months: selectedMonths.length > 0 ? selectedMonths : undefined,
          startDate: selectedMonths.length === 0 ? dateRange.start : undefined, 
          endDate: selectedMonths.length === 0 ? dateRange.end : undefined 
        })
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
          months: selectedMonths.length > 0 ? selectedMonths : undefined,
          startDate: selectedMonths.length === 0 ? dateRange.start : undefined,
          endDate: selectedMonths.length === 0 ? dateRange.end : undefined
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

// Full Analysis Modal is now imported from ./FullAnalysisModal.tsx
// See that file for the enhanced version with:
// - Per-size editable order inputs
// - Net Need calculations (targetStock - (stock - sold + currentOrder))
// - Feedback UI (Correct/Incorrect with notes)
// - Save analysis functionality

// === OLD INLINE FullAnalysisModal REMOVED ===
// It has been replaced by the imported component from ./FullAnalysisModal.tsx
