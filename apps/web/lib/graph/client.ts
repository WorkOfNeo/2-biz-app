/**
 * Microsoft Graph API client utilities
 */

// Environment variables for Microsoft Graph
export const GRAPH_CONFIG = {
  clientId: process.env.MICROSOFT_CLIENT_ID || '',
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
  tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
  redirectUri: process.env.MICROSOFT_REDIRECT_URI || '',
  scopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'offline_access'],
};

// Graph API base URL
export const GRAPH_API_URL = 'https://graph.microsoft.com/v1.0';

// OAuth endpoints
export const getAuthUrl = () => {
  const params = new URLSearchParams({
    client_id: GRAPH_CONFIG.clientId,
    response_type: 'code',
    redirect_uri: GRAPH_CONFIG.redirectUri,
    scope: GRAPH_CONFIG.scopes.join(' '),
    response_mode: 'query',
  });
  
  return `https://login.microsoftonline.com/${GRAPH_CONFIG.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
};

// Exchange authorization code for tokens
export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const params = new URLSearchParams({
    client_id: GRAPH_CONFIG.clientId,
    client_secret: GRAPH_CONFIG.clientSecret,
    code,
    redirect_uri: GRAPH_CONFIG.redirectUri,
    grant_type: 'authorization_code',
    scope: GRAPH_CONFIG.scopes.join(' '),
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${GRAPH_CONFIG.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }
  );

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error_description || 'Failed to exchange code for tokens');
  }

  return res.json();
}

// Refresh access token
export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const params = new URLSearchParams({
    client_id: GRAPH_CONFIG.clientId,
    client_secret: GRAPH_CONFIG.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: GRAPH_CONFIG.scopes.join(' '),
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${GRAPH_CONFIG.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }
  );

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error_description || 'Failed to refresh token');
  }

  return res.json();
}

// Get user profile from Graph API
export async function getUserProfile(accessToken: string): Promise<{
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
}> {
  const res = await fetch(`${GRAPH_API_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to get user profile');
  }

  return res.json();
}

// Send email via Graph API
export async function sendEmail(
  accessToken: string,
  to: string,
  subject: string,
  bodyHtml: string,
  attachments?: Array<{ name: string; contentType: string; contentBytes: string }>
): Promise<{ id: string; conversationId: string }> {
  const message: any = {
    subject,
    body: {
      contentType: 'HTML',
      content: bodyHtml,
    },
    toRecipients: [
      {
        emailAddress: { address: to },
      },
    ],
  };

  if (attachments && attachments.length > 0) {
    message.attachments = attachments.map((att) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.name,
      contentType: att.contentType,
      contentBytes: att.contentBytes,
    }));
  }

  const res = await fetch(`${GRAPH_API_URL}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error?.message || 'Failed to send email');
  }

  // Get the sent message to retrieve IDs
  // Note: sendMail doesn't return the message ID directly, so we need to query sent items
  return { id: '', conversationId: '' }; // Will be updated when we implement conversation tracking
}

// Get messages from inbox
export async function getInboxMessages(
  accessToken: string,
  options?: {
    top?: number;
    filter?: string;
    orderBy?: string;
  }
): Promise<any[]> {
  const params = new URLSearchParams();
  if (options?.top) params.set('$top', options.top.toString());
  if (options?.filter) params.set('$filter', options.filter);
  if (options?.orderBy) params.set('$orderby', options.orderBy);

  const url = `${GRAPH_API_URL}/me/mailFolders/inbox/messages?${params.toString()}`;
  
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to get inbox messages');
  }

  const data = await res.json();
  return data.value || [];
}

// Get a specific message by ID
export async function getMessage(accessToken: string, messageId: string): Promise<any> {
  const res = await fetch(`${GRAPH_API_URL}/me/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error('Failed to get message');
  }

  return res.json();
}

// Create webhook subscription for new emails
export async function createMailSubscription(
  accessToken: string,
  webhookUrl: string,
  expirationMinutes: number = 4230 // Max is 4230 minutes (~3 days)
): Promise<{ id: string; expirationDateTime: string }> {
  const expirationDateTime = new Date(Date.now() + expirationMinutes * 60 * 1000).toISOString();

  const res = await fetch(`${GRAPH_API_URL}/subscriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      changeType: 'created',
      notificationUrl: webhookUrl,
      resource: '/me/mailFolders/inbox/messages',
      expirationDateTime,
      clientState: process.env.GRAPH_WEBHOOK_SECRET || 'app-conversations',
    }),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error?.message || 'Failed to create subscription');
  }

  return res.json();
}

// Simple encryption for tokens (use proper encryption in production)
export function encryptToken(token: string): string {
  // In production, use proper encryption like AES-256-GCM
  // For now, using base64 as placeholder
  return Buffer.from(token).toString('base64');
}

export function decryptToken(encrypted: string): string {
  return Buffer.from(encrypted, 'base64').toString('utf-8');
}


