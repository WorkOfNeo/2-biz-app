'use client';
import React from 'react';
import useSWR, { mutate } from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Table, TableBody, TableRow, TableCell, TableHead, TableHeader } from '../../../components/ui/table';
import { Badge } from '../../../components/ui/badge';
import { EmailPillsInput } from '../../../components/EmailPillsInput';
import { Sheet, SheetHeader, SheetTitle, SheetContent, SheetClose } from '../../../components/ui/sheet';
import { Plus, Pencil, Trash2, Send, Clock, Calendar, Eye, X } from 'lucide-react';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';
const EMAILJS_SERVICE_ID = process.env.NEXT_PUBLIC_EMAILJS_SERVICE_ID || process.env.NEXT_PUBLIC_EMAILJS_SERVICE_KEY || '';
const EMAILJS_TEMPLATE_ID = process.env.NEXT_PUBLIC_EMAILJS_TEMPLATE_ID || '';
const EMAILJS_PUBLIC_KEY = process.env.NEXT_PUBLIC_EMAILJS_PUBLIC_KEY || '';
const EMAILJS_FROM_NAME = process.env.NEXT_PUBLIC_EMAILJS_FROM_NAME || '2-BIZ';
const EMAILJS_FROM_EMAIL = process.env.NEXT_PUBLIC_EMAILJS_FROM_EMAIL || '';

const DAYS_OF_WEEK = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

interface StockListSchedule {
  id: string;
  name: string;
  stockLists: string[];
  recipients: string[];
  scheduleType: 'daily' | 'weekly';
  time: string;
  days: number[];
  emailBody: string;
  enabled: boolean;
  lastRun?: string;
}

interface StatisticSchedule {
  id: string;
  name: string;
  salespersonIds: string[]; // which salespersons to include (receive their personal PDF)
  additionalRecipients: string[]; // extra emails not in salespersons list
  // Which files to include
  includeGeneralCombined: boolean;
  includeCountries: boolean;
  includeTop15Salesmen: boolean;
  includeTop15Overall: boolean;
  includeOverview: boolean;
  stockLists: string[]; // optional stock lists to attach
  scheduleType: 'daily' | 'weekly';
  time: string;
  days: number[];
  emailBody: string;
  enabled: boolean;
  lastRun?: string;
}


/** Parse receivers from legacy stored string (supports comma, semicolon, whitespace) */
function parseReceivers(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s\n]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function formatSchedule(schedule: StockListSchedule | StatisticSchedule): string {
  if (schedule.scheduleType === 'daily') {
    return `Daily at ${schedule.time}`;
  }
  const dayLabels = schedule.days
    .sort((a, b) => a - b)
    .map(d => DAYS_OF_WEEK.find(day => day.value === d)?.label || '')
    .filter(Boolean);
  return `${dayLabels.join(', ')} at ${schedule.time}`;
}

function formatLastRun(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return `Opdateret kl. ${hh}:${mm}`;
  // Show date for older runs
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  return `Opdateret ${day}/${month} kl. ${hh}:${mm}`;
}

