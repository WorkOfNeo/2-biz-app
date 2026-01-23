import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * GET /api/ai/examples
 * List examples, optionally filtered by prompt_key or enabled status
 * Query params: ?prompt_key=quick_po_flow_v1&enabled=true
 */
export async function GET(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    const promptKey = searchParams.get('prompt_key');
    const enabledOnly = searchParams.get('enabled') === 'true';

    let query = supabase
      .from('ai_prompt_examples')
      .select('*')
      .order('created_at', { ascending: false });

    if (promptKey) {
      query = query.eq('prompt_key', promptKey);
    }

    if (enabledOnly) {
      query = query.eq('enabled', true);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ 
      examples: data,
      count: data?.length || 0
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/ai/examples
 * Create a new example
 * Body: { prompt_key, title, tags, context_snapshot, expected_behavior, enabled }
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { 
      prompt_key, 
      title, 
      tags = [], 
      context_snapshot, 
      expected_behavior, 
      enabled = true 
    } = body;

    if (!prompt_key || !title || !expected_behavior) {
      return NextResponse.json({ 
        error: 'prompt_key, title, and expected_behavior are required' 
      }, { status: 400 });
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Insert the example
    const { data: example, error: insertError } = await supabase
      .from('ai_prompt_examples')
      .insert({
        prompt_key,
        title,
        tags,
        context_snapshot: context_snapshot || null,
        expected_behavior,
        enabled,
        created_by: user.id
      })
      .select()
      .single();

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // Log the event
    await supabase.from('ai_learning_events').insert({
      event_type: 'example_added',
      prompt_key,
      details: {
        example_id: example.id,
        title,
        tags
      },
      created_by: user.id
    });

    return NextResponse.json({ example });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/ai/examples
 * Update an existing example
 * Body: { id, ...fieldsToUpdate }
 */
export async function PATCH(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ 
        error: 'id is required' 
      }, { status: 400 });
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get existing example for logging
    const { data: existing } = await supabase
      .from('ai_prompt_examples')
      .select('*')
      .eq('id', id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Example not found' }, { status: 404 });
    }

    // Build update object
    const updateObj: Record<string, any> = {
      updated_at: new Date().toISOString()
    };

    if (updates.title !== undefined) updateObj.title = updates.title;
    if (updates.tags !== undefined) updateObj.tags = updates.tags;
    if (updates.context_snapshot !== undefined) updateObj.context_snapshot = updates.context_snapshot;
    if (updates.expected_behavior !== undefined) updateObj.expected_behavior = updates.expected_behavior;
    if (updates.enabled !== undefined) updateObj.enabled = updates.enabled;

    // Update
    const { data: updated, error: updateError } = await supabase
      .from('ai_prompt_examples')
      .update(updateObj)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Log the event
    const eventType = updates.enabled === false ? 'example_disabled' : 'example_updated';
    await supabase.from('ai_learning_events').insert({
      event_type: eventType,
      prompt_key: existing.prompt_key,
      details: {
        example_id: id,
        changes: Object.keys(updates),
        previous_enabled: existing.enabled,
        new_enabled: updated.enabled
      },
      created_by: user.id
    });

    return NextResponse.json({ example: updated });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/ai/examples
 * Delete an example
 * Body: { id }
 */
export async function DELETE(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get existing for logging
    const { data: existing } = await supabase
      .from('ai_prompt_examples')
      .select('*')
      .eq('id', id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Example not found' }, { status: 404 });
    }

    // Delete
    const { error: deleteError } = await supabase
      .from('ai_prompt_examples')
      .delete()
      .eq('id', id);

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    // Log
    await supabase.from('ai_learning_events').insert({
      event_type: 'example_disabled', // Treat deletion as disable in log
      prompt_key: existing.prompt_key,
      details: {
        example_id: id,
        title: existing.title,
        action: 'deleted'
      },
      created_by: user.id
    });

    return NextResponse.json({ message: 'Example deleted' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
