export type JobType = 'scrape_statistics';

export interface ScrapeStatisticsPayload {
  // Allow optional 'deep' along with arbitrary keys; values may be undefined pre-validation
  toggles: { deep?: boolean; [k: string]: boolean | undefined };
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
  payload: ScrapeStatisticsPayload;
}

export interface EnqueueResponseBody {
  jobId: string;
}

