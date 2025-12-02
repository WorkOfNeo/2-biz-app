# Job Progress Reporting Pattern

## Overview

This document describes the standard pattern for reporting job progress from worker jobs to the frontend UI, enabling real-time progress bars and status updates.

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│ Worker Job  │  logs   │ job_logs     │  polls  │ Frontend    │
│             ├────────>│ (Supabase)   │<────────┤ Progress    │
│ (Railway)   │         │              │         │ Bar         │
└─────────────┘         └──────────────┘         └─────────────┘
```

## Database Tables

### `jobs` Table
- `id`: Job UUID
- `type`: Job type (e.g., 'deep_scrape_styles')
- `status`: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
- `started_at`: Timestamp when job started
- `finished_at`: Timestamp when job completed

### `job_logs` Table
- `job_id`: References jobs.id
- `message`: String describing the step/status
- `data`: JSONB containing progress metrics
- `level`: 'info' | 'error' | 'progress'
- `created_at`: Timestamp of log entry

## Worker-Side Pattern

### 1. Log Frequency Guidelines

**✅ DO:**
- Log every Nth iteration (e.g., every 10 items)
- Log start, completion, and errors
- Include percentage complete
- Include cumulative stats

**❌ DON'T:**
- Log every single item (creates DB bloat)
- Log without meaningful data
- Log more frequently than every 1-2 seconds

### 2. Progress Log Structure

```typescript
// Standard progress log format
await log(job.id, 'info', 'STEP:operation_progress', {
  index: currentIndex,        // Current item number
  total: totalItems,          // Total items to process
  percent: Math.round((currentIndex / totalItems) * 100),
  // Add job-specific cumulative metrics:
  itemsProcessed: count,
  itemsCreated: created,
  itemsFailed: failed,
  // Optional: current item identifier for debugging
  currentItem: itemIdentifier
});
```

### 3. Implementation Example

From `deepScrapeStyles.ts`:

```typescript
let updated = 0;
let colorLinksInserted = 0;
const total = styles.length;
let idx = 0;

for (const style of styles) {
  idx++;
  
  // Log every 10 styles or on last style
  if (idx % 10 === 0 || idx === total) {
    try {
      await log(job.id, 'info', 'STEP:deep_styles_progress', {
        index: idx,
        total,
        percent: Math.round((idx / total) * 100),
        updated,
        colorLinksInserted
      });
    } catch {}
  }
  
  // ... process style ...
  
  updated++;
  if (newLinksCreated) {
    colorLinksInserted += newLinksCreated;
  }
}

