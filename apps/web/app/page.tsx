"use client";
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import type { JobRow, JobLogRow, JobResult } from '@shared/types';

const ORCH_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL!;

interface JobBundle { job: JobRow; logs: JobLogRow[]; result: JobResult | null }
async function fetchJob(id: string): Promise<JobBundle> {
  const res = await fetch(`${ORCH_URL}/jobs/${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function HomePage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [enqueueResult, setEnqueueResult] = useState<string | null>(null);
  const [orchResult, setOrchResult] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const { data: orchJob, error: orchJobErr } = useSWR(currentJobId ? `orch-job:${currentJobId}` : null, () => fetchJob(currentJobId as string), { refreshInterval: 3000 });

  return (
    <div>
      <h1>Statistics Admin</h1>
      <p>
        Go to <Link href="/admin">/admin</Link> or <Link href="/signin">/signin</Link>.
      </p>
      <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
        <strong>Test Login via Browserless</strong>
        <div style={{ marginTop: 8 }}>
          <button
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setResult(null);
              try {
                const res = await fetch('/api/test-login', { method: 'POST' });
                const json = await res.json();
                setResult(JSON.stringify(json));
              } catch (e: any) {
                setResult(String(e?.message ?? e));
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? 'Testing…' : 'Run Test Login'}
          </button>
        </div>
        {result && (
          <pre style={{ marginTop: 8, background: '#f9f9f9', padding: 8, borderRadius: 6, overflowX: 'auto' }}>{result}</pre>
        )}
      </div>
      <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
        <strong>Enqueue Test Job (no login)</strong>
        <div style={{ marginTop: 8 }}>
          <button
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setEnqueueResult(null);
              try {
                const res = await fetch('/api/test-enqueue', { method: 'POST' });
                const json = await res.json();
                setEnqueueResult(JSON.stringify(json));
              } catch (e: any) {
                setEnqueueResult(String(e?.message ?? e));
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? 'Submitting…' : 'Submit Test Job'}
          </button>
        </div>
        {enqueueResult && (
          <pre style={{ marginTop: 8, background: '#f9f9f9', padding: 8, borderRadius: 6, overflowX: 'auto' }}>{enqueueResult}</pre>
        )}
      </div>
      <div style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
        <strong>Orchestrator Enqueue (calls Railway orchestrator)</strong>
        <div style={{ marginTop: 8 }}>
          <button
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setOrchResult(null);
              try {
                const res = await fetch('/api/test-orchestrated', { method: 'POST' });
                const text = await res.text();
                let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
                setOrchResult(JSON.stringify(json));
                if (json?.ok && json?.jobId) {
                  setCurrentJobId(json.jobId);
                }
              } catch (e: any) {
                setOrchResult(String(e?.message ?? e));
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? 'Submitting…' : 'Submit via Orchestrator'}
          </button>
        </div>
        {orchResult && (
          <pre style={{ marginTop: 8, background: '#f9f9f9', padding: 8, borderRadius: 6, overflowX: 'auto' }}>{orchResult}</pre>
        )}
        {currentJobId && (
          <div style={{ marginTop: 8 }}>
            <strong>Live Job</strong>
            {orchJobErr && <div style={{ color: 'red' }}>{String(orchJobErr)}</div>}
            {orchJob && (
              <div>
                <div style={{ fontFamily: 'monospace', fontSize: 12 }}>Status: {orchJob.job.status} | Attempts: {orchJob.job.attempts}/{orchJob.job.max_attempts}</div>
                <div style={{ fontFamily: 'monospace', fontSize: 12 }}>Started: {orchJob.job.started_at ?? '-'} | Finished: {orchJob.job.finished_at ?? '-'}</div>
                <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 8, marginTop: 6 }}>
                  {(orchJob.logs ?? []).map((l) => (
                    <div key={l.id} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      <strong>[{l.level}]</strong> {l.ts}: {l.msg} {l.data ? JSON.stringify(l.data) : ''}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

