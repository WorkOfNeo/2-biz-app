export type JobType =
  | 'scrape_statistics'
  | 'scrape_styles'
  | 'enrich_styles'
  | 'update_style_stock'
  | 'check_stock_fix'
  | 'export_overview'
  | 'export_stock_list'
  | 'export_top_styles'
  | 'export_suppleringer'
  | 'scrape_customers'
  | 'apply_customer_preview'
  | 'deep_scrape_styles'
  | 'scrape_top_styles'
  | 'scrape_purchase_orders'
  | 'check_purchase_orders'
  | 'scrape_style_raw_costs'
  | 'fix_invoices'
  | 'scrape_eans'
  | 'push_app_po_to_spy'
  | 'sync_app_po_from_spy'
  | 'create_spy_stock_order'
  | 'run_ai_analysis'
  | 'analyze_conversation_message'
  | 'send_email'
  | 'send_stock_list_email'
  | 'export_stock_list_after_update_stock'
  | 'export_ai_analysis'
  | 'export_purchase_round_pdf'
  | 'run_statistics_email_pipeline'
  | 'run_manual_sendout_pipeline';

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
  inactive: boolean;
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

// Customer scrape preview types
export interface ScrapedCustomerData {
  account: string;
  company: string;
  city: string;
  country: string;
  sales_person: string;
  phone: string;
  priority: string;
  orders_link: string;
  spy_id: string;
}

export interface CustomerFieldChange {
  field: string;
  oldValue: any;
  newValue: any;
}

export interface UpdatedCustomerDiff {
  id: string;
  customer_id: string;
  company: string;
  changes: CustomerFieldChange[];
}

export interface UnchangedCustomerSummary {
  id: string;
  customer_id: string;
  company: string;
  city: string;
  country: string;
}

export interface CustomerDiff {
  new: ScrapedCustomerData[];
  updated: UpdatedCustomerDiff[];
  unchanged: UnchangedCustomerSummary[];
  orphaned: CustomerRow[];
  noAccount: ScrapedCustomerData[]; // Customers scraped but missing account number
}

export interface CustomerScrapePreviewRow {
  id: string;
  job_id: string;
  scraped_data: ScrapedCustomerData[];
  diff_data: CustomerDiff;
  applied_at: string | null;
  created_at: string;
}

