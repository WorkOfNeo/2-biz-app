import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * GET /api/ai/prompts
 * List prompts, optionally filtered by key
 * Query params: ?key=quick_po_flow_v1
 */
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');

    let query = supabase
      .from('ai_prompts')
      .select('*')
      .order('key', { ascending: true })
      .order('version', { ascending: false });

    if (key) {
      query = query.eq('key', key);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Group by key for UI convenience
    const byKey: Record<string, typeof data> = {};
    for (const prompt of data || []) {
      if (!byKey[prompt.key]) byKey[prompt.key] = [];
      byKey[prompt.key].push(prompt);
    }

    return NextResponse.json({ 
      prompts: data,
      byKey,
      count: data?.length || 0
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/ai/prompts
 * Create a new prompt version
 * Body: { key, content, notes?, setActive? }
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { key, content, notes, setActive = false } = body;

    if (!key || !content) {
      return NextResponse.json({ 
        error: 'key and content are required' 
      }, { status: 400 });
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get the latest version for this key
    const { data: existing } = await supabase
      .from('ai_prompts')
      .select('version')
      .eq('key', key)
      .order('version', { ascending: false })
      .limit(1);

    const newVersion = (existing?.[0]?.version || 0) + 1;

    // If setActive, first deactivate all other versions of this key
    if (setActive) {
      await supabase
        .from('ai_prompts')
        .update({ active: false })
        .eq('key', key);
    }

    // Insert new version
    const { data: newPrompt, error: insertError } = await supabase
      .from('ai_prompts')
      .insert({
        key,
        version: newVersion,
        content,
        notes: notes?.trim() || null,
        active: setActive,
        created_by: user.id
      })
      .select()
      .single();

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // Log the event
    await supabase.from('ai_learning_events').insert({
      event_type: 'prompt_created',
      prompt_key: key,
      prompt_version: newVersion,
      details: {
        notes,
        setActive,
        content_length: content.length
      },
      created_by: user.id
    });

    // If activated, log that too
    if (setActive) {
      await supabase.from('ai_learning_events').insert({
        event_type: 'prompt_activated',
        prompt_key: key,
        prompt_version: newVersion,
        details: { reason: 'Created and activated in one step' },
        created_by: user.id
      });
    }

    return NextResponse.json({ 
      prompt: newPrompt,
      message: setActive ? 'Prompt created and activated' : 'Prompt created (not active)'
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
