import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { exchangeCodeForTokens, getUserProfile, encryptToken } from '../../../../lib/graph/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/graph/callback
 * OAuth2 callback from Microsoft login
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      console.error('OAuth error:', error, errorDescription);
      return NextResponse.redirect(
        new URL(`/settings/integrations?error=${encodeURIComponent(errorDescription || error)}`, url.origin)
      );
    }

    if (!code) {
      return NextResponse.redirect(
        new URL('/settings/integrations?error=No+authorization+code+received', url.origin)
      );
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);

    // Get user profile to get email
    const profile = await getUserProfile(tokens.access_token);
    const email = profile.mail || profile.userPrincipalName;

    // Get authenticated user
    const supabase = createRouteHandlerClient({ cookies });
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.redirect(
        new URL('/settings/integrations?error=Not+authenticated', url.origin)
      );
    }

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Store tokens (encrypted)
    const { error: upsertError } = await supabase
      .from('graph_tokens')
      .upsert({
        user_id: user.id,
        access_token_encrypted: encryptToken(tokens.access_token),
        refresh_token_encrypted: encryptToken(tokens.refresh_token),
        expires_at: expiresAt.toISOString(),
        email,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      });

    if (upsertError) {
      console.error('Failed to store tokens:', upsertError);
      return NextResponse.redirect(
        new URL('/settings/integrations?error=Failed+to+store+tokens', url.origin)
      );
    }

    // Redirect back to settings with success
    return NextResponse.redirect(
      new URL('/settings/integrations?success=Connected+to+Microsoft+Graph', url.origin)
    );
  } catch (error: any) {
    console.error('OAuth callback error:', error);
    return NextResponse.redirect(
      new URL(`/settings/integrations?error=${encodeURIComponent(error.message)}`, new URL(req.url).origin)
    );
  }
}


