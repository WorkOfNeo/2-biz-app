export type JobType = 'scrape_statistics' | 'scrape_styles' | 'update_style_stock' | 'export_overview' | 'scrape_customers' | 'deep_scrape_styles';

export interface ScrapeStatisticsPayload {
  // Allow optional 'deep' along with arbitrary keys; values may be undefined pre-validation
  toggles: { deep?: boolean; [k: string]: boolean | undefined };
  requestedBy?: string;
  seasonId?: string; // target season for imported sales stats
}

export interface ScrapeStylesPayload {
  toggles?: { [k: string]: boolean | undefined };
  requestedBy?: string;
}

export interface JobRow {
  id: string;
  type: JobType;
  payload: Record<string, any>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobLogRow {
  id: number;
  job_id: string;
  ts: string;
  level: string;
  msg: string;
  data: Record<string, any> | null;
}

export interface JobResult {
  id: string;
  job_id: string;
  summary?: string;
  data?: Record<string, any>;
  created_at: string;
}

export interface EnqueueRequestBody {
  type: JobType;
  payload: ScrapeStatisticsPayload | ScrapeStylesPayload | Record<string, any>;
}

export interface EnqueueResponseBody {
  jobId: string;
}

// Domain types
export interface SalespersonRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerRow {
  id: string;
  customer_id: string;
  company?: string | null;
  stats_display_name?: string | null;
  group_name?: string | null;
  salesperson_id?: string | null;
  email?: string | null;
  city?: string | null;
  postal?: string | null;
  country?: string | null;
  currency?: string | null;
  excluded: boolean;
  nulled: boolean;
  permanently_closed: boolean;
  created_at: string;
  updated_at: string;
}

export interface SeasonRow {
  id: string;
  name: string;
  created_at: string;
}

export interface SeasonStatisticsRow {
  id: string;
  customer_id: string;
  season_id: string;
  qty: number;
  amount: number;
  currency?: string | null;
  created_at: string;
}

