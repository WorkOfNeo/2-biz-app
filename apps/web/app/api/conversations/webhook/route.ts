import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { decryptToken, refreshAccessToken, encryptToken, getMessage } from '../../../../lib/graph/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Use service role for webhook processing
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const WEBHOOK_SECRET = process.env.GRAPH_WEBHOOK_SECRET || 'app-conversations';

/**
 * POST /api/conversations/webhook
 * Receive notifications from Microsoft Graph about new emails
 */
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    
    // Handle validation request from Microsoft Graph
    const validationToken = url.searchParams.get('validationToken');
    if (validationToken) {
      // Return the validation token as plain text
      return new NextResponse(validationToken, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Parse notification payload
    const body = await req.json();
    const notifications = body.value || [];

    for (const notification of notifications) {
      // Verify client state
      if (notification.clientState !== WEBHOOK_SECRET) {
        console.warn('Invalid client state, skipping notification');
        continue;
      }

      const resourceData = notification.resourceData;
      if (!resourceData || !resourceData.id) continue;

      const messageId = resourceData.id;
      
      // Process the new email asynchronously
      // We acknowledge the webhook quickly and process in background
      processIncomingEmail(messageId).catch(err => {
        console.error('Failed to process incoming email:', err);
      });
    }

    // Acknowledge receipt
    return NextResponse.json({ status: 'ok' });
  } catch (error: any) {
    console.error('[conversations/webhook] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Process an incoming email and match it to a conversation
 */
async function processIncomingEmail(messageId: string) {
  try {
    // Get all users with Graph tokens to find the one who received this email
    const { data: tokenRecords, error: tokenError } = await supabase
      .from('graph_tokens')
      .select('*');

    if (tokenError || !tokenRecords || tokenRecords.length === 0) {
      console.log('No graph tokens found, cannot process email');
      return;
    }

    // Try each token to find the message
    for (const tokenRecord of tokenRecords) {
      try {
        let accessToken = decryptToken(tokenRecord.access_token_encrypted);
        const expiresAt = new Date(tokenRecord.expires_at);

        // Refresh token if expired
        if (expiresAt < new Date()) {
          const refreshToken = decryptToken(tokenRecord.refresh_token_encrypted);
          const newTokens = await refreshAccessToken(refreshToken);
          accessToken = newTokens.access_token;

          await supabase
            .from('graph_tokens')
            .update({
              access_token_encrypted: encryptToken(newTokens.access_token),
              refresh_token_encrypted: encryptToken(newTokens.refresh_token),
              expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', tokenRecord.id);
        }

        // Get the message details
        const message = await getMessage(accessToken, messageId);
        
        // Extract sender email
        const fromEmail = message.from?.emailAddress?.address?.toLowerCase();
        if (!fromEmail) continue;

        // Find matching conversation by supplier email
        const { data: conversations } = await supabase
          .from('conversations')
          .select('id, app_po_id, subject')
          .ilike('supplier_email', fromEmail);

        if (!conversations || conversations.length === 0) {
          // Check if this is a reply to one of our outbound emails
          // by looking at the conversation ID from Graph
          const conversationId = message.conversationId;
          if (conversationId) {
            const { data: existingMsgs } = await supabase
              .from('conversation_messages')
              .select('conversation_id')
              .not('graph_message_id', 'is', null);

            // For now, we skip if no matching conversation
            console.log('No matching conversation found for email from:', fromEmail);
            continue;
          }
          continue;
        }

        // Use the most recent conversation with this supplier
        const conversation = conversations[0];
        if (!conversation) continue;

        // Check if message already processed
        const { data: existingMsg } = await supabase
          .from('conversation_messages')
          .select('id')
          .eq('graph_message_id', messageId)
          .maybeSingle();

        if (existingMsg) {
          console.log('Message already processed:', messageId);
          continue;
        }

        // Extract email content
        const bodyHtml = message.body?.content || '';
        const bodyText = message.bodyPreview || '';
        const subject = message.subject || '';
        const sentAt = message.receivedDateTime || new Date().toISOString();

        // Save the incoming message
        const { data: newMessage, error: insertError } = await supabase
          .from('conversation_messages')
          .insert({
            conversation_id: conversation.id,
            direction: 'inbound',
            from_email: fromEmail,
            to_email: tokenRecord.email,
            subject,
            body_html: bodyHtml,
            body_text: bodyText,
            sent_at: sentAt,
            graph_message_id: messageId,
          })
          .select('id')
          .single();

        if (insertError) {
          console.error('Failed to save incoming message:', insertError);
          continue;
        }

        // Update conversation
        await supabase
          .from('conversations')
          .update({
            last_message_at: sentAt,
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversation.id);

        // Enqueue AI analysis job
        await supabase
          .from('jobs')
          .insert({
            type: 'analyze_conversation_message',
            payload: { 
              message_id: newMessage.id,
              conversation_id: conversation.id,
              app_po_id: conversation.app_po_id,
            },
            status: 'pending',
          });

        console.log('Processed incoming email for conversation:', conversation.id);
        return; // Message processed, exit loop
      } catch (err: any) {
        // Token might not have access to this message, try next
        console.log('Token did not have access:', err.message);
        continue;
      }
    }
  } catch (error: any) {
    console.error('Error processing incoming email:', error);
    throw error;
  }
}

