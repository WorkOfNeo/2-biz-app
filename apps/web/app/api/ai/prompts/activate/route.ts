import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * POST /api/ai/prompts/activate
 * Activate a specific prompt version (and deactivate others with same key)
 * Body: { key, version }
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { key, version } = body;

    if (!key || version === undefined) {
      return NextResponse.json({ 
        error: 'key and version are required' 
      }, { status: 400 });
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check the prompt exists
    const { data: promptToActivate, error: fetchError } = await supabase
      .from('ai_prompts')
      .select('*')
      .eq('key', key)
      .eq('version', version)
      .single();

    if (fetchError || !promptToActivate) {
      return NextResponse.json({ 
        error: `Prompt not found: ${key} v${version}` 
      }, { status: 404 });
    }

    // Already active?
    if (promptToActivate.active) {
      return NextResponse.json({ 
        message: 'Prompt already active',
        prompt: promptToActivate
      });
    }

    // Get currently active version for logging
    const { data: currentActive } = await supabase
      .from('ai_prompts')
      .select('version')
      .eq('key', key)
      .eq('active', true)
      .single();

    // Deactivate all versions of this key
    const { error: deactivateError } = await supabase
      .from('ai_prompts')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('key', key);

    if (deactivateError) {
      return NextResponse.json({ error: deactivateError.message }, { status: 500 });
    }

    // Activate the specified version
    const { data: updatedPrompt, error: activateError } = await supabase
      .from('ai_prompts')
      .update({ active: true, updated_at: new Date().toISOString() })
      .eq('key', key)
      .eq('version', version)
      .select()
      .single();

    if (activateError) {
      return NextResponse.json({ error: activateError.message }, { status: 500 });
    }

    // Log the activation event
    await supabase.from('ai_learning_events').insert({
      event_type: 'prompt_activated',
      prompt_key: key,
      prompt_version: version,
      details: {
        previous_version: currentActive?.version || null,
        reason: 'Manually activated via UI'
      },
      created_by: user.id
    });

    return NextResponse.json({ 
      message: `Activated ${key} v${version}`,
      prompt: updatedPrompt,
      previousVersion: currentActive?.version || null
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