export default function StatisticsDashboardPage() {
  const { data: salespersons } = useSWR('salespersons:list', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name, email, currency').order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string; email?: string | null; currency?: string | null }>;
  });

  const { data: latestExports } = useSWR('exports:latest', async () => {
    const { data, error } = await supabase
      .from('exports')
      .select('id, kind, title, path, public_url, meta, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  }, { refreshInterval: 10000 });

  const latestByKind = React.useMemo(() => {
    const map = new Map<string, any>();
    for (const row of (latestExports ?? [])) { if (!map.has(row.kind)) map.set(row.kind, row); }
    return map;
  }, [latestExports]);

  const latestStockListByName = React.useMemo(() => {
    const map = new Map<string, any>();
    for (const row of (latestExports ?? [])) {
      if (row.kind === 'stock_list_pdf') {
        const name = String(row?.meta?.list || row?.title || '').replace(/^Stock List ·\s*/i, '');
        if (name && !map.has(name)) map.set(name, row);
      }
    }
    return map;
  }, [latestExports]);

  const { data: stockListsAll } = useSWR('stock-lists:names', async () => {
    const { data, error } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string }>
  });

  // Only show stock lists that have exports
  const availableStockLists = React.useMemo(() => {
    return (stockListsAll ?? []).filter(l => latestStockListByName.has(l.name));
  }, [stockListsAll, latestStockListByName]);

  const [selectedStockListsSalesmen, setSelectedStockListsSalesmen] = React.useState<Set<string>>(new Set());
  const [selectedStockListsOverall, setSelectedStockListsOverall] = React.useState<Set<string>>(new Set());
  
  function toggleStockListSalesmen(name: string) {
    setSelectedStockListsSalesmen((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  }
  
  function toggleStockListOverall(name: string) {
    setSelectedStockListsOverall((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  }
  
  // Stock List Schedules
  const [schedules, setSchedules] = React.useState<StockListSchedule[]>([]);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [editingSchedule, setEditingSchedule] = React.useState<StockListSchedule | null>(null);
  const [viewingSchedule, setViewingSchedule] = React.useState<StockListSchedule | null>(null);
  const [viewSheetOpen, setViewSheetOpen] = React.useState(false);
  const [savingSchedules, setSavingSchedules] = React.useState(false);
  const [sendingScheduleId, setSendingScheduleId] = React.useState<string | null>(null);

  // Form state for schedule editor
  const [formName, setFormName] = React.useState('');
  const [formStockLists, setFormStockLists] = React.useState<Set<string>>(new Set());
  const [formRecipients, setFormRecipients] = React.useState<string[]>([]);
  const [formScheduleType, setFormScheduleType] = React.useState<'daily' | 'weekly'>('weekly');
  const [formTime, setFormTime] = React.useState('09:00');
  const [formDays, setFormDays] = React.useState<Set<number>>(new Set([1])); // Monday default
  const [formEmailBody, setFormEmailBody] = React.useState('Hermed lagerliste :)');
  const [formEnabled, setFormEnabled] = React.useState(true);

  // Load schedules from app_settings
  useSWR('dashboard:stock_list_schedules', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'stock_list_schedules').maybeSingle();
    const val = ((data?.value as any) || {}) as { schedules?: StockListSchedule[] };
    if (val.schedules) setSchedules(val.schedules);
    return data;
  });

  // Statistic Schedules (renamed from Salesmen Schedules)
  const [statisticSchedules, setStatisticSchedules] = React.useState<StatisticSchedule[]>([]);
  const [statisticSheetOpen, setStatisticSheetOpen] = React.useState(false);
  const [editingStatisticSchedule, setEditingStatisticSchedule] = React.useState<StatisticSchedule | null>(null);
  const [viewingStatisticSchedule, setViewingStatisticSchedule] = React.useState<StatisticSchedule | null>(null);
  const [viewStatisticSheetOpen, setViewStatisticSheetOpen] = React.useState(false);
  const [savingStatisticSchedules, setSavingStatisticSchedules] = React.useState(false);
  const [sendingStatisticScheduleId, setSendingStatisticScheduleId] = React.useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

  // Form state for statistic schedule editor
  const [stFormName, setStFormName] = React.useState('');
  const [stFormSalespersons, setStFormSalespersons] = React.useState<Set<string>>(new Set());
  const [stFormAdditionalRecipients, setStFormAdditionalRecipients] = React.useState<string[]>([]);
  const [stFormIncludeGeneralCombined, setStFormIncludeGeneralCombined] = React.useState(false);
  const [stFormIncludeCountries, setStFormIncludeCountries] = React.useState(true);
  const [stFormIncludeTop15Salesmen, setStFormIncludeTop15Salesmen] = React.useState(true);
  const [stFormIncludeTop15Overall, setStFormIncludeTop15Overall] = React.useState(false);
  const [stFormIncludeOverview, setStFormIncludeOverview] = React.useState(false);
  const [stFormStockLists, setStFormStockLists] = React.useState<Set<string>>(new Set());
  const [stFormScheduleType, setStFormScheduleType] = React.useState<'daily' | 'weekly'>('weekly');
  const [stFormTime, setStFormTime] = React.useState('09:00');
  const [stFormDays, setStFormDays] = React.useState<Set<number>>(new Set([1]));
  const [stFormEmailBody, setStFormEmailBody] = React.useState('Hermed statistik :)');
  const [stFormEnabled, setStFormEnabled] = React.useState(true);

  // Load statistic schedules from app_settings (check both old and new keys for migration)
  useSWR('dashboard:statistic_schedules', async () => {
    // Try new key first, fallback to old key for migration
    let { data } = await supabase.from('app_settings').select('id, value').eq('key', 'statistic_schedules').maybeSingle();
    if (!data) {
      const old = await supabase.from('app_settings').select('id, value').eq('key', 'salesmen_schedules').maybeSingle();
      data = old.data;
    }
    const val = ((data?.value as any) || {}) as { schedules?: StatisticSchedule[] };
    if (val.schedules) {
      // Migrate old schedules to new format
      const migrated = val.schedules.map(s => ({
        ...s,
        additionalRecipients: s.additionalRecipients || [],
        includeGeneralCombined: s.includeGeneralCombined ?? false,
        includeTop15Salesmen: s.includeTop15Salesmen ?? (s as any).includeTop15 ?? true,
        includeTop15Overall: s.includeTop15Overall ?? false,
        includeOverview: s.includeOverview ?? false,
        includeCountries: s.includeCountries ?? true,
      }));
      setStatisticSchedules(migrated);
    }
    return data;
  });

  async function saveStatisticSchedules(newSchedules: StatisticSchedule[]) {
    setSavingStatisticSchedules(true);
    try {
      const value = { schedules: newSchedules };
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'statistic_schedules').maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'statistic_schedules', value } as any);
      setStatisticSchedules(newSchedules);
    } finally {
      setSavingStatisticSchedules(false);
    }
  }

  function openNewStatisticSchedule() {
    setEditingStatisticSchedule(null);
    setStFormName('');
    setStFormSalespersons(new Set());
    setStFormAdditionalRecipients([]);
    setStFormIncludeGeneralCombined(false);
    setStFormIncludeCountries(true);
    setStFormIncludeTop15Salesmen(true);
    setStFormIncludeTop15Overall(false);
    setStFormIncludeOverview(false);
    setStFormStockLists(new Set());
    setStFormScheduleType('weekly');
    setStFormTime('09:00');
    setStFormDays(new Set([1]));
    setStFormEmailBody('Hermed statistik :)');
    setStFormEnabled(true);
    setStatisticSheetOpen(true);
  }

  function openEditStatisticSchedule(schedule: StatisticSchedule) {
    setViewStatisticSheetOpen(false);
    setEditingStatisticSchedule(schedule);
    setStFormName(schedule.name);
    setStFormSalespersons(new Set(schedule.salespersonIds));
    setStFormAdditionalRecipients(schedule.additionalRecipients || []);
    setStFormIncludeGeneralCombined(schedule.includeGeneralCombined ?? false);
    setStFormIncludeCountries(schedule.includeCountries ?? true);
    setStFormIncludeTop15Salesmen(schedule.includeTop15Salesmen ?? true);
    setStFormIncludeTop15Overall(schedule.includeTop15Overall ?? false);
    setStFormIncludeOverview(schedule.includeOverview ?? false);
    setStFormStockLists(new Set(schedule.stockLists || []));
    setStFormScheduleType(schedule.scheduleType);
    setStFormTime(schedule.time);
    setStFormDays(new Set(schedule.days));
    setStFormEmailBody(schedule.emailBody);
    setStFormEnabled(schedule.enabled);
    setStatisticSheetOpen(true);
  }

  function openViewStatisticSchedule(schedule: StatisticSchedule) {
    setViewingStatisticSchedule(schedule);
    setViewStatisticSheetOpen(true);
  }

  function handleSaveStatisticSchedule() {
    if (!stFormName.trim()) {
      alert('Please enter a schedule name');
      return;
    }
    if (stFormSalespersons.size === 0 && stFormAdditionalRecipients.length === 0) {
      alert('Please select at least one salesperson or add at least one recipient email');
      return;
    }
    if (stFormScheduleType === 'weekly' && stFormDays.size === 0) {
      alert('Please select at least one day');
      return;
    }

    const newSchedule: StatisticSchedule = {
      id: editingStatisticSchedule?.id || generateId(),
      name: stFormName.trim(),
      salespersonIds: Array.from(stFormSalespersons),
      additionalRecipients: stFormAdditionalRecipients,
      includeGeneralCombined: stFormIncludeGeneralCombined,
      includeCountries: stFormIncludeCountries,
      includeTop15Salesmen: stFormIncludeTop15Salesmen,
      includeTop15Overall: stFormIncludeTop15Overall,
      includeOverview: stFormIncludeOverview,
      stockLists: Array.from(stFormStockLists),
      scheduleType: stFormScheduleType,
      time: stFormTime,
      days: Array.from(stFormDays),
      emailBody: stFormEmailBody,
      enabled: stFormEnabled,
      lastRun: editingStatisticSchedule?.lastRun,
    };

    let newSchedules: StatisticSchedule[];
    if (editingStatisticSchedule) {
      newSchedules = statisticSchedules.map(s => s.id === editingStatisticSchedule.id ? newSchedule : s);
    } else {
      newSchedules = [...statisticSchedules, newSchedule];
    }

    saveStatisticSchedules(newSchedules);
    setStatisticSheetOpen(false);
  }

  function handleDeleteStatisticSchedule(id: string) {
    if (!confirm('Delete this schedule?')) return;
    const newSchedules = statisticSchedules.filter(s => s.id !== id);
    saveStatisticSchedules(newSchedules);
  }

  function handleToggleStatisticEnabled(id: string) {
    const newSchedules = statisticSchedules.map(s => 
      s.id === id ? { ...s, enabled: !s.enabled } : s
    );
    saveStatisticSchedules(newSchedules);
  }

  async function handleSendStatisticNow(schedule: StatisticSchedule) {
    if (sendingStatisticScheduleId) return;
    setSendingStatisticScheduleId(schedule.id);
    try {
      const spExport = latestByKind.get('general_salesmen_pdfs');
      const top15Salesmen = latestByKind.get('top_styles_pdf_salesmen');
      const top15Overall = latestByKind.get('top_styles_pdf_overall');
      const countries = latestByKind.get('countries_pdf');
      const overview = latestByKind.get('overview_pdf');
      
      const files = (spExport?.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id?: string }>) || [];
      const combinedUrl = spExport?.meta?.all?.publicUrl || null;
      const byId: Record<string, { name: string; email?: string | null }> = Object.fromEntries((salespersons ?? []).map(s => [s.id, { name: s.name, email: s.email }]));
      
      let emailCount = 0;
      
      // Build common template params for files that don't require personal PDF
      const buildCommonParams = (): Record<string, string> => {
        const params: Record<string, string> = {};
        if (schedule.includeGeneralCombined && combinedUrl) params.all_salesmen_pdf_url = combinedUrl;
        if (schedule.includeCountries && countries?.public_url) params.countries_pdf_url = countries.public_url;
        if (schedule.includeTop15Salesmen && top15Salesmen?.public_url) params.top15_salesmen_pdf = top15Salesmen.public_url;
        if (schedule.includeTop15Overall && top15Overall?.public_url) params.top15_overall_pdf = top15Overall.public_url;
        if (schedule.includeOverview && overview?.public_url) params.overview_pdf_url = overview.public_url;
        // Add stock lists
        if (schedule.stockLists?.length > 0) {
          let idx = 1;
          for (const listName of schedule.stockLists) {
            const exp = latestStockListByName.get(listName);
            if (exp?.public_url) {
              params[`stock_list_${idx}_url`] = exp.public_url;
              params[`stock_list_${idx}_name`] = listName;
              idx++;
            }
          }
        }
        return params;
      };

      // Send to salespersons (each gets their personal PDF)
      for (const spId of schedule.salespersonIds) {
        const sp = (salespersons ?? []).find(s => s.id === spId);
        if (!sp) continue;
        
        const my = files.find((f) => f.salesperson_id === spId);
        const recipient = sp.email;
        if (!recipient) continue;
        
        const dynamicParams: Record<string, string> = {
          ...buildCommonParams(),
          salesman_pdf: my?.publicUrl || '',
        };
        
        const fullName = String(byId[spId]?.name || '');
        const toTitleCase = (str: string) => str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        const firstName = fullName ? toTitleCase(fullName).split(' ')[0] : '';
        const hej = firstName ? `Hej ${firstName},` : 'Hej,';
        const bodyHtml = `${hej}\n\n${schedule.emailBody || 'Hermed statistik :)'}`;
        const subject = 'Din statistik';
        
        await sendEmailJs([recipient], subject, bodyHtml, undefined, dynamicParams, false);
        emailCount++;
      }
      
      // Send to additional recipients (they don't get personal PDF, just the selected files)
      for (const recipient of (schedule.additionalRecipients || [])) {
        const dynamicParams = buildCommonParams();
        const bodyHtml = `Hej,\n\n${schedule.emailBody || 'Hermed statistik :)'}`;
        const subject = 'Statistik';
        
        await sendEmailJs([recipient], subject, bodyHtml, undefined, dynamicParams, false);
        emailCount++;
      }
      
      // Update lastRun
      const newSchedules = statisticSchedules.map(s => 
        s.id === schedule.id ? { ...s, lastRun: new Date().toISOString() } : s
      );
      await saveStatisticSchedules(newSchedules);
      
      alert(`${emailCount} email(s) sent`);
    } finally {
      setSendingStatisticScheduleId(null);
    }
  }

  async function saveSchedules(newSchedules: StockListSchedule[]) {
    setSavingSchedules(true);
    try {
      const value = { schedules: newSchedules };
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'stock_list_schedules').maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'stock_list_schedules', value } as any);
      setSchedules(newSchedules);
    } finally {
      setSavingSchedules(false);
    }
  }

  function openNewSchedule() {
    setEditingSchedule(null);
    setFormName('');
    setFormStockLists(new Set());
    setFormRecipients([]);
    setFormScheduleType('weekly');
    setFormTime('09:00');
    setFormDays(new Set([1]));
    setFormEmailBody('Hermed lagerliste :)');
    setFormEnabled(true);
    setSheetOpen(true);
  }

  function openEditSchedule(schedule: StockListSchedule) {
    setViewSheetOpen(false); // Close view sheet if open
    setEditingSchedule(schedule);
    setFormName(schedule.name);
    setFormStockLists(new Set(schedule.stockLists));
    setFormRecipients(schedule.recipients);
    setFormScheduleType(schedule.scheduleType);
    setFormTime(schedule.time);
    setFormDays(new Set(schedule.days));
    setFormEmailBody(schedule.emailBody);
    setFormEnabled(schedule.enabled);
    setSheetOpen(true);
  }

  function openViewSchedule(schedule: StockListSchedule) {
    setViewingSchedule(schedule);
    setViewSheetOpen(true);
  }

  function handleSaveSchedule() {
    if (!formName.trim()) {
      alert('Please enter a schedule name');
      return;
    }
    if (formStockLists.size === 0) {
      alert('Please select at least one stock list');
      return;
    }
    if (formRecipients.length === 0) {
      alert('Please add at least one recipient');
      return;
    }
    if (formScheduleType === 'weekly' && formDays.size === 0) {
      alert('Please select at least one day');
      return;
    }

    const newSchedule: StockListSchedule = {
      id: editingSchedule?.id || generateId(),
      name: formName.trim(),
      stockLists: Array.from(formStockLists),
      recipients: formRecipients,
      scheduleType: formScheduleType,
      time: formTime,
      days: Array.from(formDays),
      emailBody: formEmailBody,
      enabled: formEnabled,
      lastRun: editingSchedule?.lastRun,
    };

    let newSchedules: StockListSchedule[];
    if (editingSchedule) {
      newSchedules = schedules.map(s => s.id === editingSchedule.id ? newSchedule : s);
    } else {
      newSchedules = [...schedules, newSchedule];
    }

    saveSchedules(newSchedules);
    setSheetOpen(false);
  }

  function handleDeleteSchedule(id: string) {
    if (!confirm('Delete this schedule?')) return;
    const newSchedules = schedules.filter(s => s.id !== id);
    saveSchedules(newSchedules);
  }

  function handleToggleEnabled(id: string) {
    const newSchedules = schedules.map(s => 
      s.id === id ? { ...s, enabled: !s.enabled } : s
    );
    saveSchedules(newSchedules);
  }

  async function handleSendNow(schedule: StockListSchedule) {
    if (sendingScheduleId) return;
    setSendingScheduleId(schedule.id);
    try {
      const bodyHtml = schedule.emailBody || 'Hermed lagerliste :)';
      let emailCount = 0;
      
      // Send one email per recipient per stock list (same as cron)
      for (const listName of schedule.stockLists) {
        const exp = latestStockListByName.get(listName);
        if (!exp?.public_url) continue;
        
        const subject = `${listName} - Lagerliste`;
        const filename = `${listName} - Lagerliste.pdf`;
        
        for (const recipient of schedule.recipients) {
          const dynamicParams: Record<string, string> = {
            stock_list_1_url: exp.public_url,
            stock_list_1_name: listName,
            stock_list_1_filename: filename,
          };
          
          await sendEmailJs([recipient], subject, bodyHtml, undefined, dynamicParams, false);
          emailCount++;
        }
      }
      
      // Update lastRun
      const newSchedules = schedules.map(s => 
        s.id === schedule.id ? { ...s, lastRun: new Date().toISOString() } : s
      );
      await saveSchedules(newSchedules);
      
      alert(`${emailCount} email(s) sent to ${schedule.recipients.length} recipient(s)`);
    } finally {
      setSendingScheduleId(null);
    }
  }

  // Errors: Missing DG for Top 10 (current season)
  const { data: currentSeason } = useSWR('season:current', async () => {
    const { data } = await supabase.from('seasons').select('id, name, year, is_current').eq('is_current', true).maybeSingle();
    return (data as any) || null;
  });
  const { data: top10Current } = useSWR(currentSeason ? ['top10:current', currentSeason.id] : null, async () => {
    const { data, error } = await supabase.from('top_styles').select('style_no, dg, qty').eq('season_id', currentSeason.id).order('qty', { ascending: false }).limit(15);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ style_no: string; dg?: string | null; qty: number }>;
  });
  const { data: stylesForTop } = useSWR(top10Current && top10Current.length ? ['styles:forTop10', top10Current.map(r=>r.style_no).join(',')] : null, async () => {
    const nos = (top10Current ?? []).map(r => r.style_no);
    const { data, error } = await supabase.from('styles').select('style_no, dg, style_name').in('style_no', nos);
    if (error) throw new Error(error.message);
    const map = new Map<string, { dg: string | null; name: string | null }>();
    for (const r of (data ?? []) as any[]) map.set(r.style_no, { dg: r.dg ?? null, name: r.style_name ?? null });
    return map;
  });
  const missingDgList = React.useMemo(() => {
    const out: Array<{ style_no: string; name: string | null }> = [];
    for (const r of (top10Current ?? [])) {
      const dgTop = (r as any).dg as string | null | undefined;
      const fromStyle = stylesForTop?.get(r.style_no);
      const dgStyle = fromStyle?.dg ?? null;
      const val = (dgTop || dgStyle || '').toString().trim();
      if (!val) out.push({ style_no: r.style_no, name: fromStyle?.name ?? null });
    }
    return out;
  }, [top10Current?.length, stylesForTop]);

  // Box #1 - Salesperson Statistics
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [includeCountries, setIncludeCountries] = React.useState(true);
  const [includeTop15Salesmen, setIncludeTop15Salesmen] = React.useState(true);
  
  React.useEffect(() => {
    if (salespersons && salespersons.length > 0 && Object.keys(selected).length === 0) {
      const allSelected: Record<string, boolean> = {};
      for (const sp of salespersons) {
        allSelected[sp.id] = true;
      }
      setSelected(allSelected);
    }
  }, [salespersons, selected]);
  const [sendingSp, setSendingSp] = React.useState(false);
  const [salesmenBodyText, setSalesmenBodyText] = React.useState('Hermed statistik :)');
  const [savingSalesmenPrefs, setSavingSalesmenPrefs] = React.useState(false);

  useSWR('dashboard:salesmen_email', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'dashboard_salesmen_email').maybeSingle();
    const val = ((data?.value as any) || {}) as { body?: string };
    if (val.body !== undefined) setSalesmenBodyText(val.body);
    return data;
  });

  async function saveSalesmenPrefs() {
    setSavingSalesmenPrefs(true);
    try {
      const value = { body: salesmenBodyText };
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'dashboard_salesmen_email').maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'dashboard_salesmen_email', value } as any);
    } finally {
      setSavingSalesmenPrefs(false);
    }
  }

  function toggleSp(id: string) {
    setSelected((p) => ({ ...p, [id]: !p[id] }));
  }

  async function sendSalespersonEmails() {
    if (sendingSp) return;
    setSendingSp(true);
    try {
      const spExport = latestByKind.get('general_salesmen_pdfs');
      const top15Salesmen = latestByKind.get('top_styles_pdf_salesmen');
      const stockListRows = (latestExports ?? []).filter((r: any) => r.kind === 'stock_list_pdf');
      const seenLists = new Set<string>();
      const latestStockLists: Array<any> = [];
      for (const r of stockListRows) {
        const listName = String(r?.meta?.list || '');
        if (!listName || seenLists.has(listName)) continue;
        seenLists.add(listName);
        latestStockLists.push(r);
      }
      if (!spExport) { alert('No salesperson PDFs found. Please run exports first.'); return; }
      const files = (spExport.meta?.files as Array<{ name: string; path: string; publicUrl?: string | null; salesperson_id?: string }>) || [];
      const chosen = (salespersons ?? []).filter((s) => selected[s.id]);
      if (chosen.length === 0) { alert('Select at least one salesperson.'); return; }

      const byId: Record<string, { name: string; email?: string | null }> = Object.fromEntries((salespersons ?? []).map(s => [s.id, { name: s.name, email: s.email }]));
      const countries = includeCountries ? latestByKind.get('countries_pdf') : null;
      for (const sp of chosen) {
        const my = files.find((f) => f.salesperson_id === sp.id);
        if (!my || !my.publicUrl) continue;
        const recipient = byId[sp.id]?.email || '';
        if (!recipient) continue;
        const dynamicParams: Record<string, string> = {
          salesman_pdf: '',
          countries_pdf_url: '',
          top15_salesmen_pdf: ''
        };
        dynamicParams.salesman_pdf = my.publicUrl || '';
        if (includeCountries && countries?.public_url) {
          dynamicParams.countries_pdf_url = countries.public_url;
        }
        if (includeTop15Salesmen && top15Salesmen?.public_url) {
          dynamicParams.top15_salesmen_pdf = top15Salesmen.public_url;
        }
        if (selectedStockListsSalesmen.size > 0) {
          let idx = 1;
          for (const name of Array.from(selectedStockListsSalesmen)) {
            const exp = latestStockListByName.get(name);
            if (exp?.public_url) {
              dynamicParams[`stock_list_${idx}_url`] = exp.public_url;
              dynamicParams[`stock_list_${idx}_name`] = name;
              idx++;
            }
          }
        }
        try {
          const summarize = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { len: (v || '').length, head: (v || '').slice(0, 32) }]));
          console.log('[email:salesperson] prepared: using template params', {
            recipient,
            includeCountries: !!(includeCountries && countries?.public_url),
            includeTop15Salesmen: !!(includeTop15Salesmen && top15Salesmen?.public_url),
            params: summarize(dynamicParams)
          });
        } catch {}
        const hasStockLists = Object.keys(dynamicParams).some(k => k.startsWith('stock_list_') && k.endsWith('_url'));
        const anyParam =
          Boolean(dynamicParams.salesman_pdf) ||
          Boolean(dynamicParams.countries_pdf_url) ||
          Boolean(dynamicParams.top15_salesmen_pdf) ||
          hasStockLists;
        if (!anyParam) continue;
        const subject = 'Din statistik';
        const fullName = String(byId[sp.id]?.name || '');
        const toTitleCase = (str: string) => {
          return str.toLowerCase().split(' ').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1)
          ).join(' ');
        };
        const firstName = fullName ? toTitleCase(fullName).split(' ')[0] : '';
        const hej = firstName ? `Hej ${firstName},` : 'Hej,';
        const bodyHtml = `${hej}\n\n${salesmenBodyText || 'Hermed statistik :)'}`;
        await sendEmailJs([recipient], subject, bodyHtml, undefined, dynamicParams);
      }
      alert('Emails queued for sending.');
    } finally {
      setSendingSp(false);
    }
  }

  // Box #2 - Overall Statistics (receivers now an array)
  const [receivers, setReceivers] = React.useState<string[]>([]);
  const [bodyText, setBodyText] = React.useState('Hermed statistik :)');
  const [overallOpts, setOverallOpts] = React.useState<{ all: boolean; countries: boolean; top10overall: boolean }>({ all: false, countries: true, top10overall: false });
  const [sendingOverall, setSendingOverall] = React.useState(false);
  const [savingOverallPrefs, setSavingOverallPrefs] = React.useState(false);

  // Load/save Overall email prefs
  useSWR('dashboard:overall_email', async () => {
    const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'dashboard_overall_email').maybeSingle();
    const val = ((data?.value as any) || {}) as { receivers?: string; body?: string };
    if (val.receivers !== undefined) setReceivers(parseReceivers(val.receivers));
    if (val.body !== undefined) setBodyText(val.body);
    return data;
  });

  async function saveOverallPrefs() {
    setSavingOverallPrefs(true);
    try {
      const value = { receivers: receivers.join(', '), body: bodyText };
      const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'dashboard_overall_email').maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'dashboard_overall_email', value } as any);
    } finally {
      setSavingOverallPrefs(false);
    }
  }

  async function sendOverall() {
    if (sendingOverall) return;
    setSendingOverall(true);
    try {
      if (receivers.length === 0) { alert('Enter at least one receiver email.'); return; }
      const dynamicParams: Record<string, string> = { all_salesmen_pdf_url: '', countries_pdf_url: '', top15_overall_pdf: '' };
      if (overallOpts.all) {
        const salesmen = latestByKind.get('general_salesmen_pdfs');
        const allUrl = salesmen?.meta?.all?.publicUrl || null;
        if (allUrl) { dynamicParams.all_salesmen_pdf_url = allUrl; }
      }
      if (overallOpts.countries) {
        const row = latestByKind.get('countries_pdf');
        if (row?.public_url) { dynamicParams.countries_pdf_url = row.public_url; }
      }
      if (overallOpts.top10overall) {
        const row = latestByKind.get('top_styles_pdf_overall');
        if (row?.public_url) { dynamicParams.top15_overall_pdf = row.public_url; }
      }
      if (selectedStockListsOverall.size > 0) {
        let idx = 1;
        for (const name of Array.from(selectedStockListsOverall)) {
          const exp = latestStockListByName.get(name);
          if (exp?.public_url) {
            dynamicParams[`stock_list_${idx}_url`] = exp.public_url;
            dynamicParams[`stock_list_${idx}_name`] = name;
            idx++;
          }
        }
      }
      const hasStockLists = Object.keys(dynamicParams).some(k => k.startsWith('stock_list_') && k.endsWith('_url'));
      if (!overallOpts.all && !overallOpts.countries && !overallOpts.top10overall && !hasStockLists) { alert('No options selected.'); return; }
      try {
        const summarize = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { len: (v || '').length, head: (v || '').slice(0, 32) }]));
        console.log('[email:overall] prepared', {
          to: receivers,
          include: { all: overallOpts.all, countries: overallOpts.countries, top10overall: overallOpts.top10overall, stockLists: Array.from(selectedStockListsOverall) },
          params: summarize(dynamicParams)
        });
      } catch {}
      const subject = 'Statistik opdatering';
      const bodyHtml = bodyText || 'Hermed statistik :)';
      await sendEmailJs(receivers, subject, bodyHtml, undefined, dynamicParams, true);
      alert('Email sent');
    } finally {
      setSendingOverall(false);
    }
  }

  async function sendEmailJs(
    to: string[],
    subject: string,
    message: string,
    attachments?: Array<{ name: string; data: string }>,
    extraTemplateParams?: Record<string, string>,
    sendAsOne?: boolean
  ) {
    if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
      throw new Error('EmailJS browser env missing. Set NEXT_PUBLIC_EMAILJS_* variables.');
    }
    const summarizeParams = (p?: Record<string, string>) => {
      const out: any = {};
      if (!p) return out;
      for (const k of Object.keys(p)) {
        const v = p[k] || '';
        out[k] = { len: v.length, head: v.slice(0, 24) };
      }
      return out;
    };
    
    if (sendAsOne && to.length > 1) {
      const basePayload = {
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: to[0],
          bcc_email: to.slice(1).join(','),
          subject,
          message_html: message,
          from_name: EMAILJS_FROM_NAME,
          from_email: EMAILJS_FROM_EMAIL,
          ...(extraTemplateParams || {}),
        },
      } as any;
      
      try {
        console.log('[EmailJS:request:preview:BCC]', {
          to: to[0],
          bcc_count: to.length - 1,
          hasAttachments: 0,
          templateParams: summarizeParams(basePayload.template_params)
        });
      } catch {}
      
      const res = await fetch(EMAILJS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(basePayload) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const lastErr = `${res.status} ${res.statusText} :: ${body}`;
        console.error('[EmailJS:error]', lastErr);
        throw new Error(lastErr || 'EmailJS send failed');
      }
      return;
    }
    
    for (const recipient of to) {
      const basePayload = {
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          to_email: recipient,
          subject,
          message_html: message,
          from_name: EMAILJS_FROM_NAME,
          from_email: EMAILJS_FROM_EMAIL,
          ...(extraTemplateParams || {}),
        },
      } as any;
      const shapes: Array<any> = extraTemplateParams && Object.keys(extraTemplateParams).length > 0
        ? [ basePayload ]
        : [
            {
              ...basePayload,
              attachments: (attachments || []).map((a) => ({ filename: a.name, content: a.data }))
            },
            {
              ...basePayload,
              attachments: (attachments || []).map((a) => ({ name: a.name, data: a.data }))
            },
            {
              ...basePayload,
              attachments: (attachments || []).map((a) => ({ name: a.name, data: `data:application/pdf;base64,${a.data}` }))
            }
          ];
      let sent = false; let lastErr: string | null = null;
      for (let idx = 0; idx < shapes.length; idx++) {
        const payload = shapes[idx];
        try {
          console.log('[EmailJS:request:preview]', {
            to: recipient,
            shapeIndex: idx,
            hasAttachments: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
            templateParams: summarizeParams(payload.template_params)
          });
        } catch {}
        const res = await fetch(EMAILJS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) { sent = true; break; }
        const body = await res.text().catch(() => '');
        lastErr = `${res.status} ${res.statusText} :: ${body}`;
        try { console.error('[EmailJS:error]', lastErr); } catch {}
      }
      if (!sent) {
        throw new Error(lastErr || 'EmailJS send failed');
      }
    }
  }

  // Toggle switch component for reuse
  const Toggle = ({ checked, onChange, label, size = 'md' }: { checked: boolean; onChange: () => void; label?: string; size?: 'sm' | 'md' }) => (
    <label className="flex items-center gap-2.5 text-sm cursor-pointer">
      <button
        type="button"
        onClick={onChange}
        className={`relative inline-flex items-center rounded-full transition-colors ${checked ? 'bg-slate-900' : 'bg-slate-200'} ${size === 'sm' ? 'h-4 w-7' : 'h-5 w-9'}`}
        aria-pressed={checked}
      >
        <span className={`inline-block transform rounded-full bg-white shadow transition-transform ${size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'} ${checked ? (size === 'sm' ? 'translate-x-3.5' : 'translate-x-4') : 'translate-x-0.5'}`} />
      </button>
      {label && <span className="text-slate-700">{label}</span>}
    </label>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-gray-500 mb-1">Statistics</div>
        <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
      </div>

      <Tabs defaultValue="mailing" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="mailing">Mailing</TabsTrigger>
          <TabsTrigger value="statistic">Statistic</TabsTrigger>
        </TabsList>

        <TabsContent value="mailing" className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Box #1 - Salesmen Statistics */}
            <Card>
              <CardHeader>
                <CardTitle>Salesmen Statistics</CardTitle>
                <CardDescription>Send personalized stats to salespersons</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Toggle
                    checked={Object.values(selected).every(Boolean) && Object.keys(selected).length > 0}
                    onChange={() => {
                  const allOn = !Object.values(selected).every(Boolean);
                  const next: Record<string, boolean> = {};
                  for (const sp of (salespersons ?? [])) next[sp.id] = allOn;
                  setSelected(next);
                }}
                    label="Select all"
                  />
            </div>

                <div className="max-h-56 overflow-auto rounded-md border">
                  <Table>
                    <TableBody>
                {(salespersons ?? []).map((sp) => (
                        <TableRow key={sp.id}>
                          <TableCell className="w-14">
                      <button
                        type="button"
                        onClick={() => toggleSp(sp.id)}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${selected[sp.id] ? 'bg-slate-900' : 'bg-slate-200'}`}
                        aria-pressed={!!selected[sp.id]}
                      >
                              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${selected[sp.id] ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                          </TableCell>
                          <TableCell className="font-medium">{sp.name}</TableCell>
                          <TableCell className="text-gray-500">{sp.email || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
          </div>

                <div className="space-y-2">
                  <Toggle checked={includeCountries} onChange={() => setIncludeCountries((v) => !v)} label="Include Countries" />
                  <Toggle checked={includeTop15Salesmen} onChange={() => setIncludeTop15Salesmen((v) => !v)} label="Include Top 15 - Salesmen" />
                </div>

                {availableStockLists.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-600 mb-2">Stock Lists</div>
                    <div className="flex flex-wrap gap-1.5">
                      {availableStockLists.map((l) => {
                const on = selectedStockListsSalesmen.has(l.name);
                return (
                          <Badge
                            key={l.id}
                            className={`cursor-pointer select-none transition-colors ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50'}`}
                            onClick={() => toggleStockListSalesmen(l.name)}
                          >
                            {l.name}
                          </Badge>
                );
              })}
            </div>
          </div>
                )}

          <div>
                  <div className="text-xs text-gray-600 mb-1">Email body</div>
                  <textarea
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 h-24 resize-none"
                    placeholder="Write your message…"
                    value={salesmenBodyText}
                    onChange={(e) => setSalesmenBodyText(e.target.value)}
                  />
          </div>

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={savingSalesmenPrefs} onClick={saveSalesmenPrefs}>
                    {savingSalesmenPrefs ? 'Saving…' : 'Save body'}
                  </Button>
                  <Button size="sm" disabled={sendingSp} onClick={sendSalespersonEmails}>
                    {sendingSp ? 'Sending…' : 'Send'}
                  </Button>
        </div>
              </CardContent>
            </Card>

            {/* Box #2 - Overall Statistics */}
            <Card>
              <CardHeader>
                <CardTitle>Overall Statistics</CardTitle>
                <CardDescription>Send combined stats to specific recipients</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <EmailPillsInput
                  label="Recipients"
                  value={receivers}
                  onChange={setReceivers}
                  placeholder="Add email…"
                  helpText="Press Enter or comma to add"
                />

                <div className="space-y-2">
            {[
              { key: 'all', label: 'All salespeople' },
              { key: 'countries', label: 'Countries' },
              { key: 'top10overall', label: 'Top 15 - Overall' }
                  ].map((opt) => (
                    <Toggle
                      key={opt.key}
                      checked={(overallOpts as any)[opt.key]}
                      onChange={() => setOverallOpts((p) => ({ ...p, [opt.key]: !(p as any)[opt.key] }))}
                      label={opt.label}
                    />
                  ))}
                </div>

                {availableStockLists.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-600 mb-2">Stock Lists</div>
                    <div className="flex flex-wrap gap-1.5">
                      {availableStockLists.map((l) => {
                const on = selectedStockListsOverall.has(l.name);
                return (
                          <Badge
                            key={l.id}
                            className={`cursor-pointer select-none transition-colors ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50'}`}
                            onClick={() => toggleStockListOverall(l.name)}
                          >
                            {l.name}
                          </Badge>
                );
              })}
            </div>
          </div>
                )}

                <div>
                  <div className="text-xs text-gray-600 mb-1">Email body</div>
                  <textarea
                    className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 h-24 resize-none"
                    placeholder="Write your message…"
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                  />
          </div>

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={savingOverallPrefs} onClick={saveOverallPrefs}>
                    {savingOverallPrefs ? 'Saving…' : 'Save settings'}
                  </Button>
                  <Button size="sm" disabled={sendingOverall} onClick={sendOverall}>
                    {sendingOverall ? 'Sending…' : 'Send'}
                  </Button>
        </div>
              </CardContent>
            </Card>
      </div>

          {/* Box #3 - Stock List Schedules */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Stock List Schedules</CardTitle>
                <CardDescription>Configure automated stock list emails</CardDescription>
              </div>
              <Button size="sm" onClick={openNewSchedule}>
                <Plus className="h-4 w-4 mr-1" />
                New Schedule
              </Button>
            </CardHeader>
            <CardContent>
              {schedules.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">
                  No schedules configured yet. Create one to get started.
                </div>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">On</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Stock Lists</TableHead>
                        <TableHead>Recipients</TableHead>
                        <TableHead>Schedule</TableHead>
                        <TableHead>Last Run</TableHead>
                        <TableHead className="w-28">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {schedules.map((schedule) => (
                        <TableRow 
                          key={schedule.id} 
                          className="cursor-pointer hover:bg-slate-50"
                          onClick={() => openViewSchedule(schedule)}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Toggle
                              checked={schedule.enabled}
                              onChange={() => handleToggleEnabled(schedule.id)}
                              size="sm"
                            />
                          </TableCell>
                          <TableCell className="font-medium">{schedule.name}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {schedule.stockLists.slice(0, 2).map(name => (
                                <Badge key={name} className="text-[10px] py-0">{name}</Badge>
                              ))}
                              {schedule.stockLists.length > 2 && (
                                <Badge className="text-[10px] py-0 bg-slate-100">+{schedule.stockLists.length - 2}</Badge>
                              )}
          </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-gray-600">{schedule.recipients.length} recipient{schedule.recipients.length !== 1 ? 's' : ''}</span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 text-xs text-gray-600">
                              <Clock className="h-3 w-3" />
                              {formatSchedule(schedule)}
        </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-gray-500">{formatLastRun(schedule.lastRun)}</span>
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => handleSendNow(schedule)}
                                disabled={sendingScheduleId === schedule.id}
                                title="Send now"
                              >
                                <Send className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => openEditSchedule(schedule)}
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => handleDeleteSchedule(schedule.id)}
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
        </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
      </div>
              )}

              {availableStockLists.length === 0 && (
                <div className="mt-4 p-3 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs">
                  No stock list exports available. Export stock lists first to create schedules.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Box #4 - Statistic Schedules */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Statistic Schedules</CardTitle>
                <CardDescription>Configure automated statistics emails with PDFs and reports</CardDescription>
              </div>
              <Button size="sm" onClick={openNewStatisticSchedule}>
                <Plus className="h-4 w-4 mr-1" />
                New Schedule
              </Button>
            </CardHeader>
            <CardContent>
              {statisticSchedules.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">
                  No statistic schedules configured yet. Create one to get started.
                </div>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">On</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Recipients</TableHead>
                        <TableHead>Schedule</TableHead>
                        <TableHead className="w-28">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statisticSchedules.map((schedule) => {
                        const recipientCount = schedule.salespersonIds.length + (schedule.additionalRecipients?.length || 0);
                        return (
                        <TableRow 
                          key={schedule.id} 
                          className="cursor-pointer hover:bg-slate-50"
                          onClick={() => openViewStatisticSchedule(schedule)}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Toggle
                              checked={schedule.enabled}
                              onChange={() => handleToggleStatisticEnabled(schedule.id)}
                              size="sm"
                            />
                          </TableCell>
                          <TableCell className="font-medium">{schedule.name}</TableCell>
                          <TableCell>
                            <span className="text-xs text-gray-600">
                              {recipientCount} recipient{recipientCount !== 1 ? 's' : ''}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1 text-xs text-gray-600">
                              <Clock className="h-3 w-3" />
                              {formatSchedule(schedule)}
                            </div>
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => handleSendStatisticNow(schedule)}
                                disabled={sendingStatisticScheduleId === schedule.id}
                                title="Send now"
                              >
                                <Send className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => openEditStatisticSchedule(schedule)}
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => handleDeleteStatisticSchedule(schedule.id)}
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

      {/* Info / Errors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Info</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xs text-gray-500">
                  {availableStockLists.length > 0 ? (
                    <span>{availableStockLists.length} stock list{availableStockLists.length !== 1 ? 's' : ''} with exports available</span>
                  ) : (
                    <span>—</span>
                  )}
        </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Errors</CardTitle>
              </CardHeader>
              <CardContent>
            {(missingDgList && missingDgList.length > 0) ? (
                  <div className="text-xs">
                    <div className="font-medium text-slate-700 mb-1">Missing DG in Top 15 (Current Season):</div>
                    <ul className="list-disc pl-5 text-slate-600 space-y-0.5">
                      {missingDgList.map((row) => (
                        <li key={row.style_no}>{row.style_no}{row.name ? ` — ${row.name}` : ''}</li>
                      ))}
                </ul>
              </div>
            ) : (
                  <div className="text-xs text-gray-500">No errors</div>
            )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="statistic">
          <Card>
            <CardHeader>
              <CardTitle>Statistics</CardTitle>
              <CardDescription>View and analyze your data</CardDescription>
            </CardHeader>
            <CardContent className="py-12 text-center">
              <div className="text-slate-400 text-sm">Coming soon</div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Schedule Editor Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetClose onClick={() => setSheetOpen(false)} />
        <SheetHeader>
          <SheetTitle>{editingSchedule ? 'Edit Schedule' : 'New Schedule'}</SheetTitle>
        </SheetHeader>
        <SheetContent className="space-y-6">
          {/* Schedule Name */}
          <div>
            <label className="text-sm text-gray-600 block mb-1">Schedule Name</label>
          <input 
              type="text"
              className="w-full h-9 rounded-md border border-slate-200 bg-white px-3 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              placeholder="e.g., Weekly Customer Update"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
        </div>

          {/* Stock Lists */}
          <div>
            <label className="text-sm text-gray-600 block mb-2">Stock Lists</label>
            {availableStockLists.length === 0 ? (
              <div className="text-xs text-gray-500">No stock lists with exports available</div>
            ) : (
          <div className="flex flex-wrap gap-2">
                {availableStockLists.map((l) => {
                  const on = formStockLists.has(l.name);
              return (
                    <Badge
                      key={l.id}
                      className={`cursor-pointer select-none transition-colors ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50'}`}
                      onClick={() => {
                        setFormStockLists(prev => {
                          const n = new Set(prev);
                          if (n.has(l.name)) n.delete(l.name);
                          else n.add(l.name);
                          return n;
                        });
                      }}
                    >
                      {l.name}
                    </Badge>
              );
            })}
          </div>
            )}
        </div>

          {/* Recipients */}
          <EmailPillsInput
            label="Recipients"
            value={formRecipients}
            onChange={setFormRecipients}
            placeholder="Add email…"
            helpText="Press Enter or comma to add"
          />

          {/* Schedule Type */}
          <div>
            <label className="text-sm text-gray-600 block mb-2">Frequency</label>
            <div className="flex gap-2">
              <Button
                variant={formScheduleType === 'daily' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFormScheduleType('daily')}
              >
                Daily
              </Button>
              <Button
                variant={formScheduleType === 'weekly' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFormScheduleType('weekly')}
              >
                Weekly
              </Button>
        </div>
      </div>

          {/* Days (for weekly) */}
          {formScheduleType === 'weekly' && (
            <div>
              <label className="text-sm text-gray-600 block mb-2">Days</label>
              <div className="flex gap-1">
                {DAYS_OF_WEEK.map((day) => {
                  const on = formDays.has(day.value);
                  return (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => {
                        setFormDays(prev => {
                          const n = new Set(prev);
                          if (n.has(day.value)) n.delete(day.value);
                          else n.add(day.value);
                          return n;
                        });
                      }}
                      className={`h-9 w-10 rounded-md text-xs font-medium transition-colors ${on ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                    >
                      {day.label}
                    </button>
                  );
                })}
        </div>
            </div>
          )}

          {/* Time */}
              <div>
            <label className="text-sm text-gray-600 block mb-1">Time</label>
            <input
              type="time"
              className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              value={formTime}
              onChange={(e) => setFormTime(e.target.value)}
            />
              </div>

          {/* Email Body */}
          <div>
            <label className="text-sm text-gray-600 block mb-1">Email Body</label>
            <textarea
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 h-24 resize-none"
              placeholder="Write your message…"
              value={formEmailBody}
              onChange={(e) => setFormEmailBody(e.target.value)}
            />
          </div>

          {/* Enabled */}
          <Toggle
            checked={formEnabled}
            onChange={() => setFormEnabled(v => !v)}
            label="Schedule enabled"
          />

          {/* Actions */}
          <div className="flex gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => setSheetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveSchedule} disabled={savingSchedules}>
              {savingSchedules ? 'Saving…' : editingSchedule ? 'Update Schedule' : 'Create Schedule'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Schedule View Sheet */}
      <Sheet open={viewSheetOpen} onOpenChange={setViewSheetOpen}>
        <SheetClose onClick={() => setViewSheetOpen(false)} />
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {viewingSchedule?.name}
            {viewingSchedule && (
              <Badge className={viewingSchedule.enabled ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500'}>
                {viewingSchedule.enabled ? 'Active' : 'Disabled'}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>
        <SheetContent className="space-y-6">
          {viewingSchedule && (
            <>
              {/* Schedule Info */}
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Calendar className="h-4 w-4" />
                <span>{formatSchedule(viewingSchedule)}</span>
                {viewingSchedule.lastRun && (
                  <span className="text-gray-400">· Last sent {formatLastRun(viewingSchedule.lastRun)}</span>
            )}
          </div>

              {/* What is sent */}
              <div>
                <h3 className="text-sm font-medium text-slate-900 mb-3">What is sent</h3>
                <div className="space-y-2">
                  {viewingSchedule.stockLists.map((listName) => {
                    const exp = latestStockListByName.get(listName);
                    return (
                      <div key={listName} className="flex items-center justify-between p-3 rounded-md border bg-slate-50">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded bg-slate-200 flex items-center justify-center">
                            <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
        </div>
                          <div>
                            <div className="text-sm font-medium text-slate-900">{listName}</div>
                            <div className="text-xs text-gray-500">{listName} - Lagerliste.pdf</div>
      </div>
      </div>
                        {exp?.public_url ? (
                          <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px]">Ready</Badge>
                        ) : (
                          <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[10px]">No export</Badge>
                        )}
    </div>
  );
                  })}
                </div>
              </div>

              {/* Recipients */}
              <div>
                <h3 className="text-sm font-medium text-slate-900 mb-3">Recipients ({viewingSchedule.recipients.length})</h3>
                <div className="space-y-1 max-h-48 overflow-auto">
                  {viewingSchedule.recipients.map((email) => (
                    <div key={email} className="flex items-center gap-2 py-2 px-3 rounded-md border bg-white">
                      <div className="h-6 w-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-medium text-slate-600 uppercase">
                        {email.charAt(0)}
                      </div>
                      <span className="text-sm text-slate-700">{email}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Email Body Preview */}
              <div>
                <h3 className="text-sm font-medium text-slate-900 mb-2">Email Message</h3>
                <div className="p-3 rounded-md border bg-slate-50 text-sm text-slate-600 whitespace-pre-wrap">
                  {viewingSchedule.emailBody || 'Hermed lagerliste :)'}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => setViewSheetOpen(false)}>
                  Close
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => {
                    if (viewingSchedule) openEditSchedule(viewingSchedule);
                  }}
                >
                  <Pencil className="h-4 w-4 mr-1" />
                  Edit
                </Button>
                <Button 
                  onClick={() => {
                    if (viewingSchedule) {
                      handleSendNow(viewingSchedule);
                      setViewSheetOpen(false);
                    }
                  }}
                  disabled={sendingScheduleId === viewingSchedule?.id}
                >
                  <Send className="h-4 w-4 mr-1" />
                  {sendingScheduleId === viewingSchedule?.id ? 'Sending…' : 'Send Now'}
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Statistic Schedule Editor Sheet */}
      <Sheet open={statisticSheetOpen} onOpenChange={setStatisticSheetOpen}>
        <SheetClose onClick={() => setStatisticSheetOpen(false)} />
        <SheetHeader>
          <SheetTitle>{editingStatisticSchedule ? 'Edit Statistic Schedule' : 'New Statistic Schedule'}</SheetTitle>
        </SheetHeader>
        <SheetContent className="space-y-6">
          {/* Schedule Name */}
          <div>
            <label className="text-sm text-gray-600 block mb-1">Schedule Name</label>
            <input 
              type="text"
              className="w-full h-9 rounded-md border border-slate-200 bg-white px-3 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              placeholder="e.g., Weekly Statistics"
              value={stFormName}
              onChange={(e) => setStFormName(e.target.value)}
            />
          </div>

          {/* Salespersons Selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-gray-600">Salespersons (receive personal PDF)</label>
              <button
                type="button"
                onClick={() => {
                  const allIds = (salespersons ?? []).filter(sp => sp.email).map(sp => sp.id);
                  const allSelected = allIds.every(id => stFormSalespersons.has(id));
                  if (allSelected) {
                    setStFormSalespersons(new Set());
                  } else {
                    setStFormSalespersons(new Set(allIds));
                  }
                }}
                className="text-xs text-slate-600 hover:text-slate-900"
              >
                {(salespersons ?? []).filter(sp => sp.email).every(sp => stFormSalespersons.has(sp.id)) ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="max-h-32 overflow-auto rounded-md border">
              <Table>
                <TableBody>
                  {(salespersons ?? []).map((sp) => {
                    const hasEmail = Boolean(sp.email);
                    const on = stFormSalespersons.has(sp.id);
                    return (
                      <TableRow 
                        key={sp.id} 
                        className={!hasEmail ? 'opacity-50' : 'cursor-pointer'}
                        onClick={() => {
                          if (!hasEmail) return;
                          setStFormSalespersons(prev => {
                            const n = new Set(prev);
                            if (n.has(sp.id)) n.delete(sp.id);
                            else n.add(sp.id);
                            return n;
                          });
                        }}
                      >
                        <TableCell className="w-10">
                          <div className={`h-4 w-4 rounded border ${on ? 'bg-slate-900 border-slate-900' : 'bg-white border-slate-300'} flex items-center justify-center`}>
                            {on && <span className="text-white text-[10px]">✓</span>}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium text-sm">{sp.name}</TableCell>
                        <TableCell className="text-xs text-gray-500">{sp.email || '(no email)'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Additional Recipients */}
          <div>
            <EmailPillsInput
              label="Additional Recipients"
              helpText="Emails not in salespersons list (no personal PDF)"
              value={stFormAdditionalRecipients}
              onChange={setStFormAdditionalRecipients}
              placeholder="Add email…"
            />
          </div>

          {/* Files to Include */}
          <div className="space-y-2">
            <label className="text-sm text-gray-600 block">Files to include</label>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={stFormIncludeGeneralCombined}
                    onChange={() => setStFormIncludeGeneralCombined(v => !v)}
                    size="sm"
                  />
                  <span className="text-sm">General (all combined)</span>
                </div>
                {latestByKind.get('general_salesmen_pdfs')?.meta?.all?.publicUrl && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPreviewUrl(latestByKind.get('general_salesmen_pdfs')?.meta?.all?.publicUrl || null)}>
                    <Eye className="h-3 w-3 mr-1" />Preview
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={stFormIncludeCountries}
                    onChange={() => setStFormIncludeCountries(v => !v)}
                    size="sm"
                  />
                  <span className="text-sm">Countries</span>
                </div>
                {latestByKind.get('countries_pdf')?.public_url && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPreviewUrl(latestByKind.get('countries_pdf')?.public_url || null)}>
                    <Eye className="h-3 w-3 mr-1" />Preview
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={stFormIncludeTop15Salesmen}
                    onChange={() => setStFormIncludeTop15Salesmen(v => !v)}
                    size="sm"
                  />
                  <span className="text-sm">Top 15 – Salesmen</span>
                </div>
                {latestByKind.get('top_styles_pdf_salesmen')?.public_url && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPreviewUrl(latestByKind.get('top_styles_pdf_salesmen')?.public_url || null)}>
                    <Eye className="h-3 w-3 mr-1" />Preview
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={stFormIncludeTop15Overall}
                    onChange={() => setStFormIncludeTop15Overall(v => !v)}
                    size="sm"
                  />
                  <span className="text-sm">Top 15 – Overall</span>
                </div>
                {latestByKind.get('top_styles_pdf_overall')?.public_url && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPreviewUrl(latestByKind.get('top_styles_pdf_overall')?.public_url || null)}>
                    <Eye className="h-3 w-3 mr-1" />Preview
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={stFormIncludeOverview}
                    onChange={() => setStFormIncludeOverview(v => !v)}
                    size="sm"
                  />
                  <span className="text-sm">Overview</span>
                </div>
                {latestByKind.get('overview_pdf')?.public_url && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPreviewUrl(latestByKind.get('overview_pdf')?.public_url || null)}>
                    <Eye className="h-3 w-3 mr-1" />Preview
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Stock Lists */}
          {availableStockLists.length > 0 && (
            <div>
              <label className="text-sm text-gray-600 block mb-2">Stock Lists (optional)</label>
              <div className="flex flex-wrap gap-2">
                {availableStockLists.map((l) => {
                  const on = stFormStockLists.has(l.name);
                  const exp = latestStockListByName.get(l.name);
                  return (
                    <div key={l.id} className="flex items-center gap-1">
                      <Badge
                        className={`cursor-pointer select-none transition-colors ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50'}`}
                        onClick={() => {
                          setStFormStockLists(prev => {
                            const n = new Set(prev);
                            if (n.has(l.name)) n.delete(l.name);
                            else n.add(l.name);
                            return n;
                          });
                        }}
                      >
                        {l.name}
                      </Badge>
                      {exp?.public_url && (
                        <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setPreviewUrl(exp.public_url || null)} title="Preview">
                          <Eye className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Schedule Type */}
          <div>
            <label className="text-sm text-gray-600 block mb-2">Frequency</label>
            <div className="flex gap-2">
              <Button
                variant={stFormScheduleType === 'daily' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStFormScheduleType('daily')}
              >
                Daily
              </Button>
              <Button
                variant={stFormScheduleType === 'weekly' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStFormScheduleType('weekly')}
              >
                Weekly
              </Button>
            </div>
          </div>

          {/* Days (for weekly) */}
          {stFormScheduleType === 'weekly' && (
            <div>
              <label className="text-sm text-gray-600 block mb-2">Days</label>
              <div className="flex gap-1">
                {DAYS_OF_WEEK.map((day) => {
                  const on = stFormDays.has(day.value);
                  return (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => {
                        setStFormDays(prev => {
                          const n = new Set(prev);
                          if (n.has(day.value)) n.delete(day.value);
                          else n.add(day.value);
                          return n;
                        });
                      }}
                      className={`h-9 w-10 rounded-md text-xs font-medium transition-colors ${on ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Time */}
          <div>
            <label className="text-sm text-gray-600 block mb-1">Time</label>
            <input
              type="time"
              className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              value={stFormTime}
              onChange={(e) => setStFormTime(e.target.value)}
            />
          </div>

          {/* Email Body */}
          <div>
            <label className="text-sm text-gray-600 block mb-1">Email Body</label>
            <textarea
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 h-24 resize-none"
              placeholder="Write your message…"
              value={stFormEmailBody}
              onChange={(e) => setStFormEmailBody(e.target.value)}
            />
            <p className="text-xs text-gray-400 mt-1">Salesperson's first name will be used for greeting automatically</p>
          </div>

          {/* Enabled */}
          <Toggle
            checked={stFormEnabled}
            onChange={() => setStFormEnabled(v => !v)}
            label="Schedule enabled"
          />

          {/* Actions */}
          <div className="flex gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => setStatisticSheetOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveStatisticSchedule} disabled={savingStatisticSchedules}>
              {savingStatisticSchedules ? 'Saving…' : editingStatisticSchedule ? 'Update Schedule' : 'Create Schedule'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* PDF Preview Dialog */}
      {previewUrl && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={() => setPreviewUrl(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-sm font-medium">PDF Preview</h3>
              <div className="flex items-center gap-2">
                <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-slate-600 hover:text-slate-900 underline">
                  Open in new tab
                </a>
                <Button variant="ghost" size="sm" onClick={() => setPreviewUrl(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <iframe src={previewUrl} className="w-full h-[70vh] border rounded" />
            </div>
          </div>
        </div>
      )}

      {/* Statistic Schedule View Sheet */}
      <Sheet open={viewStatisticSheetOpen} onOpenChange={setViewStatisticSheetOpen}>
        <SheetClose onClick={() => setViewStatisticSheetOpen(false)} />
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {viewingStatisticSchedule?.name}
            {viewingStatisticSchedule && (
              <Badge className={viewingStatisticSchedule.enabled ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500'}>
                {viewingStatisticSchedule.enabled ? 'Active' : 'Disabled'}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>
        <SheetContent className="space-y-6">
          {viewingStatisticSchedule && (
            <>
              {/* Schedule Info */}
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Calendar className="h-4 w-4" />
                <span>{formatSchedule(viewingStatisticSchedule)}</span>
                {viewingStatisticSchedule.lastRun && (
                  <span className="text-gray-400">· Last sent {formatLastRun(viewingStatisticSchedule.lastRun)}</span>
                )}
              </div>

              {/* Files included */}
              <div>
                <h3 className="text-sm font-medium text-slate-900 mb-2">Files Included</h3>
                <div className="flex flex-wrap gap-2">
                  {viewingStatisticSchedule.salespersonIds.length > 0 && <Badge className="bg-slate-100">Personal PDF</Badge>}
                  {viewingStatisticSchedule.includeGeneralCombined && <Badge className="bg-slate-100">General (all)</Badge>}
                  {viewingStatisticSchedule.includeCountries && <Badge className="bg-slate-100">Countries</Badge>}
                  {viewingStatisticSchedule.includeTop15Salesmen && <Badge className="bg-slate-100">Top 15 Salesmen</Badge>}
                  {viewingStatisticSchedule.includeTop15Overall && <Badge className="bg-slate-100">Top 15 Overall</Badge>}
                  {viewingStatisticSchedule.includeOverview && <Badge className="bg-slate-100">Overview</Badge>}
                  {(viewingStatisticSchedule.stockLists || []).map(name => (
                    <Badge key={name} className="bg-slate-100">{name}</Badge>
                  ))}
                </div>
              </div>

              {/* Salespersons who will receive */}
              {viewingStatisticSchedule.salespersonIds.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-slate-900 mb-2">
                    Salespersons ({viewingStatisticSchedule.salespersonIds.length})
                  </h3>
                  <div className="space-y-1 max-h-32 overflow-auto">
                    {viewingStatisticSchedule.salespersonIds.map((spId) => {
                      const sp = (salespersons ?? []).find(s => s.id === spId);
                      if (!sp) return null;
                      return (
                        <div key={spId} className="flex items-center gap-2 py-2 px-3 rounded-md border bg-white">
                          <div className="h-6 w-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-medium text-slate-600 uppercase">
                            {sp.name.charAt(0)}
                          </div>
                          <div className="flex-1">
                            <span className="text-sm text-slate-700 font-medium">{sp.name}</span>
                            <span className="text-xs text-slate-400 ml-2">{sp.email || '(no email)'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Additional Recipients */}
              {(viewingStatisticSchedule.additionalRecipients?.length || 0) > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-slate-900 mb-2">
                    Additional Recipients ({viewingStatisticSchedule.additionalRecipients?.length || 0})
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {(viewingStatisticSchedule.additionalRecipients || []).map((email) => (
                      <Badge key={email} className="bg-slate-100">{email}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Email Body Preview */}
              <div>
                <h3 className="text-sm font-medium text-slate-900 mb-2">Email Message</h3>
                <div className="p-3 rounded-md border bg-slate-50 text-sm text-slate-600 whitespace-pre-wrap">
                  Hej [First Name],{'\n\n'}{viewingStatisticSchedule.emailBody || 'Hermed statistik :)'}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => setViewStatisticSheetOpen(false)}>
                  Close
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => {
                    if (viewingStatisticSchedule) openEditStatisticSchedule(viewingStatisticSchedule);
                  }}
                >
                  <Pencil className="h-4 w-4 mr-1" />
                  Edit
                </Button>
                <Button 
                  onClick={() => {
                    if (viewingStatisticSchedule) {
                      handleSendStatisticNow(viewingStatisticSchedule);
                      setViewStatisticSheetOpen(false);
                    }
                  }}
                  disabled={sendingStatisticScheduleId === viewingStatisticSchedule?.id}
                >
                  <Send className="h-4 w-4 mr-1" />
                  {sendingStatisticScheduleId === viewingStatisticSchedule?.id ? 'Sending…' : 'Send Now'}
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
