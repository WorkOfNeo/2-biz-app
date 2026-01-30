'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { 
  Send, 
  Loader2, 
  MessageSquare, 
  Bot, 
  User,
  CheckCircle,
  XCircle,
  AlertTriangle,
  BookOpen
} from 'lucide-react';
import { getSimplePromptLibrary } from '../../lib/assistant/promptLibrary';

// Types for chat messages and actions
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  proposedAction?: ProposedAction;
  actionResult?: ActionResult;
}

interface ProposedAction {
  actionName: string;
  params: Record<string, any>;
  description: string;
  requiresConfirmation: boolean;
}

interface ActionResult {
  success: boolean;
  message: string;
  data?: any;
}

// Get the prompt library from the centralized file
const PROMPT_LIBRARY = getSimplePromptLibrary();

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Hello! I\'m your 2-BIZ assistant. I can help you query stock levels, check purchase orders, view sales data, and more. What would you like to know?',
      timestamp: new Date(),
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPromptLibrary, setShowPromptLibrary] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ messageId: string; action: ProposedAction } | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle sending a message
  const handleSendMessage = async (content?: string) => {
    const messageContent = content || inputValue.trim();
    if (!messageContent || isLoading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: messageContent,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to get response');
      }

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.assistantMessage,
        timestamp: new Date(),
        proposedAction: data.proposedAction,
      };

      setMessages(prev => [...prev, assistantMessage]);

      // If there's a proposed action that requires confirmation, set it as pending
      if (data.proposedAction?.requiresConfirmation) {
        setPendingAction({
          messageId: assistantMessage.id,
          action: data.proposedAction,
        });
      }
    } catch (error: any) {
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `Sorry, I encountered an error: ${error.message}. Please try again.`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  // Handle action confirmation
  const handleActionConfirm = async (approved: boolean) => {
    if (!pendingAction) return;

    if (!approved) {
      // User declined the action
      const declineMessage: ChatMessage = {
        id: `decline-${Date.now()}`,
        role: 'assistant',
        content: 'Action cancelled. Is there anything else I can help you with?',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, declineMessage]);
      setPendingAction(null);
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionName: pendingAction.action.actionName,
          params: pendingAction.action.params,
        }),
      });

      const data = await response.json();

      // Update the original message with the action result
      setMessages(prev => prev.map(msg => {
        if (msg.id === pendingAction.messageId) {
          return {
            ...msg,
            actionResult: {
              success: response.ok,
              message: data.assistantMessage || data.error,
              data: data.result,
            },
          };
        }
        return msg;
      }));

      // Add a follow-up message
      const resultMessage: ChatMessage = {
        id: `result-${Date.now()}`,
        role: 'assistant',
        content: data.assistantMessage || (response.ok ? 'Action completed successfully!' : `Error: ${data.error}`),
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, resultMessage]);
    } catch (error: any) {
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `Failed to execute action: ${error.message}`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setPendingAction(null);
    }
  };

  return (
    <div className="h-[calc(100vh-120px)] flex gap-4">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        <Card className="flex-1 flex flex-col overflow-hidden">
          <CardHeader className="flex-shrink-0 border-b pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <MessageSquare className="h-5 w-5 text-[#8FA894]" />
              2-BIZ Assistant
              <Badge className="ml-2 bg-[#8FA894]/10 text-[#8FA894] text-xs">Beta</Badge>
            </CardTitle>
          </CardHeader>
          
          {/* Messages Container */}
          <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.role === 'assistant' && (
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#8FA894] flex items-center justify-center">
                    <Bot className="h-4 w-4 text-white" />
                  </div>
                )}
                
                <div className={`max-w-[75%] ${message.role === 'user' ? 'order-first' : ''}`}>
                  <div
                    className={`rounded-lg px-4 py-2 ${
                      message.role === 'user'
                        ? 'bg-slate-800 text-white'
                        : 'bg-slate-100 text-slate-800'
                    }`}
                  >
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                  </div>
                  
                  {/* Proposed Action Card */}
                  {message.proposedAction && message.proposedAction.requiresConfirmation && (
                    <div className="mt-2 p-3 border border-amber-200 bg-amber-50 rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                        <span className="text-sm font-medium text-amber-800">Confirm Action</span>
                      </div>
                      <p className="text-sm text-amber-700 mb-3">{message.proposedAction.description}</p>
                      <div className="text-xs text-amber-600 mb-3 font-mono bg-amber-100 p-2 rounded">
                        {message.proposedAction.actionName}: {JSON.stringify(message.proposedAction.params, null, 2)}
                      </div>
                      
                      {pendingAction?.messageId === message.id && !message.actionResult && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleActionConfirm(true)}
                            disabled={isLoading}
                            className="bg-green-600 hover:bg-green-700"
                          >
                            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleActionConfirm(false)}
                            disabled={isLoading}
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* Action Result */}
                  {message.actionResult && (
                    <div className={`mt-2 p-3 rounded-lg ${
                      message.actionResult.success 
                        ? 'border border-green-200 bg-green-50'
                        : 'border border-red-200 bg-red-50'
                    }`}>
                      <div className="flex items-center gap-2">
                        {message.actionResult.success ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-600" />
                        )}
                        <span className={`text-sm font-medium ${
                          message.actionResult.success ? 'text-green-800' : 'text-red-800'
                        }`}>
                          {message.actionResult.success ? 'Action Completed' : 'Action Failed'}
                        </span>
                      </div>
                    </div>
                  )}
                  
                  <p className="text-xs text-slate-400 mt-1">
                    {message.timestamp.toLocaleTimeString()}
                  </p>
                </div>
                
                {message.role === 'user' && (
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-600 flex items-center justify-center">
                    <User className="h-4 w-4 text-white" />
                  </div>
                )}
              </div>
            ))}
            
            {isLoading && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#8FA894] flex items-center justify-center">
                  <Bot className="h-4 w-4 text-white" />
                </div>
                <div className="bg-slate-100 rounded-lg px-4 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </CardContent>
          
          {/* Input Area */}
          <div className="flex-shrink-0 border-t p-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="flex gap-2"
            >
              <Input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Ask me anything about stock, orders, or data..."
                disabled={isLoading || !!pendingAction}
                className="flex-1"
              />
              <Button
                type="submit"
                disabled={!inputValue.trim() || isLoading || !!pendingAction}
                className="bg-[#8FA894] hover:bg-[#7a9380]"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowPromptLibrary(!showPromptLibrary)}
                title="Prompt Library"
              >
                <BookOpen className="h-4 w-4" />
              </Button>
            </form>
          </div>
        </Card>
      </div>
      
      {/* Prompt Library Panel */}
      {showPromptLibrary && (
        <Card className="w-80 flex-shrink-0 overflow-hidden">
          <CardHeader className="border-b pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4" />
              Prompt Library
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-y-auto p-3 space-y-4">
            {Object.entries(PROMPT_LIBRARY).map(([category, prompts]) => (
              <div key={category}>
                <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                  {category}
                </h4>
                <div className="space-y-1">
                  {prompts.map((prompt, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setInputValue(prompt);
                        setShowPromptLibrary(false);
                        inputRef.current?.focus();
                      }}
                      className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-slate-100 text-slate-700 transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
