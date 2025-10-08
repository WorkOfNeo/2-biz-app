'use client';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { useEffect } from 'react';

export default function SignInPage() {
  const supabase = createClientComponentClient();

  useEffect(() => {
    // Ensure we have the base URL configured
  }, []);

  return (
    <div style={{ maxWidth: 420, margin: '48px auto' }}>
      <h1>Sign In</h1>
      <Auth supabaseClient={supabase} appearance={{ theme: ThemeSupa }} providers={["github"]} />
    </div>
  );
}

