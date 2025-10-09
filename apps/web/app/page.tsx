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
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Statistics Admin</h1>
      <p className="text-sm text-gray-600">
        Go to <Link className="underline" href="/admin">/admin</Link> or <Link className="underline" href="/signin">/signin</Link>.
      </p>
      <div className="border rounded-md p-4">
        <strong>Test Login via Browserless</strong>
        <div className="mt-2">
          <button
            disabled={loading}
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
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
          <pre className="mt-2 bg-gray-50 p-3 rounded border overflow-x-auto text-xs">{result}</pre>
        )}
      </div>
      <div className="border rounded-md p-4">
        <strong>Enqueue Test Job (no login)</strong>
        <div className="mt-2">
          <button
            disabled={loading}
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
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
          <pre className="mt-2 bg-gray-50 p-3 rounded border overflow-x-auto text-xs">{enqueueResult}</pre>
        )}
      </div>
      <div className="border rounded-md p-4">
        <strong>Orchestrator Enqueue (calls Railway orchestrator)</strong>
        <div className="mt-2">
          <button
            disabled={loading}
            className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
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
          <pre className="mt-2 bg-gray-50 p-3 rounded border overflow-x-auto text-xs">{orchResult}</pre>
        )}
        {currentJobId && (
          <div className="mt-2">
            <strong>Live Job</strong>
            {orchJobErr && <div className="text-red-600 text-sm">{String(orchJobErr)}</div>}
            {orchJob && (
              <div>
                <div className="font-mono text-xs">Status: {orchJob.job.status} | Attempts: {orchJob.job.attempts}/{orchJob.job.max_attempts}</div>
                <div className="font-mono text-xs">Started: {orchJob.job.started_at ?? '-'} | Finished: {orchJob.job.finished_at ?? '-'}</div>
                <div className="max-h-56 overflow-auto border rounded-md p-2 mt-2">
                  {(orchJob.logs ?? []).map((l) => (
                    <div key={l.id} className="font-mono text-xs">
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

