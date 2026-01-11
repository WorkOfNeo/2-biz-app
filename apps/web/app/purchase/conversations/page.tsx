'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { supabase } from '../../../lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';

type Conversation = {
  id: string;
  app_po_id: number;
  subject: string;
  supplier_email: string | null;
  status: 'draft' | 'active' | 'confirmed' | 'closed';
  thread_id: string | null;
  last_message_at: string | null;
  ai_summary: string | null;
  created_at: string;
  updated_at: string;
  app_pos: {
    po_no: string;
    spy_po_no: string | null;
    supplier: string;
    status: string;
  } | null;
  message_count: number;
  last_message?: {
    direction: 'inbound' | 'outbound';
    body_text: string;
    sent_at: string;
    ai_analysis: any;
  };
};

const statusColors: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  active: 'bg-blue-100 text-blue-700',
  confirmed: 'bg-green-100 text-green-700',
  closed: 'bg-slate-100 text-slate-500',
};

export default function ConversationsPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  // Fetch conversations with related data
  const { data: conversations, error, mutate } = useSWR(
    'conversations:list',
    async () => {
      // First get conversations with app_pos
      const { data: convs, error: convsError } = await supabase
        .from('conversations')
        .select(`
          *,
          app_pos (
            po_no,
            spy_po_no,
            supplier,
            status
          )
        `)
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (convsError) throw convsError;
      if (!convs) return [];

      // Get message counts and last messages for each conversation
      const enriched = await Promise.all(convs.map(async (conv) => {
        // Get message count
        const { count } = await supabase
          .from('conversation_messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conv.id);

        // Get last message
        const { data: lastMsg } = await supabase
          .from('conversation_messages')
          .select('direction, body_text, sent_at, ai_analysis')
          .eq('conversation_id', conv.id)
          .order('sent_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        return {
          ...conv,
          message_count: count || 0,
          last_message: lastMsg || undefined,
        };
      }));

      return enriched as Conversation[];
    }
  );

  // Filter conversations
  const filteredConversations = useMemo(() => {
    if (!conversations) return [];
    
    return conversations.filter(conv => {
      // Status filter
      if (statusFilter !== 'all' && conv.status !== statusFilter) return false;
      
      // Search filter
      if (search) {
        const searchLower = search.toLowerCase();
        const matches = 
          conv.subject.toLowerCase().includes(searchLower) ||
          conv.supplier_email?.toLowerCase().includes(searchLower) ||
          conv.app_pos?.po_no.toLowerCase().includes(searchLower) ||
          conv.app_pos?.spy_po_no?.toLowerCase().includes(searchLower) ||
          conv.app_pos?.supplier.toLowerCase().includes(searchLower);
        if (!matches) return false;
      }
      
      return true;
    });
  }, [conversations, statusFilter, search]);

  // Manual sync
  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch('/api/conversations/sync', { method: 'POST' });
      const data = await res.json();
      
      if (data.success) {
        alert(`Synced ${data.synced} new messages`);
        mutate();
      } else {
        alert('Sync failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err: any) {
      alert('Sync failed: ' + err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  // Status counts
  const statusCounts = useMemo(() => {
    if (!conversations) return { all: 0, draft: 0, active: 0, confirmed: 0, closed: 0 };
    return {
      all: conversations.length,
      draft: conversations.filter(c => c.status === 'draft').length,
      active: conversations.filter(c => c.status === 'active').length,
      confirmed: conversations.filter(c => c.status === 'confirmed').length,
      closed: conversations.filter(c => c.status === 'closed').length,
    };
  }, [conversations]);

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Conversations</h1>
          <p className="text-slate-500 text-sm mt-1">
            Track email communications with suppliers
          </p>
        </div>
        <Button 
          onClick={handleSync} 
          disabled={isSyncing}
          variant="outline"
          className="border-[#C5D5CA] text-[#8FA894] hover:bg-[#C5D5CA]/10"
        >
          {isSyncing ? 'Syncing...' : 'Sync Inbox'}
        </Button>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-4 items-center">
            {/* Status tabs */}
            <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
              {(['all', 'active', 'draft', 'confirmed', 'closed'] as const).map(status => (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    statusFilter === status
                      ? 'bg-white shadow-sm text-slate-900'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                  <span className="ml-1.5 text-xs text-slate-400">
                    ({statusCounts[status]})
                  </span>
                </button>
              ))}
            </div>
            
            {/* Search */}
            <div className="flex-1 min-w-[200px]">
              <Input
                placeholder="Search by PO, supplier, subject..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Conversations List */}
      {error ? (
        <Card className="bg-red-50 border-red-200">
          <CardContent className="p-6 text-center text-red-600">
            Failed to load conversations: {error.message}
          </CardContent>
        </Card>
      ) : !conversations ? (
        <Card>
          <CardContent className="p-6 text-center text-slate-500">
            Loading conversations...
          </CardContent>
        </Card>
      ) : filteredConversations.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-slate-500">
            {conversations.length === 0 
              ? 'No conversations yet. Start by sending an email from an APP PO.'
              : 'No conversations match your filters.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredConversations.map(conv => (
            <Link 
              key={conv.id} 
              href={`/purchase/app-pos/${conv.app_po_id}`}
            >
              <Card className="hover:border-[#C5D5CA] transition-colors cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    {/* Status indicator */}
                    <div className="flex-shrink-0 pt-1">
                      <div className={`w-2.5 h-2.5 rounded-full ${
                        conv.status === 'active' ? 'bg-blue-500' :
                        conv.status === 'confirmed' ? 'bg-green-500' :
                        conv.status === 'draft' ? 'bg-slate-400' :
                        'bg-slate-300'
                      }`} />
                    </div>
                    
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-slate-900 truncate">
                          {conv.app_pos?.supplier || 'Unknown Supplier'}
                        </span>
                        <Badge className={statusColors[conv.status] + ' text-xs'}>
                          {conv.status}
                        </Badge>
                        {conv.last_message?.ai_analysis?.action_needed && (
                          <Badge className="bg-amber-100 text-amber-700 text-xs">
                            Action Needed
                          </Badge>
                        )}
                      </div>
                      
                      <div className="text-sm text-slate-600 mb-1">
                        <span className="font-medium">
                          {conv.app_pos?.spy_po_no || conv.app_pos?.po_no || 'No PO'}
                        </span>
                        <span className="mx-2">·</span>
                        <span>{conv.subject}</span>
                      </div>
                      
                      {conv.last_message && (
                        <div className="text-sm text-slate-500 truncate">
                          <span className={conv.last_message.direction === 'inbound' ? 'text-blue-600' : ''}>
                            {conv.last_message.direction === 'inbound' ? '← ' : '→ '}
                          </span>
                          {conv.last_message.body_text.slice(0, 100)}...
                        </div>
                      )}
                      
                      {conv.ai_summary && (
                        <div className="mt-2 text-xs text-slate-500 bg-slate-50 rounded px-2 py-1">
                          AI: {conv.ai_summary}
                        </div>
                      )}
                    </div>
                    
                    {/* Meta */}
                    <div className="flex-shrink-0 text-right">
                      <div className="text-xs text-slate-500">
                        {conv.last_message_at 
                          ? new Date(conv.last_message_at).toLocaleDateString()
                          : 'No messages'}
                      </div>
                      <div className="text-xs text-slate-400 mt-1">
                        {conv.message_count} message{conv.message_count !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}


