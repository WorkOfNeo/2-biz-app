import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    
    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Get request body
    const body = await request.json();
    const { po_id, spy_po_no } = body;
    
    if (!po_id || !spy_po_no) {
      return NextResponse.json(
        { error: 'Missing required fields: po_id, spy_po_no' },
        { status: 400 }
      );
    }
    
    // Enqueue job
    const jobPayload = {
      po_id,
      spy_po_no
    };
    
    const orchestratorUrl = process.env.ORCHESTRATOR_URL;
    let jobId: string;
    
    if (orchestratorUrl) {
      // Use orchestrator if available
      const response = await fetch(`${orchestratorUrl}/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'sync_app_po_from_spy',
          payload: jobPayload
        })
      });
      
      if (!response.ok) {
        throw new Error(`Orchestrator error: ${response.statusText}`);
      }
      
      const data = await response.json();
      jobId = data.jobId;
    } else {
      // Fallback to direct Supabase insert
      const { data: jobData, error: jobError } = await supabase
        .from('jobs')
        .insert({
          type: 'sync_app_po_from_spy',
          payload: jobPayload,
          status: 'queued'
        })
        .select('id')
        .single();
        
      if (jobError || !jobData) {
        throw new Error(`Failed to enqueue job: ${jobError?.message || 'Unknown error'}`);
      }
      
      jobId = jobData.id;
    }
    
    return NextResponse.json({ jobId }, { status: 200 });
  } catch (error: any) {
    console.error('Error syncing APP PO:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to sync APP PO' },
      { status: 500 }
    );
  }
}