// Final log with summary
await log(job.id, 'info', 'STEP:complete', { 
  updated, 
  colorLinksInserted 
});
```

### 4. Error Logging

```typescript
try {
  // ... operation ...
} catch (e: any) {
  await log(job.id, 'error', 'STEP:operation_failed', {
    item: identifier,
    error: e?.message || String(e),
    // Include context for debugging:
    context: relevantData
  });
  // Continue or re-throw based on severity
}
```

## Frontend Pattern

### 1. Fetch Running Job

```typescript
const { data: runningJob } = useSWR('jobs:running', async () => {
  const { data } = await supabase
    .from('jobs')
    .select('id, type, status, started_at')
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}, { refreshInterval: 2000 }); // Poll every 2 seconds
```

### 2. Fetch Latest Log

```typescript
const { data: latestLog } = useSWR(
  runningJob?.id ? ['job:log', runningJob.id] : null,
  async () => {
    if (!runningJob?.id) return null;
    const { data } = await supabase
      .from('job_logs')
      .select('message, data, created_at')
      .eq('job_id', runningJob.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  },
  { refreshInterval: 1000 } // Poll every 1 second for logs
);
```

### 3. Display Progress Bar

```typescript
{runningJob && (
  <div className="rounded-lg border bg-blue-50 border-blue-200 p-4">
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <div className="h-2 w-2 bg-blue-600 rounded-full animate-pulse" />
        <span className="text-sm font-semibold text-blue-900">
          {JOB_DESCRIPTIONS[runningJob.type]?.split(':')[0]} - Running
        </span>
      </div>
      <span className="text-xs text-blue-700">
        {latestLog?.data?.percent}% - {latestLog?.data?.index}/{latestLog?.data?.total}
      </span>
    </div>
    
    {latestLog && (
      <div className="text-sm text-blue-800 mb-3">
        {latestLog.message}
        {latestLog.data && (
          <div className="text-xs text-blue-600 mt-1">
            {Object.entries(latestLog.data)
              .filter(([k]) => !['index', 'total', 'percent'].includes(k))
              .map(([k, v]) => `${k}: ${v}`)
              .join(' • ')}
          </div>
        )}
      </div>
    )}
    
    <div className="relative h-2 bg-blue-200 rounded-full overflow-hidden">
      <div 
        className="absolute inset-0 bg-blue-600 transition-all duration-500"
        style={{ width: `${latestLog?.data?.percent || 0}%` }}
      />
    </div>
  </div>
)}
```

## Real-World Example Output

### Worker Logs (from deepScrapeStyles):

```
[job fcb97cb3] [info] STEP:deep_styles_begin
[job fcb97cb3] [info] STEP:deep_styles_seasons_loaded { count: 12 }
[job fcb97cb3] [info] STEP:deep_styles_progress {
  index: 10,
  total: 411,
  percent: 2,
  updated: 9,
  colorLinksInserted: 0
}
[job fcb97cb3] [info] STEP:deep_styles_progress {
  index: 20,
  total: 411,
  percent: 5,
  updated: 19,
  colorLinksInserted: 5
}
...
[job fcb97cb3] [info] STEP:complete {
  updated: 411,
  colorLinksInserted: 127
}
```

### Frontend Display:

```
┌─────────────────────────────────────────────────────────┐
│ 🔵 Deep Scrape Styles - Running            5% - 20/411 │
│                                                          │
│ STEP:deep_styles_progress                               │
│ updated: 19 • colorLinksInserted: 5                     │
│                                                          │
│ [█████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░]     │
└─────────────────────────────────────────────────────────┘
```

## Performance Guidelines

### Logging Frequency

| Total Items | Log Every N Items | Total Logs |
|-------------|-------------------|------------|
| < 50        | 5                 | ~10        |
| 50-200      | 10                | ~20        |
| 200-1000    | 20                | ~50        |
| 1000+       | 50-100            | ~100       |

**Rule of thumb**: Aim for 20-100 progress logs total, regardless of dataset size.

### Database Impact

**Bad (411 logs for 411 items):**
- ~411 INSERT operations to `job_logs`
- DB connection pool exhaustion
- Slow job execution

**Good (41 logs for 411 items):**
- ~41 INSERT operations (90% reduction)
- Minimal DB overhead
- Fast execution with good visibility

## Best Practices

### ✅ DO

1. **Batch your logging**: Log every Nth item, not every item
2. **Include percentage**: Makes progress immediately clear
3. **Show cumulative stats**: Running totals are valuable
4. **Handle log failures gracefully**: Wrap in try/catch
5. **Log the final state**: Always log completion with totals
6. **Use consistent message format**: `STEP:operation_state`

### ❌ DON'T

1. **Don't log inside tight loops**: Kills performance
2. **Don't log every single item**: Creates DB bloat
3. **Don't forget error logging**: Silent failures are bad
4. **Don't include sensitive data**: PII, passwords, tokens
5. **Don't block on logs**: Use try/catch, continue on failure

## Message Naming Convention

Use format: `STEP:job_phase_state`

Examples:
- `STEP:deep_styles_begin` - Job started
- `STEP:deep_styles_progress` - Progress update
- `STEP:deep_styles_nav` - Navigation/page load
- `STEP:deep_styles_no_color_box` - Expected condition
- `STEP:deep_styles_color_link` - Specific operation
- `STEP:deep_styles_color_link_failed` - Operation failed
- `STEP:complete` - Job finished

## Testing Your Progress Bar

1. **Start a long-running job** (> 1 minute)
2. **Check frontend renders** the progress bar
3. **Verify updates** happen every 1-2 seconds
4. **Confirm percentage** increases correctly
5. **Ensure stats** update in real-time
6. **Test completion** - bar disappears when done

## Migration Checklist

To add progress reporting to an existing job:

- [ ] Identify total items to process
- [ ] Add progress counter variable
- [ ] Add log every Nth iteration (calculate N based on total)
- [ ] Include `index`, `total`, `percent` in log data
- [ ] Add job-specific cumulative metrics
- [ ] Test with small dataset first
- [ ] Verify frontend progress bar updates
- [ ] Monitor database log table size

## Future Enhancements

### Potential Improvements:
1. **WebSocket support**: Real-time push instead of polling
2. **Progress persistence**: Resume from last position on restart
3. **ETA calculation**: Show estimated time remaining
4. **Sub-tasks**: Nested progress for complex jobs
5. **Historical metrics**: Compare current vs previous runs

---

**Last Updated**: December 2024  
**Reference Implementation**: `apps/worker/src/jobs/deepScrapeStyles.ts` and `apps/web/app/settings/jobs/page.tsx`

