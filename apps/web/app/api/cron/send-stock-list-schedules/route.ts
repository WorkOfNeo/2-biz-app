export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

interface StockListSchedule {
  id: string;
  name: string;
  stockLists: string[];
  recipients: string[];
  scheduleType: 'daily' | 'weekly';
  time: string; // "HH:MM"
  days: number[]; // 0-6 (0=Sunday)
  emailBody: string;
  enabled: boolean;
  lastRun?: string;
}

/**
 * Check if a schedule should run now.
 * We check if:
 * 1. The schedule is enabled
 * 2. Current day matches (for weekly) or any day (for daily)
 * 3. Current time is within 10 minutes of scheduled time
 * 4. It hasn't run in the last 50 minutes (to prevent duplicate sends)
 */
function shouldRunNow(schedule: StockListSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;

  const currentDay = now.getDay(); // 0-6, 0=Sunday
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Parse scheduled time
  const timeParts = schedule.time.split(':').map(Number);
  const schedHour = timeParts[0] ?? 0;
  const schedMinute = timeParts[1] ?? 0;

  // Check day match
  if (schedule.scheduleType === 'weekly') {
    if (!schedule.days.includes(currentDay)) return false;
  }

  // Check time match (within 10 minute window)
  const scheduledMinutes = schedHour * 60 + schedMinute;
  const currentMinutes = currentHour * 60 + currentMinute;
  const diff = Math.abs(currentMinutes - scheduledMinutes);
  
  // Within 10 minutes of scheduled time
  if (diff > 10 && diff < (24 * 60 - 10)) return false;

  // Check if already ran recently (within 50 minutes)
  if (schedule.lastRun) {
    const lastRunTime = new Date(schedule.lastRun).getTime();
    const fiftyMinutesAgo = now.getTime() - 50 * 60 * 1000;
    if (lastRunTime > fiftyMinutesAgo) return false;
  }

  return true;
}

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  const forceId = urlObj.searchParams.get('force'); // Force run a specific schedule by ID

  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();

  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Supabase env missing' }), { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Get EmailJS config
  const serviceId = process.env.EMAILJS_SERVICE_ID || process.env.EMAILJS_SERVICE_KEY || '';
  const templateId = process.env.EMAILJS_TEMPLATE_ID || '';
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || '';
  const fromEmail = process.env.EMAILJS_FROM_EMAIL || '';
  const fromName = process.env.EMAILJS_FROM_NAME || '2-BIZ';

  if (!serviceId || !templateId || !publicKey) {
    return new Response(JSON.stringify({ error: 'EmailJS env missing' }), { status: 500 });
  }

  // Load schedules
  const { data: settingsRow } = await supabase
    .from('app_settings')
    .select('id, value')
    .eq('key', 'stock_list_schedules')
    .maybeSingle();

  const schedules: StockListSchedule[] = (settingsRow?.value as any)?.schedules || [];

  if (schedules.length === 0) {
    return new Response(JSON.stringify({ message: 'No schedules configured', sent: 0 }), { status: 200 });
  }

  // Load latest stock list exports
  const { data: exportsData } = await supabase
    .from('exports')
    .select('id, kind, title, path, public_url, meta, created_at')
    .eq('kind', 'stock_list_pdf')
    .order('created_at', { ascending: false })
    .limit(50);

  const latestStockListByName = new Map<string, any>();
  for (const row of (exportsData ?? [])) {
    const name = String(row?.meta?.list || row?.title || '').replace(/^Stock List ·\s*/i, '');
    if (name && !latestStockListByName.has(name)) {
      latestStockListByName.set(name, row);
    }
  }

  const now = new Date();
  const results: Array<{ scheduleId: string; scheduleName: string; sent: number; error?: string }> = [];
  const updatedSchedules: StockListSchedule[] = [...schedules];

  for (const schedule of schedules) {
    const shouldRun = forceId === schedule.id || shouldRunNow(schedule, now);
    
    if (debug) {
      console.log(`[cron:stock-list-schedules] Checking schedule "${schedule.name}" (${schedule.id}): shouldRun=${shouldRun}`);
    }

    if (!shouldRun) continue;

    try {
      let sentCount = 0;

      for (const listName of schedule.stockLists) {
        const exp = latestStockListByName.get(listName);
        if (!exp?.public_url) {
          if (debug) console.log(`[cron:stock-list-schedules] No export for list "${listName}"`);
          continue;
        }

        const subject = `${listName} - Lagerliste`;
        const filename = `${listName} - Lagerliste.pdf`;

        // Send to all recipients (as BCC if multiple)
        const payload = {
          service_id: serviceId,
          template_id: templateId,
          user_id: publicKey,
          template_params: {
            to_email: schedule.recipients[0] || '',
            bcc_email: schedule.recipients.slice(1).join(','),
            subject,
            message_html: schedule.emailBody || 'Hermed lagerliste :)',
            from_name: fromName,
            from_email: fromEmail,
            stock_list_1_url: exp.public_url,
            stock_list_1_name: listName,
            stock_list_1_filename: filename,
          },
        };

        const res = await fetch(EMAILJS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          sentCount++;
          if (debug) console.log(`[cron:stock-list-schedules] Sent "${listName}" to ${schedule.recipients.length} recipients`);
        } else {
          const errText = await res.text();
          console.error(`[cron:stock-list-schedules] Failed to send "${listName}": ${errText}`);
        }
      }

      // Update lastRun
      const idx = updatedSchedules.findIndex(s => s.id === schedule.id);
      if (idx !== -1) {
        updatedSchedules[idx] = { ...updatedSchedules[idx], lastRun: now.toISOString() };
      }

      results.push({ scheduleId: schedule.id, scheduleName: schedule.name, sent: sentCount });
    } catch (err: any) {
      results.push({ scheduleId: schedule.id, scheduleName: schedule.name, sent: 0, error: err?.message || String(err) });
    }
  }

  // Save updated schedules (with new lastRun times)
  if (results.length > 0 && settingsRow?.id) {
    await supabase
      .from('app_settings')
      .update({ value: { schedules: updatedSchedules } })
      .eq('id', settingsRow.id);
  }

  const totalSent = results.reduce((sum, r) => sum + r.sent, 0);

  return new Response(JSON.stringify({
    message: results.length > 0 ? `Processed ${results.length} schedule(s)` : 'No schedules due to run',
    sent: totalSent,
    results: debug ? results : undefined,
    time: now.toISOString(),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    console.error('[cron:send-stock-list-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (err: any) {
    console.error('[cron:send-stock-list-schedules] Error:', err);
    return new Response(JSON.stringify({ error: err?.message || 'Cron error' }), { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

