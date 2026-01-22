'use client';
import React from 'react';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { Settings, Zap, ClipboardList, X } from 'lucide-react';
import FullAnalysisModal from './FullAnalysisModal';
import CallOffSetsModal from './CallOffSetsModal';
import QuickPoFlow from './QuickPoFlow';

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
  purchaseRunning: number[];
  bellRainAvailable: number[];
  historical: number[];
  nextMonthHistorical: number[];
  totalStock: number;
  totalSold: number;
  totalNetStock: number;
  totalPurchaseRunning: number;
  totalBellRainAvailable: number;
  totalHistorical: number;
  totalNextMonthHistorical: number;
  weeklyRate: number;
  nextMonthWeeklyRate: number;
  targetStock: number;
  suggestedOrder: number;
  bellRainCallHome: number;
  newOrderNeeded: number;
  suggestedOrderBySize: number[];
  bellRainCallHomeBySize: number[];
  newOrderNeededBySize: number[];
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
    totalBellRainCallHome: number;
    totalNewOrderNeeded: number;
    aiSummary: string;
    trendSummary: string;
  };
  promptVersion: string;
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
    sizeRatioOverrides: 'callOff.process.sizeRatioOverrides', // Per-style month overrides for size-% ratio
    waitReminders: 'callOff.waitReminders', // Quick PO wait reminders
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
  
  // Per-style month overrides for size-% ratio calculation { [style_no]: ['2024-01', '2024-02'] }
  const [sizeRatioOverrides, setSizeRatioOverrides] = React.useState<Record<string, string[]>>({});
  
  // Wait reminders from Quick PO (style+color -> {days, createdAt})
  const [waitReminders, setWaitReminders] = React.useState<Array<{
    style_no: string;
    color: string;
    days: number;
    createdAt: string;
  }>>([]);
  
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
  
  // Order edits from AI results (key = style_no|color, value = per-size quantities)
  const [orderEdits, setOrderEdits] = React.useState<Record<string, number[]>>({});
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
      // Load per-style month overrides
      const overrides = localStorage.getItem(STORAGE_KEYS.sizeRatioOverrides);
      if (overrides) {
        try { setSizeRatioOverrides(JSON.parse(overrides) as Record<string, string[]>); } catch {}
      }
      // Load wait reminders
      const reminders = localStorage.getItem(STORAGE_KEYS.waitReminders);
      if (reminders) {
        try { setWaitReminders(JSON.parse(reminders)); } catch {}
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

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.sizeRatioOverrides, JSON.stringify(sizeRatioOverrides)); } catch {}
  }, [sizeRatioOverrides, STORAGE_KEYS.sizeRatioOverrides]);

  React.useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.waitReminders, JSON.stringify(waitReminders)); } catch {}
  }, [waitReminders, STORAGE_KEYS.waitReminders]);

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

  // Active flow tab: 'noos' or 'quickpo'
  const [activeFlow, setActiveFlow] = React.useState<'noos' | 'quickpo'>('noos');
  
  // Handle wait reminders from Quick PO Flow
  const handleAddWaitReminders = (reminders: Array<{ style_no: string; color: string; weeks: number; reminder_date: string }>) => {
    const newReminders = reminders.map(r => ({
      style_no: r.style_no,
      color: r.color,
      days: r.weeks * 7,
      createdAt: new Date().toISOString()
    }));
    setWaitReminders(prev => [...prev, ...newReminders]);
  };
  
  // Calculate remaining days for reminders
  const activeReminders = waitReminders.filter(r => {
    const createdAt = new Date(r.createdAt);
    const endDate = new Date(createdAt.getTime() + r.days * 24 * 60 * 60 * 1000);
    return endDate > new Date();
  });
  
  const dismissReminder = (idx: number) => {
    setWaitReminders(prev => prev.filter((_, i) => i !== idx));
  };

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
      
      {/* Flow Tabs */}
      <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveFlow('noos')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
            activeFlow === 'noos'
              ? 'bg-white text-[#8FA894] shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <ClipboardList className="h-4 w-4" />
          NOOS Call-Off
        </button>
        <button
          onClick={() => setActiveFlow('quickpo')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
            activeFlow === 'quickpo'
              ? 'bg-white text-[#8FA894] shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Zap className="h-4 w-4" />
          Quick PO
        </button>
      </div>
      
      {/* Wait Reminders */}
      {activeReminders.length > 0 && (
        <div className="space-y-2">
          {activeReminders.map((reminder, idx) => {
            const createdAt = new Date(reminder.createdAt);
            const endDate = new Date(createdAt.getTime() + reminder.days * 24 * 60 * 60 * 1000);
            const daysRemaining = Math.ceil((endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
            
            return (
              <div key={idx} className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-amber-100 rounded-full p-2">
                    <svg className="h-4 w-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-amber-900">
                      {reminder.style_no} - {reminder.color}
                    </div>
                    <div className="text-xs text-amber-700">
                      {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} remaining
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => dismissReminder(idx)}
                  className="text-amber-600 hover:text-amber-800 p-1"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Quick PO Flow Tab Content */}
      {activeFlow === 'quickpo' && (
        <QuickPoFlow onAddWaitReminders={handleAddWaitReminders} />
      )}

      {/* NOOS Call-Off Tab Content */}
      {activeFlow === 'noos' && (
        <>
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
          sizeRatioOverrides={sizeRatioOverrides}
          setSizeRatioOverrides={setSizeRatioOverrides}
          selections={selections}
          setSelections={setSelections}
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
          loading={fullAnalysisLoading}
          result={fullAnalysisResult}
          orderEdits={orderEdits}
          setOrderEdits={setOrderEdits}
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
        <Step3FinalReview 
          selections={selections} 
          orderEdits={orderEdits}
          analysisResult={fullAnalysisResult}
          onBack={() => setStep(2)} 
          onReset={resetProcess} 
        />
      )}
        </>
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
  sizeRatioOverrides,
  setSizeRatioOverrides,
  selections,
  setSelections,
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
  sizeRatioOverrides: Record<string, string[]>;
  setSizeRatioOverrides: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  selections: Selection[];
  setSelections: React.Dispatch<React.SetStateAction<Selection[]>>;
  onRunAIAnalysis: () => void;
  onOpenSetsModal: () => void;
  isAnalysisReady: boolean;
}) {
  // State for collapsed override section
  const [showOverrides, setShowOverrides] = React.useState(false);
  const [overrideSearch, setOverrideSearch] = React.useState('');
  const [selectedOverrideStyle, setSelectedOverrideStyle] = React.useState<string>('');
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

          {/* Per-Style Month Overrides (Collapsed, Optional) */}
          <div className="border rounded-lg border-slate-200 bg-slate-50/50">
            <button
              type="button"
              onClick={() => setShowOverrides(!showOverrides)}
              className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-slate-100 transition-colors rounded-lg"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-600">
                  Override months for specific styles
                </span>
                <span className="text-xs text-slate-400">(optional, for size-% ratio)</span>
                {Object.keys(sizeRatioOverrides).length > 0 && (
                  <Badge className="bg-[#8FA894] text-white text-[10px]">
                    {Object.keys(sizeRatioOverrides).length} override{Object.keys(sizeRatioOverrides).length !== 1 ? 's' : ''}
                  </Badge>
                )}
              </div>
              <svg className={`w-4 h-4 text-slate-400 transition-transform ${showOverrides ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            
            {showOverrides && (
              <div className="px-3 pb-3 space-y-3">
                <p className="text-xs text-slate-500">
                  Use different months for size distribution on specific styles. Default uses the global months above.
                </p>
                
                {/* Add override */}
                <div className="flex gap-2">
                  <select
                    value={selectedOverrideStyle}
                    onChange={(e) => setSelectedOverrideStyle(e.target.value)}
                    className="flex-1 h-9 rounded-md border border-slate-200 bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#8FA894]"
                  >
                    <option value="">Select a style to override...</option>
                    {setStylesData
                      .filter(s => !sizeRatioOverrides[s.style_no])
                      .map(s => (
                        <option key={s.style_no} value={s.style_no}>
                          {s.style_no} - {s.style_name || 'Unknown'}
                        </option>
                      ))
                    }
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedOverrideStyle}
                    onClick={() => {
                      if (selectedOverrideStyle) {
                        setSizeRatioOverrides(prev => ({
                          ...prev,
                          [selectedOverrideStyle]: selectedMonths.length > 0 ? [...selectedMonths] : []
                        }));
                        setSelectedOverrideStyle('');
                      }
                    }}
                    className="text-xs"
                  >
                    Add Override
                  </Button>
                </div>

                {/* List of overrides */}
                {Object.keys(sizeRatioOverrides).length > 0 && (
                  <div className="space-y-2">
                    {Object.entries(sizeRatioOverrides).map(([styleNo, months]) => {
                      const styleInfo = setStylesData.find(s => s.style_no === styleNo);
                      return (
                        <div key={styleNo} className="bg-white rounded-md p-2 border border-slate-200">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium">{styleNo} - {styleInfo?.style_name || 'Unknown'}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setSizeRatioOverrides(prev => {
                                  const next = { ...prev };
                                  delete next[styleNo];
                                  return next;
                                });
                              }}
                              className="text-xs text-red-500 hover:underline"
                            >
                              Remove
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {monthOptions.slice(0, 24).map(opt => {
                              const isSelected = months.includes(opt.value);
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setSizeRatioOverrides(prev => {
                                      const current = prev[styleNo] || [];
                                      const newMonths = isSelected
                                        ? current.filter(m => m !== opt.value)
                                        : [...current, opt.value].sort();
                                      return { ...prev, [styleNo]: newMonths };
                                    });
                                  }}
                                  className={`px-2 py-0.5 rounded text-[10px] transition-all ${
                                    isSelected
                                      ? 'bg-[#8FA894] text-white'
                                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                          {months.length === 0 && (
                            <p className="text-[10px] text-amber-600 mt-1">Select at least one month</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Style/Color Selection */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-slate-700">
                Select Styles & Colors ({selections.length} selected)
              </h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // Select all colors from set
                    const allSelections: Selection[] = [];
                    setColorsData.forEach(c => {
                      const style_no = styleIdToNo.get(c.style_id);
                      if (style_no && c.include) {
                        allSelections.push({ style_no, color: c.style_colors.color });
                      }
                    });
                    setSelections(allSelections);
                  }}
                  className="text-xs text-[#8FA894] hover:underline"
                >
                  Select All
                </button>
                <span className="text-slate-300">|</span>
                <button
                  type="button"
                  onClick={() => setSelections([])}
                  className="text-xs text-slate-500 hover:underline"
                >
                  Clear All
                </button>
              </div>
            </div>
            
            <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2">
              {setStylesData.map((style) => {
                const styleColors = setColorsData
                  .filter(c => styleIdToNo.get(c.style_id) === style.style_no && c.include)
                  .map(c => c.style_colors.color);
                
                const selectedColorsForStyle = selections.filter(s => s.style_no === style.style_no);
                const allColorsSelected = styleColors.length > 0 && selectedColorsForStyle.length === styleColors.length;
                const someColorsSelected = selectedColorsForStyle.length > 0 && selectedColorsForStyle.length < styleColors.length;
                
                return (
              <div
                key={style.id}
                    className={`border rounded-lg p-3 transition-colors ${
                      selectedColorsForStyle.length > 0 
                        ? 'border-[#8FA894] bg-[#F5F3F0]/50' 
                        : 'border-slate-200 bg-white'
                    }`}
              >
                <div className="flex items-start gap-3">
                      {/* Style checkbox */}
                      <input
                        type="checkbox"
                        checked={allColorsSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someColorsSelected;
                        }}
                        onChange={(e) => {
                          if (e.target.checked) {
                            // Select all colors for this style
                            const newSelections = selections.filter(s => s.style_no !== style.style_no);
                            styleColors.forEach(color => {
                              newSelections.push({ style_no: style.style_no, color });
                            });
                            setSelections(newSelections);
                          } else {
                            // Deselect all colors for this style
                            setSelections(selections.filter(s => s.style_no !== style.style_no));
                          }
                        }}
                        className="mt-1 h-4 w-4 rounded border-slate-300 text-[#8FA894] focus:ring-[#8FA894]"
                      />
                      
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
                        
                        {/* Color checkboxes */}
                        <div className="flex flex-wrap gap-2 mt-2">
                          {styleColors.map(color => {
                            const isSelected = selections.some(
                              s => s.style_no === style.style_no && s.color === color
                            );
                            return (
                              <button
                                key={color}
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (isSelected) {
                                    setSelections(selections.filter(
                                      s => !(s.style_no === style.style_no && s.color === color)
                                    ));
                                  } else {
                                    setSelections([...selections, { style_no: style.style_no, color }]);
                                  }
                                }}
                                className={`px-2 py-1 rounded-full text-xs cursor-pointer transition-colors ${
                                  isSelected
                                    ? 'bg-[#8FA894] text-white'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                }`}
                              >
                                {color}
                              </button>
                            );
                          })}
                  </div>
                </div>
              </div>
                  </div>
                );
              })}
            </div>
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
  loading,
  result,
  orderEdits,
  setOrderEdits,
  onBack,
  onContinue,
  onRerunAnalysis
}: {
  selections: Selection[];
  selectedMonths: string[];
  loading: boolean;
  result: FullAnalysisResult | null;
  orderEdits: Record<string, number[]>;
  setOrderEdits: React.Dispatch<React.SetStateAction<Record<string, number[]>>>;
  onBack: () => void;
  onContinue: () => void;
  onRerunAnalysis: () => void;
}) {
  // Expanded styles for accordion
  const [expandedStyles, setExpandedStyles] = React.useState<Set<string>>(new Set());
  
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
      
      // Auto-expand styles with critical/low status
      const criticalStyles = new Set<string>();
      result.items.forEach(item => {
        if (item.status === 'critical' || item.status === 'low') {
          criticalStyles.add(item.style_no);
        }
      });
      setExpandedStyles(criticalStyles);
    }
  }, [result, setOrderEdits]);

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

  // Group items by style
  const styleGroups = React.useMemo(() => {
    if (!result?.items) return [];
    
    const groups = new Map<string, {
      style_no: string;
      style_name: string;
      colors: FullAnalysisItem[];
      totalHistorical: number;
      totalStock: number;
      totalOrder: number;
      worstStatus: 'critical' | 'low' | 'ok' | 'surplus';
    }>();
    
    result.items.forEach(item => {
      if (!groups.has(item.style_no)) {
        groups.set(item.style_no, {
          style_no: item.style_no,
          style_name: item.style_name,
          colors: [],
          totalHistorical: 0,
          totalStock: 0,
          totalOrder: 0,
          worstStatus: 'surplus'
        });
      }
      
      const group = groups.get(item.style_no)!;
      group.colors.push(item);
      group.totalHistorical += item.totalHistorical;
      group.totalStock += item.totalNetStock;
      
      // Calculate order total from edits
      const key = `${item.style_no}|${item.color}`;
      const editedValues = orderEdits[key] || item.suggestedOrderBySize || [];
      group.totalOrder += editedValues.reduce((a, b) => a + b, 0);
      
      // Track worst status
      const statusOrder = { critical: 0, low: 1, ok: 2, surplus: 3 };
      if (statusOrder[item.status] < statusOrder[group.worstStatus]) {
        group.worstStatus = item.status;
      }
    });
    
    // Sort by worst status, then by order amount
    return Array.from(groups.values()).sort((a, b) => {
      const statusOrder = { critical: 0, low: 1, ok: 2, surplus: 3 };
      if (statusOrder[a.worstStatus] !== statusOrder[b.worstStatus]) {
        return statusOrder[a.worstStatus] - statusOrder[b.worstStatus];
      }
      return b.totalOrder - a.totalOrder;
    });
  }, [result, orderEdits]);

  const toggleStyle = (styleNo: string) => {
    setExpandedStyles(prev => {
      const next = new Set(prev);
      if (next.has(styleNo)) {
        next.delete(styleNo);
      } else {
        next.add(styleNo);
      }
      return next;
    });
  };

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

  const { summary, dateRange, promptVersion } = result;

  // Calculate totals for Call Home vs New Order
  const totalCallHome = React.useMemo(() => {
    return result.items.reduce((sum, item) => sum + (item.bellRainCallHome || 0), 0);
  }, [result.items]);

  const totalNewOrder = React.useMemo(() => {
    return result.items.reduce((sum, item) => sum + (item.newOrderNeeded || 0), 0);
  }, [result.items]);

  return (
    <div className="space-y-4">
      {/* Summary Card */}
      <Card className="border-[#C5D5CA] bg-gradient-to-r from-[#F5F3F0] to-white">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                🤖 AI Analysis Complete
              </CardTitle>
              <CardDescription>
                Based on {dateRange.display} historical data · {selectedMonths.length} month{selectedMonths.length !== 1 ? 's' : ''} analyzed
              </CardDescription>
            </div>
            <Badge className="bg-slate-200 text-slate-600 text-[10px]">
              Prompt {promptVersion || 'v1'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {/* Status overview */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
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
            <div className="text-center p-3 bg-slate-50 rounded-lg border border-slate-200">
              <div className="text-2xl font-bold text-slate-600">{styleGroups.length}</div>
              <div className="text-xs text-slate-500">Styles</div>
            </div>
          </div>
          
          {/* Call Home vs New Order breakdown */}
          <div className="grid grid-cols-3 gap-3 mb-4 p-4 bg-white rounded-lg border-2 border-[#8FA894]">
            <div className="text-center">
              <div className="text-xs text-slate-500 mb-1">🔔 Call Home</div>
              <div className="text-2xl font-bold text-purple-600">{totalCallHome}</div>
              <div className="text-[10px] text-purple-500">from Bell Rain</div>
            </div>
            <div className="text-center border-x border-slate-200">
              <div className="text-xs text-slate-500 mb-1">📦 Order New</div>
              <div className="text-2xl font-bold text-[#8FA894]">{totalNewOrder}</div>
              <div className="text-[10px] text-slate-400">fresh order</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-slate-500 mb-1">📊 Total</div>
              <div className="text-2xl font-bold text-slate-800">{totalUnits}</div>
              <div className="text-[10px] text-slate-400">units needed</div>
            </div>
          </div>
          
          {summary.aiSummary && (
            <div className="bg-white p-4 rounded-lg border text-sm text-slate-700 whitespace-pre-wrap">
              <div className="font-medium text-slate-800 mb-1">AI Recommendation:</div>
              {summary.aiSummary}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Order Details - Grouped by Style */}
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Order Proposal by Style</CardTitle>
          <CardDescription>
            Click on a style to expand and adjust quantities per color.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {styleGroups.map((group) => {
              const isExpanded = expandedStyles.has(group.style_no);
              const statusColors = {
                critical: 'border-red-400 bg-red-50',
                low: 'border-amber-400 bg-amber-50',
                ok: 'border-green-400 bg-green-50',
                surplus: 'border-blue-400 bg-blue-50'
              };
              
              return (
                <div key={group.style_no} className={`rounded-lg border-2 ${statusColors[group.worstStatus]} overflow-hidden`}>
                  {/* Style Header - Clickable */}
                  <button
                    type="button"
                    onClick={() => toggleStyle(group.style_no)}
                    className="w-full p-4 flex items-center justify-between text-left hover:bg-white/50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold ${
                        group.worstStatus === 'critical' ? 'bg-red-600' :
                        group.worstStatus === 'low' ? 'bg-amber-500' :
                        group.worstStatus === 'ok' ? 'bg-green-600' : 'bg-blue-500'
                      }`}>
                        {group.colors.length}
                      </div>
                      <div>
                        <div className="font-semibold text-slate-900">{group.style_name || group.style_no}</div>
                        <div className="text-xs text-slate-500">{group.style_no} · {group.colors.length} color{group.colors.length !== 1 ? 's' : ''}</div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-6">
                      {/* Historical Timeline Mini-Chart */}
                      <div className="hidden md:flex items-end gap-0.5 h-8">
                        {group.colors[0]?.historical.map((val, i) => {
                          const firstColor = group.colors[0];
                          if (!firstColor) return null;
                          // Aggregate historical across all colors for this style
                          const totalForSize = group.colors.reduce((sum, c) => sum + (c.historical[i] ?? 0), 0);
                          const maxHist = Math.max(...firstColor.historical.map((_, idx) => 
                            group.colors.reduce((sum, c) => sum + (c.historical[idx] ?? 0), 0)
                          ), 1);
                          const height = Math.max(4, (totalForSize / maxHist) * 28);
                          return (
                            <div
                              key={i}
                              className="w-3 bg-[#8FA894] rounded-t opacity-70"
                              style={{ height: `${height}px` }}
                              title={`Size ${firstColor.sizes[i] || i}: ${totalForSize} sold`}
                            />
                          );
                        })}
                      </div>
                      
                      <div className="text-right min-w-[80px]">
                        <div className="text-lg font-bold text-[#8FA894]">{group.totalOrder}</div>
                        <div className="text-[10px] text-slate-500">to order</div>
                      </div>
                      
                      <div className={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                        <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </button>
                  
                  {/* Expanded Colors */}
                  {isExpanded && (
                    <div className="border-t bg-white/80 p-4 space-y-4">
                      {/* Historical Timeline Chart */}
                      <div className="bg-slate-50 rounded-lg p-4">
                        <div className="text-xs font-medium text-slate-600 mb-2">Historical Sales by Size</div>
                        <div className="flex items-end justify-between gap-1 h-16">
                          {group.colors[0]?.sizes.map((size, i) => {
                            const firstColor = group.colors[0];
                            if (!firstColor) return null;
                            const totalForSize = group.colors.reduce((sum, c) => sum + (c.historical[i] ?? 0), 0);
                            const maxHist = Math.max(...firstColor.sizes.map((_, idx) => 
                              group.colors.reduce((sum, c) => sum + (c.historical[idx] ?? 0), 0)
                            ), 1);
                            const height = Math.max(8, (totalForSize / maxHist) * 56);
                            return (
                              <div key={size} className="flex-1 flex flex-col items-center">
                                <div 
                                  className="w-full max-w-[40px] bg-gradient-to-t from-[#8FA894] to-[#C5D5CA] rounded-t"
                                  style={{ height: `${height}px` }}
                                />
                                <div className="text-[10px] text-slate-500 mt-1">{size}</div>
                                <div className="text-[9px] font-medium text-slate-700">{totalForSize}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      
                      {/* Colors */}
                      {group.colors.map((item) => {
                        const key = `${item.style_no}|${item.color}`;
                        const editedValues = orderEdits[key] || item.suggestedOrderBySize || [];
                        const editedTotal = editedValues.reduce((a, b) => a + b, 0);
                        const bellRainAvail = item.totalBellRainAvailable || 0;
                        const bellRainCallHome = item.bellRainCallHome || 0;
                        const newOrderNeeded = item.newOrderNeeded || 0;
                        const onOrder = item.totalPurchaseRunning || 0;
                        
                        return (
                          <div 
                            key={key}
                            className={`p-3 rounded-lg border ${
                              item.status === 'critical' ? 'border-red-200 bg-red-50/50' :
                              item.status === 'low' ? 'border-amber-200 bg-amber-50/50' :
                              item.status === 'ok' ? 'border-green-200 bg-green-50/50' :
                              'border-slate-200 bg-slate-50/50'
                            }`}
                          >
                            {/* Header with key metrics */}
                            <div className="flex items-start justify-between mb-3">
                              <div>
                                <div className="flex items-center gap-2 mb-1">
                                  <Badge className={
                                    item.status === 'critical' ? 'bg-red-600 text-white' :
                                    item.status === 'low' ? 'bg-amber-500 text-white' :
                                    item.status === 'ok' ? 'bg-green-600 text-white' :
                                    'bg-blue-500 text-white'
                                  }>
                                    {item.color}
                                  </Badge>
                                </div>
                                <div className="text-[10px] text-slate-500 space-y-0.5">
                                  <div>📊 Target (Historical): <strong>{item.totalHistorical}</strong></div>
                                  <div>📦 Current Stock: {item.totalNetStock} | On Order: {onOrder}</div>
                                </div>
                              </div>
                              
                              {/* Action breakdown */}
                              <div className="text-right space-y-1">
                                {bellRainAvail > 0 && (
                                  <div className="flex items-center gap-2 text-[10px]">
                                    <span className="text-purple-600">🔔 Call Home:</span>
                                    <span className="font-bold text-purple-700">{bellRainCallHome}</span>
                                    <span className="text-slate-400">/ {bellRainAvail} avail</span>
                                  </div>
                                )}
                                <div className="flex items-center gap-2 text-[10px]">
                                  <span className="text-[#8FA894]">📦 Order New:</span>
                                  <span className="font-bold text-[#8FA894]">{newOrderNeeded}</span>
                                </div>
                              </div>
                            </div>
                            
                            {/* Size grid - Order quantities */}
                            <div className="bg-white rounded-lg p-2 border">
                              <div className="text-[9px] text-slate-500 mb-1 font-medium">Order by Size:</div>
                              <div className="grid grid-cols-7 gap-1">
                                {item.sizes.map((size, sizeIdx) => {
                                  const bellRainForSize = item.bellRainCallHomeBySize?.[sizeIdx] ?? 0;
                                  const newForSize = item.newOrderNeededBySize?.[sizeIdx] ?? 0;
                                  
                                  return (
                                    <div key={size} className="text-center">
                                      <div className="text-[8px] text-slate-400 font-medium">{size}</div>
                                      <Input
                                        type="number"
                                        min={0}
                                        value={editedValues[sizeIdx] ?? 0}
                                        onChange={(e) => updateOrderValue(item.style_no, item.color, sizeIdx, parseInt(e.target.value) || 0)}
                                        className="h-6 text-center text-[10px] p-0.5"
                                      />
                                      <div className="text-[7px] text-slate-400 leading-tight">
                                        <div>hist: {item.historical[sizeIdx] ?? 0}</div>
                                        {bellRainForSize > 0 && (
                                          <div className="text-purple-500">🔔{bellRainForSize}</div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                            
                            {/* Summary footer */}
                            <div className="flex justify-between items-center mt-2 pt-2 border-t border-slate-200">
                              <div className="text-[10px] text-slate-500">
                                Gap: {item.suggestedOrder} | 🔔 {bellRainCallHome} + 📦 {newOrderNeeded}
                              </div>
                              <div className="text-sm font-semibold text-[#8FA894]">
                                Total: {editedTotal}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
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

// ==================== STEP 3: Final Review & Push to PO ====================
function Step3FinalReview({
  selections,
  orderEdits,
  analysisResult,
  onBack,
  onReset
}: {
  selections: Selection[];
  orderEdits: Record<string, number[]>;
  analysisResult: FullAnalysisResult | null;
  onBack: () => void;
  onReset: () => void;
}) {
  const router = useRouter();
  const [finalizing, setFinalizing] = React.useState(false);

  // Build order items from orderEdits
  const orderItems = React.useMemo(() => {
    const items: Array<{
      style_no: string;
      style_name: string;
      color: string;
      sizes: string[];
      quantities: number[];
      total: number;
      bellRainCallHome?: number[];
    }> = [];

    // Get style info from analysis result
    const itemMap = new Map<string, any>();
    analysisResult?.items?.forEach(item => {
      itemMap.set(`${item.style_no}|${item.color}`, item);
    });

    Object.entries(orderEdits).forEach(([key, quantities]) => {
      const total = quantities.reduce((a, b) => a + b, 0);
      if (total > 0) {
        const [style_no, color] = key.split('|');
        const analysisItem = itemMap.get(key);
        items.push({
          style_no: style_no || '',
          style_name: analysisItem?.style_name || style_no || '',
          color: color || '',
          sizes: analysisItem?.sizes || [],
          quantities,
          total,
          bellRainCallHome: analysisItem?.bellRainCallHomeBySize
        });
      }
    });

    return items.sort((a, b) => b.total - a.total);
  }, [orderEdits, analysisResult]);

  const grandTotal = orderItems.reduce((sum, item) => sum + item.total, 0);
  const bellRainTotal = orderItems.reduce((sum, item) => {
    return sum + (item.bellRainCallHome?.reduce((a, b) => a + b, 0) || 0);
  }, 0);

  async function handleFinalizeOrder() {
    if (orderItems.length === 0) return;
    
    setFinalizing(true);
    try {
      const now = new Date();
      const poNo = `NOOS-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      
      const orderData = {
        po_no: poNo,
        status: 'Running',
        styles: orderItems.length,
        ordered: grandTotal,
        shipped: 0,
        meta: {
          items: orderItems.map(item => ({
            style_no: item.style_no,
            style_name: item.style_name,
            color: item.color,
            sizes: item.sizes,
            quantities: item.quantities,
            total: item.total,
            bellRainCallHome: item.bellRainCallHome
          })),
          created_from: 'call-off',
          type: 'noos',
          created_at: now.toISOString(),
          bellRainTotal
        }
      };

      const { data, error } = await supabase
        .from('app_pos')
        .insert(orderData)
        .select()
        .single();

      if (error) throw error;

      // Clear state and redirect
      onReset();
      router.push(`/purchase/app-pos/${data.id}`);
    } catch (error: any) {
      console.error('Failed to finalize order:', error);
      alert('Failed to create purchase order: ' + (error.message || 'Unknown error'));
    } finally {
      setFinalizing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-[#C5D5CA]">
        <CardHeader>
          <CardTitle>Step 3: Review & Push to APP PO's</CardTitle>
          <CardDescription>
            Review your NOOS Call Off order before finalizing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Summary */}
          <div className="flex items-center gap-6 p-4 bg-[#F5F3F0] rounded-lg">
            <div>
              <div className="text-3xl font-bold text-[#8FA894]">{grandTotal}</div>
              <div className="text-xs text-slate-500">Total Units</div>
            </div>
            <div>
              <div className="text-2xl font-semibold text-slate-700">{orderItems.length}</div>
              <div className="text-xs text-slate-500">Style/Colors</div>
            </div>
            {bellRainTotal > 0 && (
              <div>
                <div className="text-2xl font-semibold text-purple-600">{bellRainTotal}</div>
                <div className="text-xs text-purple-500">🔔 Call Home</div>
              </div>
            )}
          </div>

          {orderItems.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <p className="mb-2">No items with quantities entered.</p>
              <Button variant="outline" onClick={onBack}>
                Go back to adjust quantities
              </Button>
            </div>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {orderItems.map((item, idx) => {
                const hasBellRain = (item.bellRainCallHome?.reduce((a, b) => a + b, 0) || 0) > 0;
                
                return (
                  <div key={idx} className="flex items-center justify-between p-3 border rounded-lg border-[#C5D5CA]">
                    <div className="flex-1">
                      <div className="font-semibold text-sm">
                        {item.style_name}
                      </div>
                      <div className="text-xs text-slate-500">
                        {item.style_no} · {item.color}
                      </div>
                      {hasBellRain && (
                        <Badge className="mt-1 bg-purple-100 text-purple-700 text-[10px]">
                          🔔 Bell Rain
                        </Badge>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-slate-500">
                        {item.sizes
                          .map((s, i) => {
                            const qty = item.quantities[i] ?? 0;
                            return qty > 0 ? `${s}:${qty}` : null;
                          })
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                      <div className="text-lg font-bold text-[#8FA894]">{item.total}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-4 border-t">
            <Button variant="outline" onClick={onBack}>
              Back to Edit
            </Button>
            <Button
              onClick={handleFinalizeOrder}
              disabled={orderItems.length === 0 || finalizing}
              className="bg-[#8FA894] hover:bg-[#C5D5CA]"
            >
              {finalizing ? 'Creating PO...' : `🚀 Push to APP PO's (${grandTotal} units)`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== OLD STEP 3: Enter Quantities (deprecated) ====================
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
