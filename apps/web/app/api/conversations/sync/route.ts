import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { decryptToken, refreshAccessToken, encryptToken, getInboxMessages } from '../../../../lib/graph/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/conversations/sync
 * Manually sync recent emails and match to conversations
 */
export async function POST(req: Request) {
  try {
    const supabase = createRouteHandlerClient({ cookies });
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user's Graph tokens
    const { data: tokenRecord, error: tokenError } = await supabase
      .from('graph_tokens')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (tokenError || !tokenRecord) {
      return NextResponse.json({ 
        error: 'Microsoft Graph not connected' 
      }, { status: 400 });
    }

    // Refresh token if needed
    let accessToken = decryptToken(tokenRecord.access_token_encrypted);
    const expiresAt = new Date(tokenRecord.expires_at);

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
        .eq('user_id', user.id);
    }

    // Get all active conversations with their supplier emails
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, app_po_id, supplier_email, subject')
      .in('status', ['active', 'draft']);

    if (!conversations || conversations.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No active conversations to sync',
        synced: 0 
      });
    }

    // Get supplier emails for filtering
    const supplierEmails = conversations
      .map(c => c.supplier_email?.toLowerCase())
      .filter(Boolean);

    if (supplierEmails.length === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No supplier emails to sync',
        synced: 0 
      });
    }

    // Get recent messages from inbox (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const messages = await getInboxMessages(accessToken, {
      top: 50,
      filter: `receivedDateTime ge ${sevenDaysAgo.toISOString()}`,
      orderBy: 'receivedDateTime desc',
    });

    let syncedCount = 0;
    const analyzedIds: string[] = [];

    for (const message of messages) {
      const fromEmail = message.from?.emailAddress?.address?.toLowerCase();
      if (!fromEmail) continue;

      // Check if this email is from a supplier we're tracking
      if (!supplierEmails.includes(fromEmail)) continue;

      // Find matching conversation
      const conversation = conversations.find(
        c => c.supplier_email?.toLowerCase() === fromEmail
      );
      if (!conversation) continue;

      // Check if already processed
      const { data: existingMsg } = await supabase
        .from('conversation_messages')
        .select('id')
        .eq('graph_message_id', message.id)
        .maybeSingle();

      if (existingMsg) continue;

      // Save the message
      const { data: newMessage, error: insertError } = await supabase
        .from('conversation_messages')
        .insert({
          conversation_id: conversation.id,
          direction: 'inbound',
          from_email: fromEmail,
          to_email: tokenRecord.email,
          subject: message.subject || '',
          body_html: message.body?.content || '',
          body_text: message.bodyPreview || '',
          sent_at: message.receivedDateTime || new Date().toISOString(),
          graph_message_id: message.id,
        })
        .select('id')
        .single();

      if (insertError) {
        console.error('Failed to save message:', insertError);
        continue;
      }

      // Update conversation
      await supabase
        .from('conversations')
        .update({
          last_message_at: message.receivedDateTime,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation.id);

      // Enqueue AI analysis
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

      analyzedIds.push(newMessage.id);
      syncedCount++;
    }

    return NextResponse.json({
      success: true,
      synced: syncedCount,
      message_ids: analyzedIds,
    });
  } catch (error: any) {
    console.error('[conversations/sync] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}


