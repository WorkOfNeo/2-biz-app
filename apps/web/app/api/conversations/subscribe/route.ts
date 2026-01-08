import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { decryptToken, refreshAccessToken, encryptToken, createMailSubscription } from '../../../../lib/graph/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/conversations/subscribe
 * Create a Microsoft Graph webhook subscription for new emails
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

    // Build webhook URL
    const origin = new URL(req.url).origin;
    const webhookUrl = `${origin}/api/conversations/webhook`;

    // Create subscription
    const subscription = await createMailSubscription(accessToken, webhookUrl);

    return NextResponse.json({
      success: true,
      subscription: {
        id: subscription.id,
        expirationDateTime: subscription.expirationDateTime,
      },
    });
  } catch (error: any) {
    console.error('[conversations/subscribe] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}

