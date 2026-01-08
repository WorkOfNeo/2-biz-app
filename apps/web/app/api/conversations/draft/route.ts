import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type DraftRequest = {
  app_po_id: number;
  type: 'initial' | 'followup_2weeks' | 'followup_1week' | 'followup_etd';
};

/**
 * POST /api/conversations/draft
 * Generate an AI-drafted email for an APP PO
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json() as DraftRequest;
    const { app_po_id, type = 'initial' } = body;

    if (!app_po_id) {
      return NextResponse.json({ error: 'app_po_id is required' }, { status: 400 });
    }

    // Fetch APP PO with items
    const { data: po, error: poError } = await supabase
      .from('app_pos')
      .select('*')
      .eq('id', app_po_id)
      .single();

    if (poError || !po) {
      return NextResponse.json({ error: 'APP PO not found' }, { status: 404 });
    }

    // Get supplier email from suppliers table
    const { data: supplier } = await supabase
      .from('suppliers')
      .select('name, external_name, notes')
      .eq('name', po.supplier)
      .maybeSingle();

    // Format items for the prompt - fetch style names
    const items = (po.meta?.items || []) as Array<{ style_no: string; style_name?: string; color: string; total: number }>;
    const styleNos = [...new Set(items.map(item => item.style_no))];
    
    // Fetch style names from styles table
    const { data: styles } = await supabase
      .from('styles')
      .select('style_no, style_name')
      .in('style_no', styleNos);
    
    const styleNameMap = new Map<string, string>();
    (styles || []).forEach(s => {
      if (s.style_name) styleNameMap.set(s.style_no, s.style_name);
    });
    
    const itemsList = items.map(item => {
      const styleName = item.style_name || styleNameMap.get(item.style_no) || item.style_no;
      return `${styleName} - ${item.color}: ${item.total} pcs`;
    }).join('\n');

    // Build the prompt based on type
    let prompt = '';
    let subject = '';
    
    const poNumbers = po.spy_po_no || po.po_no;
    const etdFormatted = po.etd ? new Date(po.etd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'TBD';
    const etaFormatted = po.eta ? new Date(po.eta).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'TBD';

    switch (type) {
      case 'initial':
        subject = `Order Confirmation Request: ${poNumbers}`;
        prompt = `Generate a professional but friendly email to a supplier about a new purchase order.

Order Details:
- PO Number(s): ${poNumbers}
- Supplier: ${po.supplier}
- Items:
${itemsList}
- Expected ETD: ${etdFormatted}
- Expected ETA: ${etaFormatted}

The email should:
1. Be professional but friendly
2. List the PO number(s) and mention the styles/colors with quantities
3. Ask the supplier to confirm the order
4. Request confirmation of ETD (Ex-Factory Date) and ETA (Arrival Date)
5. Thank them and wish them a nice day

Keep it concise. Do not include subject line in the body.`;
        break;

      case 'followup_2weeks':
        subject = `Follow-up: Order ${poNumbers} - ETD in 2 weeks`;
        prompt = `Generate a professional follow-up email about a purchase order that has ETD in approximately 2 weeks.

Order Details:
- PO Number(s): ${poNumbers}
- Supplier: ${po.supplier}
- ETD: ${etdFormatted}
- ETA: ${etaFormatted}
- Items:
${itemsList}

The email should:
1. Be polite and professional
2. Reference the PO number
3. Ask for a production status update
4. Confirm the ETD is still on track
5. Request any updated photos if available
6. Keep it brief

Do not include subject line in the body.`;
        break;

      case 'followup_1week':
        subject = `Follow-up: Order ${poNumbers} - ETD in 1 week`;
        prompt = `Generate a professional follow-up email about a purchase order that has ETD in approximately 1 week.

Order Details:
- PO Number(s): ${poNumbers}
- Supplier: ${po.supplier}
- ETD: ${etdFormatted}
- ETA: ${etaFormatted}
- Items:
${itemsList}

The email should:
1. Be polite but emphasize the approaching deadline
2. Reference the PO number
3. Confirm production is complete or nearly complete
4. Confirm the ETD is still on track
5. Request shipping details if ready
6. Keep it brief

Do not include subject line in the body.`;
        break;

      case 'followup_etd':
        subject = `Urgent: Order ${poNumbers} - ETD Today`;
        prompt = `Generate a professional email about a purchase order where ETD is today.

Order Details:
- PO Number(s): ${poNumbers}
- Supplier: ${po.supplier}
- ETD: ${etdFormatted} (TODAY)
- ETA: ${etaFormatted}
- Items:
${itemsList}

The email should:
1. Be polite but urgent
2. Reference the PO number
3. Confirm the order has shipped or is shipping today
4. Request tracking information and shipping documents
5. Keep it brief

Do not include subject line in the body.`;
        break;
    }

    // Generate the email draft using OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a professional purchasing assistant helping draft emails to suppliers. Write clear, concise, and professional emails. Always use a friendly but business-appropriate tone.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    const draftBody = completion.choices[0]?.message?.content || '';

    // Convert to HTML (simple paragraph formatting)
    const draftHtml = draftBody
      .split('\n\n')
      .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
      .join('');

    return NextResponse.json({
      success: true,
      draft: {
        subject,
        body_text: draftBody,
        body_html: draftHtml,
        type,
        app_po_id,
        supplier: po.supplier,
      },
    });
  } catch (error: any) {
    console.error('[conversations/draft] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

