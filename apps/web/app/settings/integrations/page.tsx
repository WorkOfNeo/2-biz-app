'use client';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { getAuthUrl } from '../../../lib/graph/client';

type GraphToken = {
  id: string;
  email: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export default function IntegrationsPage() {
  const searchParams = useSearchParams();
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  // Check for success/error in URL params
  useEffect(() => {
    const success = searchParams.get('success');
    const error = searchParams.get('error');
    
    if (success) {
      setNotification({ type: 'success', message: success });
    } else if (error) {
      setNotification({ type: 'error', message: error });
    }
  }, [searchParams]);

  // Fetch current user's Graph token
  const { data: graphToken, error: tokenError, mutate: mutateToken } = useSWR(
    'graph-token',
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data, error } = await supabase
        .from('graph_tokens')
        .select('id, email, expires_at, created_at, updated_at')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;
      return data as GraphToken | null;
    }
  );

  const handleConnect = () => {
    window.location.href = getAuthUrl();
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect Microsoft Graph? This will stop email sync.')) {
      return;
    }

    setIsDisconnecting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('graph_tokens')
        .delete()
        .eq('user_id', user.id);

      if (error) throw error;
      
      mutateToken(null);
      setNotification({ type: 'success', message: 'Disconnected from Microsoft Graph' });
    } catch (error: any) {
      setNotification({ type: 'error', message: error.message });
    } finally {
      setIsDisconnecting(false);
    }
  };

  const isExpired = graphToken ? new Date(graphToken.expires_at) < new Date() : false;

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Integrations</h1>
        <p className="text-slate-500 text-sm mt-1">
          Connect external services for enhanced functionality
        </p>
      </div>

      {/* Notification */}
      {notification && (
        <div className={`mb-6 p-4 rounded-lg ${
          notification.type === 'success' 
            ? 'bg-green-50 border border-green-200 text-green-700' 
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>
          {notification.message}
          <button 
            onClick={() => setNotification(null)}
            className="float-right text-lg leading-none hover:opacity-70"
          >
            ×
          </button>
        </div>
      )}

      {/* Microsoft Graph Integration */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Microsoft Logo */}
              <div className="w-10 h-10 bg-[#00A4EF] rounded-lg flex items-center justify-center">
                <svg viewBox="0 0 23 23" className="w-6 h-6" fill="white">
                  <rect x="1" y="1" width="10" height="10" />
                  <rect x="12" y="1" width="10" height="10" />
                  <rect x="1" y="12" width="10" height="10" />
                  <rect x="12" y="12" width="10" height="10" />
                </svg>
              </div>
              <div>
                <CardTitle>Microsoft Graph</CardTitle>
                <CardDescription>
                  Connect your Microsoft 365 account for email integration
                </CardDescription>
              </div>
            </div>
            {graphToken && (
              <Badge className={isExpired ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}>
                {isExpired ? 'Token Expired' : 'Connected'}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {graphToken ? (
            <>
              <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Connected Email</span>
                  <span className="font-medium">{graphToken.email}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Token Expires</span>
                  <span className={isExpired ? 'text-amber-600' : ''}>
                    {new Date(graphToken.expires_at).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Last Updated</span>
                  <span>{new Date(graphToken.updated_at).toLocaleString()}</span>
                </div>
              </div>

              <div className="flex gap-3">
                {isExpired && (
                  <Button onClick={handleConnect} className="bg-[#00A4EF] hover:bg-[#00A4EF]/90">
                    Reconnect
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={isDisconnecting}
                  className="text-red-600 border-red-200 hover:bg-red-50"
                >
                  {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                </Button>
              </div>

              <div className="text-xs text-slate-500 pt-2 border-t">
                <p className="font-medium mb-1">Permissions granted:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Read and send emails</li>
                  <li>Access mail folders</li>
                  <li>Receive email notifications</li>
                </ul>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Connect your Microsoft 365 account to enable email features for APP PO conversations.
                This allows you to:
              </p>
              <ul className="text-sm text-slate-600 list-disc list-inside space-y-1">
                <li>Send order confirmation requests to suppliers</li>
                <li>Automatically receive and track supplier replies</li>
                <li>AI-powered analysis of supplier responses</li>
              </ul>
              
              <Button onClick={handleConnect} className="bg-[#00A4EF] hover:bg-[#00A4EF]/90">
                <svg viewBox="0 0 23 23" className="w-4 h-4 mr-2" fill="currentColor">
                  <rect x="1" y="1" width="10" height="10" />
                  <rect x="12" y="1" width="10" height="10" />
                  <rect x="1" y="12" width="10" height="10" />
                  <rect x="12" y="12" width="10" height="10" />
                </svg>
                Connect Microsoft Account
              </Button>

              <p className="text-xs text-slate-400">
                You'll be redirected to Microsoft to authorize access. We only request permissions
                needed for email functionality.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Environment Variables Note */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Configuration Required</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600 mb-3">
            The following environment variables must be set in Vercel:
          </p>
          <div className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono space-y-1">
            <div>MICROSOFT_CLIENT_ID=your_azure_app_client_id</div>
            <div>MICROSOFT_CLIENT_SECRET=your_azure_app_secret</div>
            <div>MICROSOFT_TENANT_ID=common (or your tenant ID)</div>
            <div>MICROSOFT_REDIRECT_URI=https://your-domain.com/api/graph/callback</div>
            <div>GRAPH_WEBHOOK_SECRET=random_secret_for_webhooks</div>
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Register your app in the{' '}
            <a 
              href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Azure Portal
            </a>
            {' '}to get these credentials.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

