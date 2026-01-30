/**
 * Agent Pipeline for the Agentic Chat
 * 
 * Flow:
 * 1. Intent extraction → classify the user's request
 * 2. Action selection → pick exactly one action + params (or no_action)
 * 3. Execute → run the action (read immediately, write requires confirmation)
 * 4. Response synthesis → generate final answer
 */

import OpenAI from 'openai';
import { SupabaseClient } from '@supabase/supabase-js';
import { ACTION_REGISTRY, getAction, canUserAccessAction, getActionsForLLM } from './actions';
import type { ActionResult } from './actions';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentResponse {
  assistantMessage: string;
  proposedAction?: {
    actionName: string;
    params: Record<string, any>;
    description: string;
    requiresConfirmation: boolean;
  };
  actionResult?: ActionResult;
  traceId: string;
}

// Intent types
type Intent = 'question' | 'lookup' | 'summarize' | 'create' | 'update' | 'navigate' | 'help' | 'unknown';

interface ActionSelection {
  actionName: string | null;
  params: Record<string, any>;
  reasoning: string;
}

// ==================== Step 1: Intent Extraction ====================

async function extractIntent(
  messages: ChatMessage[],
  userRoles: string[]
): Promise<Intent> {
  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';
  
  const systemPrompt = `You are an intent classifier for a business assistant. Classify the user's intent into one of these categories:

- question: User is asking a question that needs data lookup
- lookup: User wants to find specific data (stock, orders, etc.)
- summarize: User wants a summary or overview of data
- create: User wants to create something (draft PO, etc.)
- update: User wants to modify existing data
- navigate: User wants help finding a page or feature
- help: User wants to know what the assistant can do
- unknown: Cannot determine intent

Respond with just the intent category, nothing else.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: lastUserMessage },
      ],
      max_tokens: 20,
      temperature: 0.1,
    });

    const intent = completion.choices[0]?.message?.content?.trim().toLowerCase() as Intent;
    return ['question', 'lookup', 'summarize', 'create', 'update', 'navigate', 'help', 'unknown'].includes(intent) 
      ? intent 
      : 'unknown';
  } catch (error) {
    console.error('[Agent] Intent extraction failed:', error);
    return 'unknown';
  }
}

// ==================== Step 2: Action Selection ====================

async function selectAction(
  messages: ChatMessage[],
  userRoles: string[],
  intent: Intent
): Promise<ActionSelection> {
  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';
  const actionsDescription = getActionsForLLM(userRoles);
  
  const systemPrompt = `You are an action router for a business assistant. Based on the user's request, select the most appropriate action to execute.

## Available Actions
${actionsDescription}

## Rules
1. Select exactly ONE action or null if no action is needed
2. Extract parameters from the user's message
3. For questions that can be answered without data lookup, select null
4. For navigation or help requests, select null
5. Return valid JSON only

## Response Format
{
  "actionName": "action_name_here" | null,
  "params": { ... },
  "reasoning": "Brief explanation of why this action was selected"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Intent: ${intent}\nUser message: ${lastUserMessage}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.2,
    });

    const response = JSON.parse(completion.choices[0]?.message?.content || '{}');
    return {
      actionName: response.actionName || null,
      params: response.params || {},
      reasoning: response.reasoning || '',
    };
  } catch (error) {
    console.error('[Agent] Action selection failed:', error);
    return { actionName: null, params: {}, reasoning: 'Failed to select action' };
  }
}

// ==================== Step 3: Execute Action ====================

async function executeAction(
  actionName: string,
  params: Record<string, any>,
  supabase: SupabaseClient,
  userId: string,
  userRoles: string[]
): Promise<ActionResult> {
  const action = getAction(actionName);
  
  if (!action) {
    return {
      success: false,
      message: `Unknown action: ${actionName}`,
      error: 'Action not found',
    };
  }
  
  // Check permissions
  if (!canUserAccessAction(action, userRoles)) {
    return {
      success: false,
      message: `You don't have permission to perform this action.`,
      error: 'Permission denied',
    };
  }
  
  // Execute the action
  try {
    return await action.handler(params, supabase, userId);
  } catch (error: any) {
    console.error(`[Agent] Action ${actionName} failed:`, error);
    return {
      success: false,
      message: `Action failed: ${error.message}`,
      error: error.message,
    };
  }
}

// ==================== Step 4: Response Synthesis ====================

