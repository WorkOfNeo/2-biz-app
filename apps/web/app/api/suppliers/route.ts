import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('name');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { name, external_name, spy_id, lead_time_days, travel_time_days, moq, tags, notes, contacts, active } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        name: name.trim(),
        external_name: external_name?.trim() || null,
        spy_id: spy_id?.trim() || null,
        lead_time_days: lead_time_days ?? 0,
        travel_time_days: travel_time_days ?? 0,
        moq: moq ?? 0,
        tags: tags || [],
        notes: notes?.trim() || null,
        contacts: contacts || [],
        active: active ?? true
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const body = await req.json();

    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Clean up the updates
    const cleanUpdates: Record<string, any> = {};
    if (updates.name !== undefined) cleanUpdates.name = updates.name?.trim();
    if (updates.external_name !== undefined) cleanUpdates.external_name = updates.external_name?.trim() || null;
    if (updates.spy_id !== undefined) cleanUpdates.spy_id = updates.spy_id?.trim() || null;
    if (updates.lead_time_days !== undefined) cleanUpdates.lead_time_days = updates.lead_time_days;
    if (updates.travel_time_days !== undefined) cleanUpdates.travel_time_days = updates.travel_time_days;
    if (updates.moq !== undefined) cleanUpdates.moq = updates.moq;
    if (updates.tags !== undefined) cleanUpdates.tags = updates.tags;
    if (updates.notes !== undefined) cleanUpdates.notes = updates.notes?.trim() || null;
    if (updates.contacts !== undefined) cleanUpdates.contacts = updates.contacts;
    if (updates.active !== undefined) cleanUpdates.active = updates.active;

    const { data, error } = await supabase
      .from('suppliers')
      .update(cleanUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('suppliers')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}








