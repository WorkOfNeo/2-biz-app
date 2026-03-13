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
import { Plus, Pencil, Trash2, Send, Clock, Calendar, Eye, X, Settings, RefreshCw, Play } from 'lucide-react';

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
  // New pipeline delivery options
  sendToSalespersons?: boolean;
  sendToOverall?: boolean;
  overallRecipientsCsv?: string;
}

interface EmailSendSchedule {
  id: string;
  name: string;
  enabled: boolean;
  days: number[];
  time: string;
  scrapeFirst: boolean;
  endDate?: string;
  recipientType: 'salespersons' | 'email_list';
  salespersonIds: string[];
  emails: string[];
  include: {
    countries: boolean;
    top15Salesmen: boolean;
    top15Overall: boolean;
    overview: boolean;
    generalCombined: boolean;
  };
  stockLists: string[];
  lastRun?: string;
  createdAt: string;
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

// ============================================================================
// SCRAPES TAB COMPONENT
// ============================================================================

interface ScrapeSchedule {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  hours: number[];
  days_of_week: number[] | null;
  config: Record<string, any>;
  updated_at: string;
}

const HOURS_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: i,
  label: `${String(i).padStart(2, '0')}:00`,
}));

const DAYS_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

function formatScrapeSchedule(schedule: ScrapeSchedule): string {
  const hours = schedule.hours.sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}:00`);
  const minuteOffset = schedule.config?.minuteOffset;
  const hoursWithOffset = minuteOffset ? hours.map(h => h.replace(':00', `:${String(minuteOffset).padStart(2, '0')}`)) : hours;
  
  if (schedule.days_of_week === null) {
    return `Daily at ${hoursWithOffset.join(', ')}`;
  }
  const days = schedule.days_of_week.sort((a, b) => a - b).map(d => DAYS_OPTIONS.find(o => o.value === d)?.label || '').filter(Boolean);
  return `${days.join(', ')} at ${hoursWithOffset.join(', ')}`;
}

// Map schedule keys to job types
const SCHEDULE_JOB_TYPE_MAP: Record<string, string> = {
  check_stock_fix: 'check_stock_fix',
  scrape_statistics: 'scrape_statistics',
  scrape_purchase_orders: 'scrape_purchase_orders',
  scrape_top_styles: 'scrape_top_styles',
  export_statistics: 'export_overview',
  weekly_style_refresh: 'scrape_styles',
  weekly_customer_sync: 'scrape_customers',
};

interface JobStatus {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  payload?: {
    phase?: string;
    scrapeFirst?: boolean;
    scrapeJobId?: string;
    stockScrapeJobId?: string;
    scrapeCompletedAt?: string;
    exportJobIds?: string[];
    exportCompletedAt?: string;
  };
}

function formatElapsedTime(startedAt: string | null): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const elapsed = Math.floor((now - start) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${mins}m ${secs}s`;
}

// Helper to get current phase info and progress
function getPhaseInfo(job: JobStatus): {
  phase: string;
  phaseLabel: string;
  progress: number;
  estimatedTotal: number;
  eta: string;
} {
  const phase = job.payload?.phase || 'init';
  const scrapeFirst = job.payload?.scrapeFirst || false;
  
  // Phase definitions with estimated durations (in seconds)
  const phases = scrapeFirst
    ? [
        { id: 'init', label: 'Initializing', duration: 5 },
        { id: 'waiting_scrapes', label: 'Scraping data', duration: 120 },
        { id: 'enqueue_exports', label: 'Preparing exports', duration: 5 },
        { id: 'waiting_exports', label: 'Generating PDFs', duration: 90 },
        { id: 'send_emails', label: 'Sending emails', duration: 10 },
        { id: 'done', label: 'Complete', duration: 0 },
      ]
    : [
        { id: 'init', label: 'Initializing', duration: 5 },
        { id: 'send_emails', label: 'Sending emails', duration: 10 },
        { id: 'done', label: 'Complete', duration: 0 },
      ];

  const currentPhaseIndex = phases.findIndex((p) => p.id === phase);
  const validIndex = currentPhaseIndex >= 0 ? currentPhaseIndex : 0;
  const currentPhase = phases[validIndex]!;
  
  // Calculate total estimated time
  const totalEstimated = phases.reduce((sum, p) => sum + p.duration, 0);
  
  // Calculate elapsed time up to current phase
  const elapsedPhases = phases.slice(0, validIndex);
  const elapsedEstimated = elapsedPhases.reduce((sum, p) => sum + p.duration, 0);
  
  // Progress percentage (0-100)
  const progress = totalEstimated > 0 
    ? Math.round((elapsedEstimated / totalEstimated) * 100)
    : 0;
  
  // Calculate ETA based on elapsed time and progress
  const startTime = job.started_at || job.created_at;
  const elapsedMs = Date.now() - new Date(startTime).getTime();
  const elapsedSec = Math.floor(elapsedMs / 1000);
  
  let eta = '';
  if (job.status === 'running' && progress > 0 && progress < 100) {
    const estimatedTotalSec = (elapsedSec / progress) * 100;
    const remainingSec = Math.max(0, Math.round(estimatedTotalSec - elapsedSec));
    if (remainingSec < 60) {
      eta = `~${remainingSec}s`;
    } else {
      const mins = Math.floor(remainingSec / 60);
      eta = `~${mins}m`;
    }
  }
  
  return {
    phase: currentPhase.id,
    phaseLabel: currentPhase.label,
    progress,
    estimatedTotal: totalEstimated,
    eta,
  };
}

