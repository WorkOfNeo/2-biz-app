import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { executeConfirmedAction } from '../../../../lib/assistant/agent';
import { getAction, canUserAccessAction } from '../../../../lib/assistant/actions';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/assistant/execute
 * 
 * Execute a confirmed write action.
 * This endpoint is called after the user approves a proposed action.
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
    const { actionName, params, traceId } = body as {
      actionName: string;
      params: Record<string, any>;
      traceId?: string;
    };
    
    if (!actionName) {
      return NextResponse.json({ error: 'actionName is required' }, { status: 400 });
    }
    
    console.log('[Assistant Execute] Executing action:', actionName);
    console.log('[Assistant Execute] User:', user.id);
    console.log('[Assistant Execute] Params:', JSON.stringify(params));
    
    // Validate action exists
    const action = getAction(actionName);
    if (!action) {
      return NextResponse.json({ error: `Unknown action: ${actionName}` }, { status: 400 });
    }
    
    // Validate user has permission
    if (!canUserAccessAction(action, userRoles)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }
    
    // Validate it's a write action (only write actions need explicit execution)
    if (action.mode !== 'write') {
      return NextResponse.json({ 
        error: 'This action does not require explicit execution' 
      }, { status: 400 });
    }
    
    // Execute the action
    const { result, assistantMessage } = await executeConfirmedAction(
      actionName,
      params,
      supabase,
      user.id,
      userRoles
    );
    
    console.log('[Assistant Execute] Result:', result.success ? 'success' : 'failed');
    
    // Log the execution for auditability
    try {
      await supabase.from('ai_learning_events').insert({
        event_type: 'assistant_action_executed',
        details: {
          traceId,
          actionName,
          params,
          success: result.success,
          resultMessage: result.message,
        },
        created_by: user.id,
      });
    } catch (logError) {
      console.warn('[Assistant Execute] Failed to log event:', logError);
    }
    
    return NextResponse.json({
      result,
      assistantMessage,
    });
    
  } catch (error: any) {
    console.error('[Assistant Execute] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
