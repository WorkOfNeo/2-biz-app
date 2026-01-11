export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 180; // 3 minutes max

/**
 * Daily AI Analysis Cron
 * 
 * Runs at 19:00 UTC (1 hour after style details scrape at 18:00)
 * Analyzes current season performance and sends email summary
 */

async function handle(req: Request) {
  const urlObj = new URL(req.url);
  const debug = urlObj.searchParams.get('debug') === '1';
  
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVER_ROLE_KEY || '').trim();
  
  if (!url || !serviceKey) {
    const errRes = { error: 'Supabase env missing', urlPresent: Boolean(url), serviceKeyPresent: Boolean(serviceKey) };
    return new Response(JSON.stringify(debug ? { ...errRes, debug: true } : errRes), { status: 500 });
  }
  
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Get season_compare settings
  const { data: setting } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'season_compare')
    .maybeSingle();
  
  const seasonId = (setting?.value as any)?.s1;
  const comparisonSeasonId = (setting?.value as any)?.s2;

  if (!seasonId) {
    const res = { skipped: true, reason: 'No season configured in season_compare settings' };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if season is frozen (complete)
  const { data: seasonRow } = await supabase
    .from('seasons')
    .select('is_frozen, name, year')
    .eq('id', seasonId)
    .maybeSingle();

  if ((seasonRow as any)?.is_frozen) {
    const res = { skipped: true, reason: 'Season is frozen (marked complete)', seasonId, season: `${seasonRow?.name} ${seasonRow?.year || ''}` };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Check if we already ran analysis today
  const today = new Date().toISOString().split('T')[0];
  const { data: existingAnalysis } = await supabase
    .from('ai_season_analyses')
    .select('id')
    .eq('season_id', seasonId)
    .eq('analysis_type', 'daily')
    .eq('analysis_date', today)
    .maybeSingle();

  if (existingAnalysis) {
    const res = { skipped: true, reason: 'Daily analysis already run today', analysisId: existingAnalysis.id, date: today };
    return new Response(JSON.stringify(debug ? { ...res, debug: true } : res), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  console.log('[AI Daily Analysis Cron] Running for season:', seasonId, 'comparison:', comparisonSeasonId);

  // Call the analysis API
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}` 
    : 'http://localhost:3000';

  try {
    const analysisRes = await fetch(`${baseUrl}/api/ai-analysis/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysisType: 'daily',
        seasonId,
        comparisonSeasonId,
        sendEmail: true
      })
    });

    if (!analysisRes.ok) {
      const errText = await analysisRes.text();
      console.error('[AI Daily Analysis Cron] Analysis failed:', errText);
      return new Response(JSON.stringify({ error: 'Analysis failed', detail: errText }), { status: 500 });
    }

    const result = await analysisRes.json();
    console.log('[AI Daily Analysis Cron] Analysis completed:', result.analysisId);

    // Send email notification if configured
    const { data: emailSetting } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'ai_analysis_email_recipients')
      .maybeSingle();

    const recipients = (emailSetting?.value as any)?.emails || [];
    
    if (recipients.length > 0 && result.output?.executive_summary) {
      try {
        // Build email content
        const seasonLabel = `${seasonRow?.name || ''} ${seasonRow?.year || ''}`.trim();
        const summary = result.output.executive_summary;
        const warnings = (result.output.warnings || []).slice(0, 5).join('\n• ');
        const recommendations = (result.output.recommendations || []).slice(0, 5).join('\n• ');

        const emailBody = `
<h2>Daily Season Analysis - ${seasonLabel}</h2>
<p><strong>Date:</strong> ${today}</p>

<h3>Executive Summary</h3>
<p>${summary}</p>

${warnings ? `<h3>⚠️ Warnings</h3><ul>${result.output.warnings.slice(0, 5).map((w: string) => `<li>${w}</li>`).join('')}</ul>` : ''}

${recommendations ? `<h3>💡 Recommendations</h3><ul>${result.output.recommendations.slice(0, 5).map((r: string) => `<li>${r}</li>`).join('')}</ul>` : ''}

<p><a href="${baseUrl}/ai-analysis/${result.analysisId}">View Full Report →</a></p>
`;

        await fetch(`${baseUrl}/api/email/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: recipients,
            subject: `[2-BIZ] Daily Analysis: ${seasonLabel} - ${today}`,
            html: emailBody
          })
        });

        // Update analysis with email sent info
        await supabase
          .from('ai_season_analyses')
          .update({ 
            email_sent_at: new Date().toISOString(),
            email_recipients: recipients
          })
          .eq('id', result.analysisId);

        console.log('[AI Daily Analysis Cron] Email sent to:', recipients.length, 'recipients');
      } catch (emailErr: any) {
        console.error('[AI Daily Analysis Cron] Email failed:', emailErr?.message);
      }
    }

    const res = {
      success: true,
      analysisId: result.analysisId,
      seasonId,
      season: `${seasonRow?.name || ''} ${seasonRow?.year || ''}`.trim(),
      date: today,
      emailSent: recipients.length > 0
    };

    return new Response(JSON.stringify(debug ? { ...res, debug: true, output: result.output } : res), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });

  } catch (e: any) {
    console.error('[AI Daily Analysis Cron] Error:', e);
    return new Response(JSON.stringify({ error: e?.message || 'Cron failed' }), { status: 500 });
  }
}

export async function POST(req: Request) { 
  try { 
    return await handle(req); 
  } catch (err: any) { 
    return new Response(JSON.stringify({ error: err?.message || 'Cron ai-daily-analysis error' }), { status: 500 }); 
  } 
}

export async function GET(req: Request) { 
  try { 
    return await handle(req); 
  } catch (err: any) { 
    return new Response(JSON.stringify({ error: err?.message || 'Cron ai-daily-analysis error' }), { status: 500 }); 
  } 
}

export async function OPTIONS() { 
  return new Response(null, { status: 204 }); 
}