function formatLastRunTime(completedAt: string | null): string {
  if (!completedAt) return '—';
  const d = new Date(completedAt);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (isToday) return `Today ${hh}:${mm}`;
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}/${month} ${hh}:${mm}`;
}

function ScrapesTab() {
  const [schedules, setSchedules] = React.useState<ScrapeSchedule[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editHours, setEditHours] = React.useState<number[]>([]);
  const [editDays, setEditDays] = React.useState<number[] | null>(null);
  const [editMinuteOffset, setEditMinuteOffset] = React.useState<number>(0);
  const [runningJob, setRunningJob] = React.useState<string | null>(null);
  
  // Track job statuses by schedule key
  const [jobStatuses, setJobStatuses] = React.useState<Record<string, JobStatus | null>>({});
  const [elapsedTimes, setElapsedTimes] = React.useState<Record<string, string>>({});

  const fetchSchedules = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/scrape-schedules');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setSchedules(data.schedules || []);
    } catch (e: any) {
      console.error('Failed to fetch scrape schedules:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch latest job status for each schedule
  const fetchJobStatuses = React.useCallback(async () => {
    const jobTypes = Object.values(SCHEDULE_JOB_TYPE_MAP);
    try {
      const { data: jobs, error } = await supabase
        .from('jobs')
        .select('id, type, status, created_at, started_at, finished_at, error')
        .in('type', jobTypes)
        .order('created_at', { ascending: false })
        .limit(50);
      
      if (error) {
        console.error('Failed to fetch job statuses:', error);
        return;
      }
      
      // Group by type, keeping the latest for each
      const latestByType: Record<string, JobStatus> = {};
      for (const job of (jobs || [])) {
        if (!latestByType[job.type]) {
          latestByType[job.type] = job as JobStatus;
        }
      }
      
      // Map to schedule keys
      const statusByKey: Record<string, JobStatus | null> = {};
      for (const [scheduleKey, jobType] of Object.entries(SCHEDULE_JOB_TYPE_MAP)) {
        statusByKey[scheduleKey] = latestByType[jobType] || null;
      }
      
      setJobStatuses(statusByKey);
    } catch (e: any) {
      console.error('Failed to fetch job statuses:', e);
    }
  }, []);

  React.useEffect(() => {
    fetchSchedules();
    fetchJobStatuses();
  }, [fetchSchedules, fetchJobStatuses]);
  
  // Poll for job statuses every 5 seconds
  React.useEffect(() => {
    const interval = setInterval(() => {
      fetchJobStatuses();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchJobStatuses]);
  
  // Update elapsed times every second for running jobs
  React.useEffect(() => {
    const interval = setInterval(() => {
      const newElapsed: Record<string, string> = {};
      for (const [key, job] of Object.entries(jobStatuses)) {
        if (job && job.status === 'running' && job.started_at) {
          newElapsed[key] = formatElapsedTime(job.started_at);
        }
      }
      setElapsedTimes(newElapsed);
    }, 1000);
    return () => clearInterval(interval);
  }, [jobStatuses]);

  const toggleEnabled = async (schedule: ScrapeSchedule) => {
    setSaving(schedule.id);
    try {
      const res = await fetch('/api/admin/scrape-schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: schedule.id, enabled: !schedule.enabled }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const errorMsg = errorData.error || 'Failed to update';
        throw new Error(errorMsg);
      }
      await fetchSchedules();
    } catch (e: any) {
      console.error('[toggleEnabled] Error:', e);
      alert(`Failed to update schedule: ${e?.message || 'Unknown error'}`);
    } finally {
      setSaving(null);
    }
  };

  const startEdit = (schedule: ScrapeSchedule) => {
    setEditingId(schedule.id);
    setEditHours([...schedule.hours]);
    setEditDays(schedule.days_of_week ? [...schedule.days_of_week] : null);
    setEditMinuteOffset(schedule.config?.minuteOffset || 0);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditHours([]);
    setEditDays(null);
    setEditMinuteOffset(0);
  };

  const saveEdit = async (schedule: ScrapeSchedule) => {
    setSaving(schedule.id);
    try {
      const config = { ...schedule.config };
      if (editMinuteOffset > 0) {
        config.minuteOffset = editMinuteOffset;
      } else {
        delete config.minuteOffset;
      }
      
      const res = await fetch('/api/admin/scrape-schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: schedule.id,
          hours: editHours,
          days_of_week: editDays,
          config,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const errorMsg = errorData.error || 'Failed to update';
        throw new Error(errorMsg);
      }
      await fetchSchedules();
      cancelEdit();
    } catch (e: any) {
      console.error('[saveEdit] Error:', e);
      alert(`Failed to save schedule: ${e?.message || 'Unknown error'}`);
    } finally {
      setSaving(null);
    }
  };

  const toggleHour = (hour: number) => {
    if (editHours.includes(hour)) {
      setEditHours(editHours.filter(h => h !== hour));
    } else {
      setEditHours([...editHours, hour].sort((a, b) => a - b));
    }
  };

  const toggleDay = (day: number) => {
    if (editDays === null) {
      // Switching from "every day" to specific days
      setEditDays([day]);
    } else if (editDays.includes(day)) {
      const newDays = editDays.filter(d => d !== day);
      setEditDays(newDays.length === 0 ? null : newDays);
    } else {
      setEditDays([...editDays, day].sort((a, b) => a - b));
    }
  };

  const runNow = async (schedule: ScrapeSchedule, withStyleDetails = false) => {
    setRunningJob(schedule.id);
    try {
      // Special handling for weekly_style_refresh - call the CRON route to enqueue full pipeline
      if (schedule.key === 'weekly_style_refresh') {
        const res = await fetch('/api/cron/weekly-style-refresh?debug=1&manual=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || 'Failed to enqueue pipeline');
        }
        
        const data = await res.json();
        if (data.skipped) {
          alert(`Pipeline skipped: ${data.reason}`);
        } else {
          alert(`Pipeline enqueued: ${data.enqueued} jobs (${data.pipeline?.map((p: any) => p.type).join(', ')})`);
        }
        return;
      }

      // Special handling for export_statistics - enqueue ALL statistics exports (General + Overview + Countries)
      // via the same cron endpoint used for automated runs, but bypassing the time window.
      if (schedule.key === 'export_statistics') {
        const res = await fetch('/api/cron/export-statistics-fixed?debug=1&manual=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || 'Failed to enqueue exports');
        }

        const data = await res.json();
        if (data.skipped) {
          alert(`Export skipped: ${data.reason}`);
        } else {
          alert(`Exports enqueued: ${data.enqueued} jobs (General + Overview + Countries)`);
        }
        return;
      }
      
      // Map schedule key to job type
      const jobTypeMap: Record<string, string> = {
        check_stock_fix: 'check_stock_fix',
        scrape_statistics: 'scrape_statistics',
        scrape_purchase_orders: 'scrape_purchase_orders',
        scrape_top_styles: 'scrape_top_styles',
        export_statistics: 'export_overview',
        weekly_customer_sync: 'scrape_customers',
      };
      
      const jobType = jobTypeMap[schedule.key];
      if (!jobType) {
        alert('Unknown job type');
        return;
      }

      // Build payload with appropriate toggles
      let payload: Record<string, any> = { requestedBy: 'manual_dashboard', ...schedule.config };
      
      // For scrape_statistics, add the toggles for deep mode
      if (schedule.key === 'scrape_statistics') {
        payload.toggles = { 
          deep: true,
          style_details: withStyleDetails 
        };
      }
      
      // For scrape_top_styles, auto-export the PDF after the scrape completes
      if (schedule.key === 'scrape_top_styles') {
        payload.autoExport = true;
      }

      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: jobType, payload }),
      });
      
      if (!res.ok) throw new Error('Failed to enqueue');
      const data = await res.json();
      alert(`Job enqueued: ${data.jobId || 'success'}`);
    } catch (e: any) {
      alert('Failed to run job: ' + (e?.message || 'Unknown error'));
    } finally {
      setRunningJob(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <RefreshCw className="h-6 w-6 animate-spin mx-auto text-slate-400" />
          <div className="text-slate-400 text-sm mt-2">Loading schedules...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Scrape Schedules
          </CardTitle>
          <CardDescription>
            Configure when automated data scrapes run. All times are in Copenhagen timezone (DST-safe).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Name</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead className="w-[160px]">Last Run</TableHead>
                  <TableHead className="w-[180px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map(schedule => {
                  const jobStatus = jobStatuses[schedule.key];
                  const isJobRunning = jobStatus?.status === 'running';
                  const isJobQueued = jobStatus?.status === 'queued';
                  const isJobFailed = jobStatus?.status === 'failed';
                  const elapsedTime = elapsedTimes[schedule.key];
                  
                  return (
                  <React.Fragment key={schedule.id}>
                    <TableRow className={editingId === schedule.id ? 'bg-slate-50' : ''}>
                      <TableCell>
                        <div className="font-medium">{schedule.name}</div>
                        {schedule.description && (
                          <div className="text-xs text-slate-500 mt-0.5">{schedule.description}</div>
                        )}
                        {/* Show running indicator under name */}
                        {(isJobRunning || isJobQueued) && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                            <span className="text-xs text-blue-600">
                              {isJobQueued ? 'Queued...' : `Running${elapsedTime ? ` (${elapsedTime})` : '...'}`}
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-slate-400" />
                          <span className="text-sm">{formatScrapeSchedule(schedule)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={schedule.enabled ? 'bg-green-100 text-green-800 border-green-200' : 'bg-slate-100 text-slate-600 border-slate-200'}
                        >
                          {schedule.enabled ? 'Active' : 'Disabled'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {jobStatus ? (
                          <div className="space-y-0.5">
                            <div className="text-xs text-slate-600">
                              {formatLastRunTime(jobStatus.finished_at || jobStatus.started_at)}
                            </div>
                            {jobStatus.status === 'succeeded' && (
                              <Badge className="bg-green-50 text-green-700 border-green-200 text-[10px] py-0">
                                Success
                              </Badge>
                            )}
                            {isJobFailed && (
                              <Badge className="bg-red-50 text-red-700 border-red-200 text-[10px] py-0" title={jobStatus.error || 'Unknown error'}>
                                Failed
                              </Badge>
                            )}
                            {jobStatus.status === 'cancelled' && (
                              <Badge className="bg-slate-50 text-slate-600 border-slate-200 text-[10px] py-0">
                                Cancelled
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => runNow(schedule)}
                            disabled={runningJob === schedule.id}
                            title="Run now"
                          >
                            {runningJob === schedule.id ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </Button>
                          {/* Show "Run with Style Details" button for scrape_statistics */}
                          {schedule.key === 'scrape_statistics' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => runNow(schedule, true)}
                              disabled={runningJob === schedule.id}
                              title="Run with Style Details (full deep scrape)"
                              className="text-xs"
                            >
                              {runningJob === schedule.id ? (
                                <RefreshCw className="h-3 w-3 animate-spin" />
                              ) : (
                                <>+ Details</>
                              )}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => editingId === schedule.id ? cancelEdit() : startEdit(schedule)}
                          >
                            {editingId === schedule.id ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                          </Button>
                          <Button
                            size="sm"
                            variant={schedule.enabled ? 'outline' : 'default'}
                            onClick={() => toggleEnabled(schedule)}
                            disabled={saving === schedule.id}
                          >
                            {saving === schedule.id ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : schedule.enabled ? (
                              'Disable'
                            ) : (
                              'Enable'
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {editingId === schedule.id && (
                      <TableRow className="bg-slate-50">
                        <TableCell colSpan={4} className="p-4">
                          <div className="space-y-4">
                            {/* Hours selection */}
                            <div>
                              <label className="text-sm font-medium text-slate-700 block mb-2">
                                Run at hours (Copenhagen time):
                              </label>
                              <div className="flex flex-wrap gap-1">
                                {HOURS_OPTIONS.map(opt => (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => toggleHour(opt.value)}
                                    className={`px-2 py-1 text-xs rounded border transition-colors ${
                                      editHours.includes(opt.value)
                                        ? 'bg-blue-600 text-white border-blue-600'
                                        : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                                    }`}
                                  >
                                    {opt.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            
                            {/* Minute offset */}
                            <div>
                              <label className="text-sm font-medium text-slate-700 block mb-2">
                                Minute offset (e.g., 30 for :30):
                              </label>
                              <input
                                type="number"
                                min="0"
                                max="59"
                                value={editMinuteOffset}
                                onChange={e => setEditMinuteOffset(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                                className="w-20 px-2 py-1 text-sm border rounded"
                              />
                            </div>
                            
                            {/* Days selection */}
                            <div>
                              <label className="text-sm font-medium text-slate-700 block mb-2">
                                Days of week:
                              </label>
                              <div className="flex gap-2 items-center">
                                <button
                                  type="button"
                                  onClick={() => setEditDays(null)}
                                  className={`px-3 py-1 text-xs rounded border transition-colors ${
                                    editDays === null
                                      ? 'bg-blue-600 text-white border-blue-600'
                                      : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                                  }`}
                                >
                                  Every day
                                </button>
                                <span className="text-slate-400 text-xs">or specific:</span>
                                {DAYS_OPTIONS.map(opt => (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => toggleDay(opt.value)}
                                    className={`px-2 py-1 text-xs rounded border transition-colors ${
                                      editDays?.includes(opt.value)
                                        ? 'bg-blue-600 text-white border-blue-600'
                                        : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                                    }`}
                                  >
                                    {opt.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            
                            {/* Save/Cancel */}
                            <div className="flex gap-2 pt-2">
                              <Button size="sm" onClick={() => saveEdit(schedule)} disabled={saving === schedule.id || editHours.length === 0}>
                                {saving === schedule.id ? <RefreshCw className="h-4 w-4 animate-spin mr-1" /> : null}
                                Save Changes
                              </Button>
                              <Button size="sm" variant="outline" onClick={cancelEdit}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          
          <div className="mt-4 p-3 bg-slate-50 rounded-md border border-slate-200">
            <h4 className="text-sm font-medium text-slate-700 mb-1">How it works</h4>
            <p className="text-xs text-slate-500">
              Schedules are checked every 5 minutes by Vercel cron. When a check runs during a configured time window 
              (first 10 minutes of each hour), the corresponding job is enqueued. This ensures correct timing regardless 
              of Daylight Saving Time changes.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// EMAIL SCHEDULE TAB COMPONENT
// ============================================================================

function ScheduleTab() {
  const [schedules, setSchedules] = React.useState<EmailSendSchedule[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [wizardStep, setWizardStep] = React.useState(1);
  const [editingSchedule, setEditingSchedule] = React.useState<EmailSendSchedule | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  // Wizard form state - Step 1: When
  const [wName, setWName] = React.useState('');
  const [wDays, setWDays] = React.useState<Set<number>>(new Set([1])); // Mon default
  const [wTime, setWTime] = React.useState('09:00');
  const [wScrapeFirst, setWScrapeFirst] = React.useState(false);
  const [wEndDate, setWEndDate] = React.useState('');

  // Wizard form state - Step 2: What
  const [wRecipientType, setWRecipientType] = React.useState<'salespersons' | 'email_list'>('salespersons');
  const [wSalespersons, setWSalespersons] = React.useState<Set<string>>(new Set());
  const [wEmails, setWEmails] = React.useState<string[]>([]);
  const [wIncludeCountries, setWIncludeCountries] = React.useState(true);
  const [wIncludeTop15Salesmen, setWIncludeTop15Salesmen] = React.useState(true);
  const [wIncludeTop15Overall, setWIncludeTop15Overall] = React.useState(false);
  const [wIncludeOverview, setWIncludeOverview] = React.useState(false);
  const [wIncludeGeneralCombined, setWIncludeGeneralCombined] = React.useState(false);
  const [wStockLists, setWStockLists] = React.useState<Set<string>>(new Set());

  // Load salespersons
  const { data: salespersons } = useSWR('salespersons:list', async () => {
    const { data, error } = await supabase.from('salespersons').select('id, name, email').order('sort_index', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string; email?: string | null }>;
  });

  // Load stock lists
  const { data: stockListsAll } = useSWR('stock-lists:names', async () => {
    const { data, error } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string }>;
  });

  // Load schedules from app_settings
  const loadSchedules = React.useCallback(async () => {
    try {
      const { data } = await supabase.from('app_settings').select('id, value').eq('key', 'email_send_schedules').maybeSingle();
      const val = ((data?.value as any) || {}) as { schedules?: EmailSendSchedule[] };
      if (val.schedules) setSchedules(val.schedules);
    } catch (e: any) {
      console.error('Failed to load email send schedules:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  // Save schedules to app_settings
  const saveSchedules = async (updated: EmailSendSchedule[]) => {
    const { data: existing } = await supabase.from('app_settings').select('id').eq('key', 'email_send_schedules').maybeSingle();
    if (existing?.id) {
      await supabase.from('app_settings').update({ value: { schedules: updated } }).eq('id', existing.id);
    } else {
      await supabase.from('app_settings').insert({ key: 'email_send_schedules', value: { schedules: updated } } as any);
    }
    setSchedules(updated);
  };

  const openNewSchedule = () => {
    setEditingSchedule(null);
    resetWizardForm();
    setWizardStep(1);
    setWizardOpen(true);
  };

  const openEditSchedule = (schedule: EmailSendSchedule) => {
    setEditingSchedule(schedule);
    setWName(schedule.name);
    setWDays(new Set(schedule.days));
    setWTime(schedule.time);
    setWScrapeFirst(schedule.scrapeFirst);
    setWEndDate(schedule.endDate || '');
    setWRecipientType(schedule.recipientType);
    setWSalespersons(new Set(schedule.salespersonIds));
    setWEmails([...schedule.emails]);
    setWIncludeCountries(schedule.include.countries);
    setWIncludeTop15Salesmen(schedule.include.top15Salesmen);
    setWIncludeTop15Overall(schedule.include.top15Overall);
    setWIncludeOverview(schedule.include.overview);
    setWIncludeGeneralCombined(schedule.include.generalCombined);
    setWStockLists(new Set(schedule.stockLists));
    setWizardStep(1);
    setWizardOpen(true);
  };

  const resetWizardForm = () => {
    setWName('');
    setWDays(new Set([1]));
    setWTime('09:00');
    setWScrapeFirst(false);
    setWEndDate('');
    setWRecipientType('salespersons');
    setWSalespersons(new Set());
    setWEmails([]);
    setWIncludeCountries(true);
    setWIncludeTop15Salesmen(true);
    setWIncludeTop15Overall(false);
    setWIncludeOverview(false);
    setWIncludeGeneralCombined(false);
    setWStockLists(new Set());
  };

  const handleSaveSchedule = async () => {
    if (!wName.trim()) {
      alert('Please enter a schedule name');
      return;
    }
    if (wDays.size === 0) {
      alert('Please select at least one day');
      return;
    }
    if (wRecipientType === 'salespersons' && wSalespersons.size === 0) {
      alert('Please select at least one salesperson');
      return;
    }
    if (wRecipientType === 'email_list' && wEmails.length === 0) {
      alert('Please add at least one email address');
      return;
    }

    setSaving(true);
    try {
      const newSchedule: EmailSendSchedule = {
        id: editingSchedule?.id || generateId(),
        name: wName.trim(),
        enabled: editingSchedule?.enabled ?? true,
        days: Array.from(wDays).sort((a, b) => a - b),
        time: wTime,
        scrapeFirst: wScrapeFirst,
        endDate: wEndDate || undefined,
        recipientType: wRecipientType,
        salespersonIds: Array.from(wSalespersons),
        emails: wEmails,
        include: {
          countries: wIncludeCountries,
          top15Salesmen: wIncludeTop15Salesmen,
          top15Overall: wIncludeTop15Overall,
          overview: wIncludeOverview,
          generalCombined: wIncludeGeneralCombined,
        },
        stockLists: Array.from(wStockLists),
        lastRun: editingSchedule?.lastRun,
        createdAt: editingSchedule?.createdAt || new Date().toISOString(),
      };

      const updated = editingSchedule
        ? schedules.map(s => s.id === editingSchedule.id ? newSchedule : s)
        : [...schedules, newSchedule];

      await saveSchedules(updated);
      setWizardOpen(false);
      resetWizardForm();
    } catch (e: any) {
      console.error('Failed to save schedule:', e);
      alert(`Failed to save schedule: ${e?.message || 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleScheduleEnabled = async (schedule: EmailSendSchedule) => {
    setTogglingId(schedule.id);
    try {
      const updated = schedules.map(s => s.id === schedule.id ? { ...s, enabled: !s.enabled } : s);
      await saveSchedules(updated);
    } catch (e: any) {
      console.error('Failed to toggle schedule:', e);
      alert(`Failed to toggle schedule: ${e?.message || 'Unknown error'}`);
    } finally {
      setTogglingId(null);
    }
  };

  const deleteSchedule = async (schedule: EmailSendSchedule) => {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    setDeletingId(schedule.id);
    try {
      const updated = schedules.filter(s => s.id !== schedule.id);
      await saveSchedules(updated);
    } catch (e: any) {
      console.error('Failed to delete schedule:', e);
      alert(`Failed to delete schedule: ${e?.message || 'Unknown error'}`);
    } finally {
      setDeletingId(null);
    }
  };

  const runScheduleNow = async (schedule: EmailSendSchedule) => {
    if (!confirm(`Run schedule "${schedule.name}" now?`)) return;
    try {
      const res = await fetch(`/api/cron/send-email-schedules?force=${schedule.id}`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to trigger schedule');
      const data = await res.json();
      alert(data.message || 'Schedule triggered successfully');
    } catch (e: any) {
      console.error('Failed to run schedule:', e);
      alert(`Failed to run schedule: ${e?.message || 'Unknown error'}`);
    }
  };

  const formatDays = (days: number[]): string => {
    if (days.length === 7) return 'Every day';
    return days
      .sort((a, b) => a - b)
      .map(d => DAYS_OF_WEEK.find(day => day.value === d)?.label || '')
      .filter(Boolean)
      .join(', ');
  };

  const formatRecipients = (schedule: EmailSendSchedule): string => {
    if (schedule.recipientType === 'salespersons') {
      const count = schedule.salespersonIds.length;
      return `${count} salesperson${count !== 1 ? 's' : ''}`;
    } else {
      const count = schedule.emails.length;
      return `${count} email${count !== 1 ? 's' : ''}`;
    }
  };

  const formatIncludes = (schedule: EmailSendSchedule): string[] => {
    const items: string[] = [];
    if (schedule.include.countries) items.push('Countries');
    if (schedule.include.top15Salesmen) items.push('Top 15 Salesmen');
    if (schedule.include.top15Overall) items.push('Top 15 Overall');
    if (schedule.include.overview) items.push('Overview');
    if (schedule.include.generalCombined) items.push('General Combined');
    if (schedule.stockLists.length > 0) items.push(`${schedule.stockLists.length} stock list${schedule.stockLists.length !== 1 ? 's' : ''}`);
    return items;
  };

  const canProceedToStep2 = () => {
    return wName.trim() !== '' && wDays.size > 0;
  };

  const canProceedToStep3 = () => {
    if (wRecipientType === 'salespersons' && wSalespersons.size === 0) return false;
    if (wRecipientType === 'email_list' && wEmails.length === 0) return false;
    return true;
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <div className="text-slate-400 text-sm">Loading schedules...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Email Send Schedules</CardTitle>
            <CardDescription>Configure automated email send-outs with statistics and stock lists</CardDescription>
          </div>
          <Button size="sm" onClick={openNewSchedule}>
            <Plus className="h-4 w-4 mr-1" />
            New Schedule
          </Button>
        </CardHeader>
        <CardContent>
          {schedules.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm">
              No email send schedules configured yet. Create one to get started.
            </div>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">On/Off</TableHead>
                    <TableHead className="w-[180px]">Name</TableHead>
                    <TableHead className="w-[120px]">Recipients</TableHead>
                    <TableHead className="w-[180px]">Schedule</TableHead>
                    <TableHead className="w-[100px]">Scrape First</TableHead>
                    <TableHead className="w-[100px]">End Date</TableHead>
                    <TableHead>Includes</TableHead>
                    <TableHead className="w-[140px]">Last Run</TableHead>
                    <TableHead className="w-[140px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map(schedule => (
                    <TableRow key={schedule.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => toggleScheduleEnabled(schedule)}
                          disabled={togglingId === schedule.id}
                          className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors ${
                            schedule.enabled ? 'bg-slate-900' : 'bg-slate-200'
                          } ${togglingId === schedule.id ? 'opacity-50' : ''}`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                              schedule.enabled ? 'translate-x-4' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-sm">{schedule.name}</div>
                        <div className="text-xs text-slate-500 capitalize">{schedule.recipientType.replace('_', ' ')}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{formatRecipients(schedule)}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-slate-400" />
                          <div className="text-sm">
                            <div>{formatDays(schedule.days)}</div>
                            <div className="text-xs text-slate-500">at {schedule.time}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {schedule.scrapeFirst ? (
                          <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-xs">Yes</Badge>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-600 border-slate-200 text-xs">No</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {schedule.endDate ? (
                          <div className="text-xs text-slate-600">
                            {new Date(schedule.endDate).toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {formatIncludes(schedule).map((item, idx) => (
                            <Badge key={idx} className="border border-slate-300 bg-white text-slate-700 text-xs">
                              {item}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs text-slate-600">
                          {formatLastRun(schedule.lastRun)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => runScheduleNow(schedule)}
                            title="Run now"
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openEditSchedule(schedule)}
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteSchedule(schedule)}
                            disabled={deletingId === schedule.id}
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Wizard Modal */}
      <Sheet open={wizardOpen} onOpenChange={setWizardOpen}>
        <SheetContent className="sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {editingSchedule ? 'Edit Schedule' : 'New Schedule'} - Step {wizardStep} of 3
            </SheetTitle>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            {/* Step indicators */}
            <div className="flex items-center justify-between">
              {[1, 2, 3].map(step => (
                <div key={step} className="flex items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      wizardStep === step
                        ? 'bg-blue-600 text-white'
                        : wizardStep > step
                        ? 'bg-green-600 text-white'
                        : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {step}
                  </div>
                  {step < 3 && <div className="w-16 h-0.5 bg-slate-200 mx-2" />}
                </div>
              ))}
            </div>

            {/* Step 1: When */}
            {wizardStep === 1 && (
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-900">When to send?</h3>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Schedule name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={wName}
                    onChange={e => setWName(e.target.value)}
                    placeholder="e.g., Weekly Friday Report"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Days <span className="text-red-500">*</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {DAYS_OF_WEEK.map(day => (
                      <button
                        key={day.value}
                        type="button"
                        onClick={() => {
                          const newDays = new Set(wDays);
                          if (newDays.has(day.value)) {
                            newDays.delete(day.value);
                          } else {
                            newDays.add(day.value);
                          }
                          setWDays(newDays);
                        }}
                        className={`px-4 py-2 text-sm rounded border transition-colors ${
                          wDays.has(day.value)
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                        }`}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Time (Copenhagen timezone) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="time"
                    value={wTime}
                    onChange={e => setWTime(e.target.value)}
                    className="px-3 py-2 border border-slate-300 rounded-md text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    End date (optional)
                  </label>
                  <input
                    type="date"
                    value={wEndDate}
                    onChange={e => setWEndDate(e.target.value)}
                    className="px-3 py-2 border border-slate-300 rounded-md text-sm"
                  />
                  <div className="text-xs text-slate-500 mt-1">
                    Schedule will automatically disable after this date
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-md">
                  <button
                    type="button"
                    onClick={() => setWScrapeFirst(!wScrapeFirst)}
                    className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors ${
                      wScrapeFirst ? 'bg-slate-900' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                        wScrapeFirst ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  <div>
                    <div className="text-sm font-medium text-slate-700">Scrape before sending</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Ensure data is fresh by scraping statistics and stock lists before sending emails
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setWizardOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => setWizardStep(2)} disabled={!canProceedToStep2()}>
                    Next
                  </Button>
                </div>
              </div>
            )}

            {/* Step 2: What to send */}
            {wizardStep === 2 && (
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-900">What to send?</h3>

                {/* Recipient type selection */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Recipient type <span className="text-red-500">*</span>
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setWRecipientType('salespersons')}
                      className={`flex-1 px-4 py-2 text-sm rounded border transition-colors ${
                        wRecipientType === 'salespersons'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                      }`}
                    >
                      Salespersons
                    </button>
                    <button
                      type="button"
                      onClick={() => setWRecipientType('email_list')}
                      className={`flex-1 px-4 py-2 text-sm rounded border transition-colors ${
                        wRecipientType === 'email_list'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                      }`}
                    >
                      Email List
                    </button>
                  </div>
                  <div className="mt-2 text-xs text-slate-500 bg-slate-50 p-2 rounded">
                    Note: Each schedule can only use one recipient type. To send to both salespersons and an email list at the same time, create two separate schedules.
                  </div>
                </div>

                {/* Recipients selection based on type */}
                {wRecipientType === 'salespersons' ? (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Select salespersons <span className="text-red-500">*</span>
                    </label>
                    <div className="border border-slate-300 rounded-md p-3 max-h-[200px] overflow-y-auto space-y-2">
                      {(salespersons ?? []).map(sp => (
                        <label key={sp.id} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={wSalespersons.has(sp.id)}
                            onChange={() => {
                              const newSet = new Set(wSalespersons);
                              if (newSet.has(sp.id)) {
                                newSet.delete(sp.id);
                              } else {
                                newSet.add(sp.id);
                              }
                              setWSalespersons(newSet);
                            }}
                            className="rounded"
                          />
                          <span className="text-sm">{sp.name}</span>
                          {sp.email && <span className="text-xs text-slate-500">({sp.email})</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Email addresses <span className="text-red-500">*</span>
                    </label>
                    <EmailPillsInput
                      value={wEmails}
                      onChange={setWEmails}
                      placeholder="Enter email addresses"
                    />
                  </div>
                )}

                {/* PDFs to include */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Statistics PDFs to include
                  </label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={wIncludeCountries}
                        onChange={() => setWIncludeCountries(!wIncludeCountries)}
                        className="rounded"
                      />
                      <span className="text-sm">Countries</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={wIncludeTop15Salesmen}
                        onChange={() => setWIncludeTop15Salesmen(!wIncludeTop15Salesmen)}
                        className="rounded"
                      />
                      <span className="text-sm">Top 15 Salesmen</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={wIncludeTop15Overall}
                        onChange={() => setWIncludeTop15Overall(!wIncludeTop15Overall)}
                        className="rounded"
                      />
                      <span className="text-sm">Top 15 Overall</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={wIncludeOverview}
                        onChange={() => setWIncludeOverview(!wIncludeOverview)}
                        className="rounded"
                      />
                      <span className="text-sm">Overview</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={wIncludeGeneralCombined}
                        onChange={() => setWIncludeGeneralCombined(!wIncludeGeneralCombined)}
                        className="rounded"
                      />
                      <span className="text-sm">General Combined</span>
                    </label>
                  </div>
                </div>

                {/* Stock lists */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Stock lists (optional)
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {(stockListsAll ?? []).map(list => {
                      const selected = wStockLists.has(list.name);
                      return (
                        <button
                          key={list.id}
                          type="button"
                          onClick={() => {
                            const newSet = new Set(wStockLists);
                            if (selected) {
                              newSet.delete(list.name);
                            } else {
                              newSet.add(list.name);
                            }
                            setWStockLists(newSet);
                          }}
                          className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                            selected
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400'
                          }`}
                        >
                          {list.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex justify-between gap-2 pt-4">
                  <Button variant="outline" onClick={() => setWizardStep(1)}>
                    Back
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setWizardOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={() => setWizardStep(3)} disabled={!canProceedToStep3()}>
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Step 3: Review */}
            {wizardStep === 3 && (
              <div className="space-y-4">
                <h3 className="font-semibold text-slate-900">Review & Save</h3>

                <div className="space-y-3 bg-slate-50 p-4 rounded-md text-sm">
                  <div>
                    <div className="font-medium text-slate-700">Schedule Name</div>
                    <div className="text-slate-900">{wName}</div>
                  </div>

                  <div>
                    <div className="font-medium text-slate-700">Schedule</div>
                    <div className="text-slate-900">
                      {formatDays(Array.from(wDays))} at {wTime} (Copenhagen time)
                    </div>
                  </div>

                  <div>
                    <div className="font-medium text-slate-700">Scrape Before Sending</div>
                    <div className="text-slate-900">{wScrapeFirst ? 'Yes' : 'No'}</div>
                  </div>

                  {wEndDate && (
                    <div>
                      <div className="font-medium text-slate-700">End Date</div>
                      <div className="text-slate-900">
                        {new Date(wEndDate).toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="font-medium text-slate-700">Recipient Type</div>
                    <div className="text-slate-900 capitalize">{wRecipientType.replace('_', ' ')}</div>
                  </div>

                  <div>
                    <div className="font-medium text-slate-700">Recipients</div>
                    <div className="text-slate-900">
                      {wRecipientType === 'salespersons' ? (
                        <div className="space-y-1">
                          {Array.from(wSalespersons).map(id => {
                            const sp = salespersons?.find(s => s.id === id);
                            return <div key={id}>{sp?.name || id}</div>;
                          })}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {wEmails.map((email, idx) => (
                            <div key={idx}>{email}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="font-medium text-slate-700">Statistics PDFs</div>
                    <div className="text-slate-900">
                      {[
                        wIncludeCountries && 'Countries',
                        wIncludeTop15Salesmen && 'Top 15 Salesmen',
                        wIncludeTop15Overall && 'Top 15 Overall',
                        wIncludeOverview && 'Overview',
                        wIncludeGeneralCombined && 'General Combined',
                      ].filter(Boolean).join(', ') || 'None'}
                    </div>
                  </div>

                  {wStockLists.size > 0 && (
                    <div>
                      <div className="font-medium text-slate-700">Stock Lists</div>
                      <div className="text-slate-900">{Array.from(wStockLists).join(', ')}</div>
                    </div>
                  )}
                </div>

                <div className="flex justify-between gap-2 pt-4">
                  <Button variant="outline" onClick={() => setWizardStep(2)}>
                    Back
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setWizardOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleSaveSchedule} disabled={saving}>
                      {saving ? 'Saving...' : editingSchedule ? 'Update Schedule' : 'Create Schedule'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ============================================================================
// MAIN DASHBOARD COMPONENT
// ============================================================================

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
  const [runningPipelineScheduleId, setRunningPipelineScheduleId] = React.useState<string | null>(null);
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
  const [stFormSendToSalespersons, setStFormSendToSalespersons] = React.useState(true);
  const [stFormSendToOverall, setStFormSendToOverall] = React.useState(false);
  const [stFormOverallRecipientsCsv, setStFormOverallRecipientsCsv] = React.useState('');

  // ============================================================================
  // SEND OUT SECTION STATE
  // ============================================================================
  const [sendOutSalespersons, setSendOutSalespersons] = React.useState<Set<string>>(new Set());
  const [sendOutEmailList, setSendOutEmailList] = React.useState<string[]>([]);
  const [sendOutRecipientMode, setSendOutRecipientMode] = React.useState<'salespersons' | 'email_list'>('salespersons');
  const [sendOutIncludeCountries, setSendOutIncludeCountries] = React.useState(true);
  const [sendOutIncludeTop15Salesmen, setSendOutIncludeTop15Salesmen] = React.useState(true);
  const [sendOutIncludeTop15Overall, setSendOutIncludeTop15Overall] = React.useState(false);
  const [sendOutIncludeOverview, setSendOutIncludeOverview] = React.useState(false);
  const [sendOutIncludeGeneralCombined, setSendOutIncludeGeneralCombined] = React.useState(false);
  const [sendOutStockLists, setSendOutStockLists] = React.useState<Set<string>>(new Set());
  const [sendOutScrapeFirst, setSendOutScrapeFirst] = React.useState(false);
  const [sendOutSending, setSendOutSending] = React.useState(false);
  const [sendOutLastJobId, setSendOutLastJobId] = React.useState<string | null>(null);
  const [sendOutJob, setSendOutJob] = React.useState<JobStatus | null>(null);
  const [sendOutElapsed, setSendOutElapsed] = React.useState<string>('');

  // Persisted "send-out email list" (separate recipient group from salespersons)
  useSWR('dashboard:sendout_email_list', async () => {
    const { data } = await supabase
      .from('app_settings')
      .select('id, value')
      .eq('key', 'sendout_email_list')
      .maybeSingle();
    const val = ((data?.value as any) || {}) as { emails?: string[]; enabled?: boolean };
    if (Array.isArray(val.emails)) setSendOutEmailList(val.emails);
    if (typeof val.enabled === 'boolean') {
      setSendOutRecipientMode(val.enabled ? 'email_list' : 'salespersons');
    }
    return data;
  });

  const saveSendOutEmailListTimer = React.useRef<any>(null);
  async function saveSendOutEmailList(next: { emails: string[]; enabled: boolean }) {
    try {
      const value = { emails: next.emails, enabled: next.enabled };
      const { data: existing } = await supabase
        .from('app_settings')
        .select('id')
        .eq('key', 'sendout_email_list')
        .maybeSingle();
      if (existing?.id) await supabase.from('app_settings').update({ value }).eq('id', existing.id);
      else await supabase.from('app_settings').insert({ key: 'sendout_email_list', value } as any);
    } catch {}
  }

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
    setStFormSendToSalespersons(true);
    setStFormSendToOverall(false);
    setStFormOverallRecipientsCsv('');
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
    setStFormSendToSalespersons(schedule.sendToSalespersons !== false);
    setStFormSendToOverall(schedule.sendToOverall === true);
    setStFormOverallRecipientsCsv(schedule.overallRecipientsCsv || '');
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
    // Validate that at least one delivery mode is configured
    const hasSalespersonRecipients = stFormSendToSalespersons && stFormSalespersons.size > 0;
    const hasOverallRecipients = stFormSendToOverall && stFormOverallRecipientsCsv.trim().length > 0;
    const hasLegacyRecipients = stFormAdditionalRecipients.length > 0;
    if (!hasSalespersonRecipients && !hasOverallRecipients && !hasLegacyRecipients) {
      alert('Please configure at least one delivery option (salespersons or overall recipients)');
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
      sendToSalespersons: stFormSendToSalespersons,
      sendToOverall: stFormSendToOverall,
      overallRecipientsCsv: stFormOverallRecipientsCsv.trim(),
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

  async function handleRunPipelineNow(schedule: StatisticSchedule) {
    if (runningPipelineScheduleId) return;
    setRunningPipelineScheduleId(schedule.id);
    try {
      const res = await fetch('/api/statistics/run-email-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleId: schedule.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Failed to start pipeline: ${data.error || 'Unknown error'}`);
        return;
      }
      alert(`Pipeline started! Job ID: ${data.jobId}\n\nView progress at /admin/jobs/${data.jobId}`);
    } catch (err: any) {
      alert(`Error: ${err?.message || 'Failed to start pipeline'}`);
    } finally {
      setRunningPipelineScheduleId(null);
    }
  }

  // ============================================================================
  // SEND OUT HANDLER
  // ============================================================================
  async function handleSendOut() {
    if (sendOutSending) return;

    // Validate: must have at least one recipient
    const selectedSalespersonIds = Array.from(sendOutSalespersons);
    const emailList = sendOutEmailList;

    if (sendOutRecipientMode === 'salespersons') {
      if (selectedSalespersonIds.length === 0) {
        alert('Please select at least one salesperson');
        return;
      }
    }
    if (sendOutRecipientMode === 'email_list') {
      if (emailList.length === 0) {
        alert('Please add at least one email to the email list');
        return;
      }
    }

    // Validate: must have either statistics PDFs or stock lists selected
    const hasStatistics = sendOutIncludeCountries || sendOutIncludeTop15Salesmen || 
                          sendOutIncludeTop15Overall || sendOutIncludeOverview || 
                          sendOutIncludeGeneralCombined || (sendOutRecipientMode === 'salespersons' && selectedSalespersonIds.length > 0);
    const hasStockLists = sendOutStockLists.size > 0;

    if (!hasStatistics && !hasStockLists) {
      alert('Please select at least one statistics PDF or stock list to send');
      return;
    }

    setSendOutSending(true);
    setSendOutLastJobId(null);
    setSendOutJob(null);

    try {
      const res = await fetch('/api/statistics/send-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scrapeFirst: sendOutScrapeFirst,
          salespersonIds: sendOutRecipientMode === 'salespersons' ? selectedSalespersonIds : [],
          emails: sendOutRecipientMode === 'email_list' ? emailList : [],
          include: {
            countries: sendOutIncludeCountries,
            top15Salesmen: sendOutIncludeTop15Salesmen,
            top15Overall: sendOutIncludeTop15Overall,
            overview: sendOutIncludeOverview,
            generalCombined: sendOutIncludeGeneralCombined,
          },
          stockLists: Array.from(sendOutStockLists),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Failed to start send out: ${data.error || 'Unknown error'}`);
        return;
      }
      setSendOutLastJobId(data.jobId);
      setSendOutJob({
        id: data.jobId,
        type: 'run_manual_sendout_pipeline',
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        error: null,
      });
      alert(`Send out queued! Job ID: ${data.jobId}\n\n${sendOutScrapeFirst ? 'Will scrape + export first, then send.' : 'Will send using latest exports.'}\n\nView progress in Settings → Jobs`);
    } catch (err: any) {
      alert(`Error: ${err?.message || 'Failed to start send out'}`);
    } finally {
      setSendOutSending(false);
    }
  }

  const fetchSendOutJob = React.useCallback(async (jobId: string) => {
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select('id, type, status, created_at, started_at, finished_at, error, payload')
        .eq('id', jobId)
        .maybeSingle();
      if (error) return;
      if (data?.id) setSendOutJob(data as any);
    } catch {}
  }, []);

  React.useEffect(() => {
    if (!sendOutLastJobId) return;
    fetchSendOutJob(sendOutLastJobId);
  }, [sendOutLastJobId, fetchSendOutJob]);

  React.useEffect(() => {
    if (!sendOutLastJobId) return;
    if (!sendOutJob || (sendOutJob.status !== 'queued' && sendOutJob.status !== 'running')) return;
    const t = setInterval(() => fetchSendOutJob(sendOutLastJobId), 5000);
    return () => clearInterval(t);
  }, [sendOutLastJobId, sendOutJob, fetchSendOutJob]);

  React.useEffect(() => {
    if (!sendOutJob) {
      setSendOutElapsed('');
      return;
    }
    const tick = () => {
      const base = sendOutJob.started_at || sendOutJob.created_at;
      const elapsed = formatElapsedTime(base);
      setSendOutElapsed(elapsed);
    };
    tick();
    if (sendOutJob.status !== 'queued' && sendOutJob.status !== 'running') return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [sendOutJob]);

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
          <TabsTrigger value="scrapes">Scrapes</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
        </TabsList>

        <TabsContent value="mailing" className="space-y-6">
          {/* Stock List Schedules */}
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
                                className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
                                onClick={() => handleRunPipelineNow(schedule)}
                                disabled={runningPipelineScheduleId === schedule.id}
                                title="Run pipeline (scrape + export + send)"
                              >
                                <Play className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => handleSendStatisticNow(schedule)}
                                disabled={sendingStatisticScheduleId === schedule.id}
                                title="Send now (using existing exports)"
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

          {/* Send Out Section */}
          <Card>
            <CardHeader>
              <CardTitle>Send out</CardTitle>
              <CardDescription>Manually send statistics and stock lists to recipients</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Recipients (two tabs to avoid confusion) */}
              <Tabs
                value={sendOutRecipientMode}
                onValueChange={(v) => {
                  const nextMode = (v as any) as 'salespersons' | 'email_list';
                  setSendOutRecipientMode(nextMode);
                  // Keep persisted toggle for backwards compatibility + default next time
                  if (saveSendOutEmailListTimer.current) clearTimeout(saveSendOutEmailListTimer.current);
                  saveSendOutEmailListTimer.current = setTimeout(
                    () => saveSendOutEmailList({ emails: sendOutEmailList, enabled: nextMode === 'email_list' }),
                    200
                  );
                  // Enforce exclusivity: switching to email list clears salespersons
                  if (nextMode === 'email_list') setSendOutSalespersons(new Set());
                }}
              >
                <TabsList className="w-full grid grid-cols-2">
                  <TabsTrigger value="salespersons">Salespersons</TabsTrigger>
                  <TabsTrigger value="email_list">Email list</TabsTrigger>
                </TabsList>

                <TabsContent value="salespersons" className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-gray-600 font-medium">Salespersons</label>
                    <button
                      type="button"
                      onClick={() => {
                        const allIds = (salespersons ?? []).filter(sp => sp.email).map(sp => sp.id);
                        const allSelected = allIds.every(id => sendOutSalespersons.has(id));
                        if (allSelected) setSendOutSalespersons(new Set());
                        else setSendOutSalespersons(new Set(allIds));
                      }}
                      className="text-xs text-slate-600 hover:text-slate-900"
                    >
                      {(salespersons ?? []).filter(sp => sp.email).every(sp => sendOutSalespersons.has(sp.id)) ? 'Deselect all' : 'Select all'}
                    </button>
                  </div>
                  <div className="max-h-40 overflow-auto rounded-md border">
                    <Table>
                      <TableBody>
                        {(salespersons ?? []).map((sp) => {
                          const hasEmail = Boolean(sp.email);
                          const on = sendOutSalespersons.has(sp.id);
                          return (
                            <TableRow
                              key={sp.id}
                              className={!hasEmail ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50'}
                              onClick={() => {
                                if (!hasEmail) return;
                                setSendOutSalespersons((prev) => {
                                  const n = new Set(prev);
                                  if (n.has(sp.id)) n.delete(sp.id);
                                  else n.add(sp.id);
                                  return n;
                                });
                              }}
                            >
                              <TableCell className="w-10 py-1.5">
                                <div className={`h-4 w-4 rounded border ${on ? 'bg-slate-900 border-slate-900' : 'bg-white border-slate-300'} flex items-center justify-center`}>
                                  {on && <span className="text-white text-[10px]">✓</span>}
                                </div>
                              </TableCell>
                              <TableCell className="font-medium text-sm py-1.5">{sp.name}</TableCell>
                              <TableCell className="text-xs text-gray-500 py-1.5">{sp.email || '(no email)'}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">Salespersons receive their personal PDF (individual emails)</p>
                </TabsContent>

                <TabsContent value="email_list" className="mt-4">
                  <EmailPillsInput
                    value={sendOutEmailList}
                    placeholder="Add email, press comma…"
                    helpText="Sends ONE email to all recipients (in To). These recipients receive ONLY the selected global PDFs. Saved for next time."
                    onChange={(next) => {
                      setSendOutEmailList(next);
                      if (saveSendOutEmailListTimer.current) clearTimeout(saveSendOutEmailListTimer.current);
                      saveSendOutEmailListTimer.current = setTimeout(
                        () => saveSendOutEmailList({ emails: next, enabled: true }),
                        600
                      );
                    }}
                  />
                </TabsContent>
              </Tabs>

              {/* Statistics PDFs Selection */}
              <div>
                <label className="text-sm text-gray-600 font-medium block mb-2">Statistics PDFs to include</label>
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
                  <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={sendOutIncludeCountries}
                        onChange={() => setSendOutIncludeCountries(v => !v)}
                        size="sm"
                      />
                      <span className="text-sm">Countries</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={sendOutIncludeTop15Salesmen}
                        onChange={() => setSendOutIncludeTop15Salesmen(v => !v)}
                        size="sm"
                      />
                      <span className="text-sm">Top 15 Salesmen</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={sendOutIncludeTop15Overall}
                        onChange={() => setSendOutIncludeTop15Overall(v => !v)}
                        size="sm"
                      />
                      <span className="text-sm">Top 15 Overall</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={sendOutIncludeOverview}
                        onChange={() => setSendOutIncludeOverview(v => !v)}
                        size="sm"
                      />
                      <span className="text-sm">Overview</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-md border bg-slate-50">
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={sendOutIncludeGeneralCombined}
                        onChange={() => setSendOutIncludeGeneralCombined(v => !v)}
                        size="sm"
                      />
                      <span className="text-sm">General Combined</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Stock Lists Selection */}
              {availableStockLists.length > 0 && (
                <div>
                  <label className="text-sm text-gray-600 font-medium block mb-2">Stock lists to send (separate email)</label>
                  <div className="flex flex-wrap gap-2">
                    {availableStockLists.map((l) => {
                      const on = sendOutStockLists.has(l.name);
                      const exp = latestStockListByName.get(l.name);
                      return (
                        <div key={l.id} className="flex items-center gap-1">
                          <Badge
                            className={`cursor-pointer select-none transition-colors ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white hover:bg-slate-50'}`}
                            onClick={() => {
                              setSendOutStockLists(prev => {
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
                  <p className="text-xs text-gray-500 mt-1">Stock lists are sent as a separate email (they can be heavy)</p>
                </div>
              )}

              {/* Scrape First + Send Button */}
              <div className="flex items-center justify-between pt-4 border-t">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 p-2 rounded-md border bg-slate-50">
                    <Toggle
                      checked={sendOutScrapeFirst}
                      onChange={() => setSendOutScrapeFirst(v => !v)}
                      size="sm"
                    />
                    <span className="text-sm font-medium">Scrape first</span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {sendOutScrapeFirst 
                      ? 'Will refresh statistics + stock lists before sending' 
                      : 'Will use latest available exports'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {sendOutLastJobId && (
                    <span className="text-xs text-gray-500">Last job: {sendOutLastJobId.slice(0, 8)}...</span>
                  )}
                  <Button 
                    onClick={handleSendOut}
                    disabled={sendOutSending}
                    className="min-w-[120px]"
                  >
                    <Send className="h-4 w-4 mr-2" />
                    {sendOutSending ? 'Sending…' : 'Send out'}
                  </Button>
                </div>
              </div>

              {/* Live status card with phase tracking and ETA */}
              {sendOutLastJobId && sendOutJob && (() => {
                const phaseInfo = getPhaseInfo(sendOutJob);
                const isActive = sendOutJob.status === 'queued' || sendOutJob.status === 'running';
                const scrapeFirst = sendOutJob.payload?.scrapeFirst || false;
                
                return (
                  <div className="rounded-md border bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-slate-900">Send out status</div>
                      <Badge 
                        className={`${
                          sendOutJob.status === 'succeeded' 
                            ? 'bg-green-100 text-green-800 border-green-200' 
                            : sendOutJob.status === 'failed'
                            ? 'bg-red-100 text-red-800 border-red-200'
                            : 'bg-blue-100 text-blue-800 border-blue-200'
                        }`}
                      >
                        {sendOutJob.status}
                      </Badge>
                    </div>

                    {/* Phase progress bar */}
                    {isActive && scrapeFirst && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-slate-700 font-medium">{phaseInfo.phaseLabel}</span>
                          <span className="text-slate-500">{phaseInfo.progress}%</span>
                        </div>
                        <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-blue-600 transition-all duration-500 ease-out"
                            style={{ width: `${phaseInfo.progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Stats grid */}
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div>
                        <div className="text-[11px] text-slate-500 mb-0.5">Queued</div>
                        <div className="font-mono text-slate-700">{formatLastRunTime(sendOutJob.created_at)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-slate-500 mb-0.5">Elapsed</div>
                        <div className="font-mono text-slate-700">{sendOutElapsed || '—'}</div>
                      </div>
                      {isActive && phaseInfo.eta && (
                        <div>
                          <div className="text-[11px] text-slate-500 mb-0.5">ETA</div>
                          <div className="font-mono text-blue-700 font-medium">{phaseInfo.eta}</div>
                        </div>
                      )}
                      <div>
                        <div className="text-[11px] text-slate-500 mb-0.5">Job ID</div>
                        <div className="font-mono text-slate-700">{sendOutJob.id.slice(0, 8)}…</div>
                      </div>
                    </div>

                    {/* Current phase detail (only for scrapeFirst) */}
                    {isActive && scrapeFirst && (
                      <div className="mt-3 flex items-center gap-2 text-xs">
                        <div className="flex items-center gap-1.5 text-slate-600">
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          <span>
                            {phaseInfo.phase === 'waiting_scrapes' && 'Fetching fresh data from sources...'}
                            {phaseInfo.phase === 'enqueue_exports' && 'Setting up PDF generation...'}
                            {phaseInfo.phase === 'waiting_exports' && 'Creating PDF documents...'}
                            {phaseInfo.phase === 'send_emails' && 'Preparing emails...'}
                            {phaseInfo.phase === 'init' && 'Starting pipeline...'}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Success message */}
                    {sendOutJob.status === 'succeeded' && (
                      <div className="mt-3 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1.5">
                        ✓ Send out completed successfully
                      </div>
                    )}

                    {/* Error message */}
                    {sendOutJob.status === 'failed' && sendOutJob.error && (
                      <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                        ✗ {sendOutJob.error}
                      </div>
                    )}
                  </div>
                );
              })()}
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

        <TabsContent value="scrapes">
          <ScrapesTab />
        </TabsContent>

        <TabsContent value="schedule">
          <ScheduleTab />
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

          {/* Additional Recipients (legacy) */}
          <div>
            <EmailPillsInput
              label="Additional Recipients (legacy)"
              helpText="Emails not in salespersons list (no personal PDF). Consider using Overall delivery instead."
              value={stFormAdditionalRecipients}
              onChange={setStFormAdditionalRecipients}
              placeholder="Add email…"
            />
          </div>

          {/* Delivery Options */}
          <div className="space-y-3">
            <label className="text-sm text-gray-600 block font-medium">Delivery Options</label>
            
            {/* Send to Salespersons toggle */}
            <div className="flex items-center justify-between p-3 rounded-md border bg-slate-50">
              <div>
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={stFormSendToSalespersons}
                    onChange={() => setStFormSendToSalespersons(v => !v)}
                    size="sm"
                  />
                  <span className="text-sm font-medium">Send to Salespersons</span>
                </div>
                <p className="text-xs text-gray-500 mt-1 ml-8">Individual emails with personal PDF to each selected salesperson</p>
              </div>
            </div>

            {/* Send Overall toggle */}
            <div className="flex flex-col gap-2 p-3 rounded-md border bg-slate-50">
              <div className="flex items-center gap-2">
                <Toggle
                  checked={stFormSendToOverall}
                  onChange={() => setStFormSendToOverall(v => !v)}
                  size="sm"
                />
                <span className="text-sm font-medium">Send Overall Email</span>
              </div>
              <p className="text-xs text-gray-500 ml-8">Single email to all recipients below with combined PDFs only (no personal PDFs)</p>
              
              {stFormSendToOverall && (
                <div className="mt-2 ml-8">
                  <label className="text-xs text-gray-600 block mb-1">Overall Recipients (comma-separated)</label>
                  <textarea
                    className="w-full min-h-[60px] rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
                    placeholder="email1@example.com, email2@example.com, ..."
                    value={stFormOverallRecipientsCsv}
                    onChange={(e) => setStFormOverallRecipientsCsv(e.target.value)}
                  />
                  <p className="text-xs text-gray-500 mt-1">Paste a comma-separated list of email addresses</p>
                </div>
              )}
            </div>
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
