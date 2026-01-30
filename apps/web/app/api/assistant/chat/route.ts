import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { runAgentPipeline } from '../../../../lib/assistant/agent';
import type { ChatMessage } from '../../../../lib/assistant/agent';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/assistant/chat
 * 
 * Main chat endpoint for the agentic assistant.
 * Runs the full agent pipeline: intent → action selection → execute (for reads) → respond
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    
    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Get user roles
    const { data: rolesData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id);
    
    const userRoles = (rolesData || []).map((r: any) => r.role as string);
    
    // Parse request body
    const body = await req.json();
    const { messages } = body as { messages: Array<{ role: 'user' | 'assistant'; content: string }> };
    
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'messages array is required' }, { status: 400 });
    }
    
    // Convert to ChatMessage format
    const chatMessages: ChatMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    
    console.log('[Assistant API] Processing chat request');
    console.log('[Assistant API] User:', user.id);
    console.log('[Assistant API] Roles:', userRoles.join(', ') || 'none');
    console.log('[Assistant API] Messages:', chatMessages.length);
    
    // Run the agent pipeline
    const response = await runAgentPipeline(chatMessages, supabase, user.id, userRoles);
    
    console.log('[Assistant API] Response generated, trace:', response.traceId);
    
    // Log the interaction for auditability
    try {
      await supabase.from('ai_learning_events').insert({
        event_type: 'assistant_chat',
        details: {
          traceId: response.traceId,
          userMessageCount: chatMessages.length,
          lastUserMessage: chatMessages[chatMessages.length - 1]?.content?.substring(0, 200),
          hasProposedAction: !!response.proposedAction,
          actionName: response.proposedAction?.actionName || response.actionResult ? 'executed' : null,
        },
        created_by: user.id,
      });
    } catch (logError) {
      console.warn('[Assistant API] Failed to log event:', logError);
    }
    
    return NextResponse.json(response);
    
  } catch (error: any) {
    console.error('[Assistant API] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
