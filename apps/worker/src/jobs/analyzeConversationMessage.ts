/**
 * AI Analysis job for incoming supplier conversation messages
 * 
 * Analyzes supplier replies to determine:
 * - Order confirmation status
 * - Questions asked
 * - Action needed
 * - ETD/ETA mentions
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

function getOpenAIClient() {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    // IMPORTANT: Do not instantiate OpenAI at module load time, otherwise the worker crashes on startup
    // when OPENAI_API_KEY isn't set (Railway). Instead, fail only the specific job that needs it.
    throw new Error('OPENAI_API_KEY is missing; cannot run analyzeConversationMessage');
  }
  return new OpenAI({ apiKey });
}

type AnalysisPayload = {
  message_id: string;
  conversation_id: string;
  app_po_id: number;
};

type AnalysisResult = {
  confirmed: boolean;
  questions: string[];
  action_needed: boolean;
  etd_mentioned: string | null;
  eta_mentioned: string | null;
  summary: string;
};

export async function analyzeConversationMessage(
  supabase: SupabaseClient,
  payload: AnalysisPayload,
  log: (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>
): Promise<{ success: boolean; analysis?: AnalysisResult; error?: string }> {
  try {
    const { message_id, conversation_id, app_po_id } = payload;

    await log('info', 'STEP:analyze_start', { message_id, conversation_id });

    // Fetch the message
    const { data: message, error: msgError } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('id', message_id)
      .single();

    if (msgError || !message) {
      throw new Error(`Message not found: ${message_id}`);
    }

    // Fetch the APP PO for context
    const { data: appPo } = await supabase
      .from('app_pos')
      .select('po_no, spy_po_no, supplier, etd, eta')
      .eq('id', app_po_id)
      .single();

    await log('info', 'STEP:analyze_context_fetched', { 
      po_no: appPo?.po_no,
      supplier: appPo?.supplier 
    });

    // Build analysis prompt
    const messageText = message.body_text || '';
    const prompt = `Analyze this email from a supplier regarding purchase order ${appPo?.spy_po_no || appPo?.po_no}.

Email content:
"""
${messageText}
"""

Expected ETD: ${appPo?.etd || 'Not set'}
Expected ETA: ${appPo?.eta || 'Not set'}

Analyze and respond in JSON format:
{
  "confirmed": boolean - true if supplier confirms the order is accepted/confirmed,
  "questions": string[] - list of questions the supplier is asking that need response,
  "action_needed": boolean - true if we need to respond or take action,
  "etd_mentioned": string|null - if a new/different ETD date is mentioned (ISO format YYYY-MM-DD),
  "eta_mentioned": string|null - if a new/different ETA date is mentioned (ISO format YYYY-MM-DD),
  "summary": string - brief 1-2 sentence summary of the email content
}

Be careful:
- "confirmed" should only be true if they explicitly confirm/accept the order
- Questions should be specific, not generic pleasantries
- Extract actual dates if mentioned, convert to YYYY-MM-DD format`;

    // Call OpenAI (lazy init to avoid crashing worker if OPENAI_API_KEY isn't set)
    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an assistant analyzing supplier emails for a purchasing team. Respond only with valid JSON, no markdown formatting.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      // GPT-5 only supports temperature=1 (default)
      max_completion_tokens: 500,  // GPT-5 uses max_completion_tokens instead of max_tokens
    });

    const responseText = completion.choices[0]?.message?.content || '{}';
    
    // Parse the JSON response
    let analysis: AnalysisResult;
    try {
      // Remove any markdown code fences if present
      const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleanJson);
    } catch (parseErr) {
      await log('error', 'STEP:analyze_parse_failed', { response: responseText });
      analysis = {
        confirmed: false,
        questions: [],
        action_needed: true,
        etd_mentioned: null,
        eta_mentioned: null,
        summary: 'Unable to parse supplier response automatically'
      };
    }

    await log('info', 'STEP:analyze_result', analysis);

    // Update message with analysis
    const { error: updateMsgError } = await supabase
      .from('conversation_messages')
      .update({
        ai_analysis: analysis
      })
      .eq('id', message_id);

    if (updateMsgError) {
      await log('error', 'STEP:analyze_update_message_failed', { error: updateMsgError.message });
    }

    // Update conversation status and summary
    const newStatus = analysis.confirmed ? 'confirmed' : 'active';
    const { error: updateConvError } = await supabase
      .from('conversations')
      .update({
        status: newStatus,
        ai_summary: analysis.summary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation_id);

    if (updateConvError) {
      await log('error', 'STEP:analyze_update_conversation_failed', { error: updateConvError.message });
    }

    // If ETD/ETA mentioned, update the APP PO
    if (analysis.etd_mentioned || analysis.eta_mentioned) {
      const updates: Record<string, string> = {};
      if (analysis.etd_mentioned) updates.etd = analysis.etd_mentioned;
      if (analysis.eta_mentioned) updates.eta = analysis.eta_mentioned;

      await supabase
        .from('app_pos')
        .update(updates)
        .eq('id', app_po_id);

      await log('info', 'STEP:analyze_updated_dates', updates);
    }

    // If confirmed, update APP PO confirmed status
    if (analysis.confirmed) {
      await supabase
        .from('app_pos')
        .update({ confirmed: true })
        .eq('id', app_po_id);

      await log('info', 'STEP:analyze_order_confirmed', { app_po_id });
    }

    await log('info', 'STEP:analyze_complete', { message_id });

    return { success: true, analysis };
  } catch (error: any) {
    await log('error', 'STEP:analyze_failed', { error: error.message });
    return { success: false, error: error.message };
  }
}