async function synthesizeResponse(
  messages: ChatMessage[],
  intent: Intent,
  actionSelection: ActionSelection,
  actionResult: ActionResult | null,
  userRoles: string[]
): Promise<string> {
  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';
  
  let contextInfo = '';
  if (actionResult) {
    contextInfo = `
## Action Executed
Action: ${actionSelection.actionName}
Result: ${actionResult.success ? 'Success' : 'Failed'}
Data: ${JSON.stringify(actionResult.data, null, 2)}
Message: ${actionResult.message}`;
  }
  
  const systemPrompt = `You are a helpful business assistant for 2-BIZ, a Danish fashion wholesale company. 
Generate a natural, helpful response to the user's message.

${contextInfo}

## Guidelines
- Be concise but informative
- If data was retrieved, summarize it clearly
- If an error occurred, explain it simply
- Offer to help with follow-up questions
- Use a professional but friendly tone
- Format data nicely when presenting it`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.slice(-5), // Include recent context
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    return completion.choices[0]?.message?.content || 'I apologize, but I was unable to generate a response. Please try again.';
  } catch (error) {
    console.error('[Agent] Response synthesis failed:', error);
    return actionResult?.message || 'I encountered an error processing your request. Please try again.';
  }
}

// ==================== Main Agent Pipeline ====================

export async function runAgentPipeline(
  messages: ChatMessage[],
  supabase: SupabaseClient,
  userId: string,
  userRoles: string[]
): Promise<AgentResponse> {
  const traceId = `trace-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`[Agent] Starting pipeline, trace: ${traceId}`);
  console.log(`[Agent] User roles: ${userRoles.join(', ')}`);
  
  try {
    // Step 1: Extract intent
    const intent = await extractIntent(messages, userRoles);
    console.log(`[Agent] Intent: ${intent}`);
    
    // Step 2: Select action
    const actionSelection = await selectAction(messages, userRoles, intent);
    console.log(`[Agent] Selected action: ${actionSelection.actionName || 'none'}`);
    console.log(`[Agent] Params: ${JSON.stringify(actionSelection.params)}`);
    
    // Handle no-action cases (help, navigation, general questions)
    if (!actionSelection.actionName) {
      const response = await synthesizeResponse(messages, intent, actionSelection, null, userRoles);
      return {
        assistantMessage: response,
        traceId,
      };
    }
    
    // Get the action definition
    const action = getAction(actionSelection.actionName);
    if (!action) {
      return {
        assistantMessage: `I couldn't find the action "${actionSelection.actionName}". Please try rephrasing your request.`,
        traceId,
      };
    }
    
    // Step 3: For write actions, return proposed action for confirmation
    if (action.mode === 'write') {
      console.log(`[Agent] Write action requires confirmation`);
      return {
        assistantMessage: `I can help you with that. I'm proposing to execute the following action:`,
        proposedAction: {
          actionName: actionSelection.actionName,
          params: actionSelection.params,
          description: `${action.description}\n\nParameters: ${JSON.stringify(actionSelection.params, null, 2)}`,
          requiresConfirmation: true,
        },
        traceId,
      };
    }
    
    // Step 3: Execute read action immediately
    const actionResult = await executeAction(
      actionSelection.actionName,
      actionSelection.params,
      supabase,
      userId,
      userRoles
    );
    console.log(`[Agent] Action result: ${actionResult.success ? 'success' : 'failed'}`);
    
    // Step 4: Synthesize response
    const response = await synthesizeResponse(messages, intent, actionSelection, actionResult, userRoles);
    
    return {
      assistantMessage: response,
      actionResult,
      traceId,
    };
    
  } catch (error: any) {
    console.error(`[Agent] Pipeline error:`, error);
    return {
      assistantMessage: `I encountered an error: ${error.message}. Please try again.`,
      traceId,
    };
  }
}

// ==================== Execute Confirmed Action ====================

export async function executeConfirmedAction(
  actionName: string,
  params: Record<string, any>,
  supabase: SupabaseClient,
  userId: string,
  userRoles: string[]
): Promise<{ result: ActionResult; assistantMessage: string }> {
  console.log(`[Agent] Executing confirmed action: ${actionName}`);
  
  const result = await executeAction(actionName, params, supabase, userId, userRoles);
  
  // Generate a follow-up message
  let assistantMessage: string;
  if (result.success) {
    assistantMessage = result.message + '\n\nIs there anything else I can help you with?';
  } else {
    assistantMessage = `The action failed: ${result.message}\n\nWould you like to try again or do something else?`;
  }
  
  return { result, assistantMessage };
}
