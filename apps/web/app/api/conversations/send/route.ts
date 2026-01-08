import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { decryptToken, refreshAccessToken, encryptToken, GRAPH_API_URL } from '../../../../lib/graph/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SendRequest = {
  app_po_id: number;
  to_email: string;
  subject: string;
  body_html: string;
  body_text?: string;
  attachments?: Array<{ name: string; path: string }>; // Supabase storage paths
};

/**
 * POST /api/conversations/send
 * Send an email via Microsoft Graph and create/update conversation record
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json() as SendRequest;
    const { app_po_id, to_email, subject, body_html, body_text, attachments } = body;

    if (!app_po_id || !to_email || !subject || !body_html) {
      return NextResponse.json({ 
        error: 'Missing required fields: app_po_id, to_email, subject, body_html' 
      }, { status: 400 });
    }

    // Get user's Graph tokens
    const { data: tokenRecord, error: tokenError } = await supabase
      .from('graph_tokens')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (tokenError || !tokenRecord) {
      return NextResponse.json({ 
        error: 'Microsoft Graph not connected. Please connect in Settings > Integrations.' 
      }, { status: 400 });
    }

    // Check if token is expired and refresh if needed
    let accessToken = decryptToken(tokenRecord.access_token_encrypted);
    const expiresAt = new Date(tokenRecord.expires_at);

    if (expiresAt < new Date()) {
      // Token expired, refresh it
      try {
        const refreshToken = decryptToken(tokenRecord.refresh_token_encrypted);
        const newTokens = await refreshAccessToken(refreshToken);
        
        accessToken = newTokens.access_token;
        const newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

        // Update stored tokens
        await supabase
          .from('graph_tokens')
          .update({
            access_token_encrypted: encryptToken(newTokens.access_token),
            refresh_token_encrypted: encryptToken(newTokens.refresh_token),
            expires_at: newExpiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id);
      } catch (refreshError: any) {
        return NextResponse.json({ 
          error: 'Token expired and refresh failed. Please reconnect Microsoft Graph.' 
        }, { status: 401 });
      }
    }

    // Prepare attachments if any
    const graphAttachments: any[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        // Download file from Supabase storage
        const { data: fileData, error: fileError } = await supabase.storage
          .from('documents')
          .download(att.path);

        if (!fileError && fileData) {
          const buffer = await fileData.arrayBuffer();
          const contentBytes = Buffer.from(buffer).toString('base64');
          
          graphAttachments.push({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.name,
            contentBytes,
            contentType: att.path.endsWith('.pdf') 
              ? 'application/pdf' 
              : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
        }
      }
    }

    // Build email message
    const message: any = {
      subject,
      body: {
        contentType: 'HTML',
        content: body_html,
      },
      toRecipients: [
        { emailAddress: { address: to_email } },
      ],
    };

    if (graphAttachments.length > 0) {
      message.attachments = graphAttachments;
    }

    // Send via Graph API
    const sendRes = await fetch(`${GRAPH_API_URL}/me/sendMail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });

    if (!sendRes.ok) {
      const error = await sendRes.json();
      throw new Error(error.error?.message || 'Failed to send email');
    }

    // Find or create conversation for this APP PO
    let conversationId: string;
    const { data: existingConv } = await supabase
      .from('conversations')
      .select('id')
      .eq('app_po_id', app_po_id)
      .maybeSingle();

    if (existingConv) {
      conversationId = existingConv.id;
      
      // Update conversation
      await supabase
        .from('conversations')
        .update({
          status: 'active',
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);
    } else {
      // Create new conversation
      const { data: newConv, error: convError } = await supabase
        .from('conversations')
        .insert({
          app_po_id,
          subject,
          supplier_email: to_email,
          status: 'active',
          last_message_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (convError) throw convError;
      conversationId = newConv.id;
    }

    // Create message record
    const { data: messageRecord, error: msgError } = await supabase
      .from('conversation_messages')
      .insert({
        conversation_id: conversationId,
        direction: 'outbound',
        from_email: tokenRecord.email,
        to_email,
        subject,
        body_html,
        body_text: body_text || '',
        sent_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (msgError) {
      console.error('Failed to save message record:', msgError);
    }

    return NextResponse.json({
      success: true,
      conversation_id: conversationId,
      message_id: messageRecord?.id,
    });
  } catch (error: any) {
    console.error('[conversations/send] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

