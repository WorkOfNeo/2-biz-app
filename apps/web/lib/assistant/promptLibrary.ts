/**
 * Curated Prompt Library for the Agentic Chat
 * 
 * This file contains example prompts organized by category.
 * Testers can use these to quickly test the assistant's capabilities.
 * 
 * NOTE: Keep this file updated when adding new actions or capabilities.
 */

export interface PromptCategory {
  name: string;
  description: string;
  prompts: PromptExample[];
}

export interface PromptExample {
  text: string;
  description?: string;
  expectedAction?: string; // For testing: which action should be triggered
}

export const PROMPT_LIBRARY: PromptCategory[] = [
  {
    name: 'Stock Queries',
    description: 'Questions about current stock levels and availability',
    prompts: [
      {
        text: 'What is the current stock for style RANY WHITE?',
        description: 'Look up stock for a specific style/color',
        expectedAction: 'get_style_stock',
      },
      {
        text: 'Show me the stock levels for KAXY',
        description: 'Get all colors for a style',
        expectedAction: 'get_style_stock',
      },
      {
        text: 'How much ILLIE BLACK do we have in stock?',
        description: 'Natural language stock query',
        expectedAction: 'get_style_stock',
      },
      {
        text: 'Check stock position for style 1010191',
        description: 'Query by style number',
        expectedAction: 'get_style_stock',
      },
      {
        text: 'What colors are available for RANY?',
        description: 'Get color variants',
        expectedAction: 'get_style_stock',
      },
    ],
  },
  {
    name: 'Purchase Orders',
    description: 'Questions about purchase orders and their status',
    prompts: [
      {
        text: 'Show me recent purchase orders',
        description: 'List recent POs',
        expectedAction: 'get_purchase_orders',
      },
      {
        text: 'What POs are currently running?',
        description: 'Filter by Running status',
        expectedAction: 'get_purchase_orders',
      },
      {
        text: 'List draft purchase orders',
        description: 'Filter by Draft status',
        expectedAction: 'get_purchase_orders',
      },
      {
        text: 'Show me the last 5 purchase orders',
        description: 'Limit results',
        expectedAction: 'get_purchase_orders',
      },
      {
        text: 'Get details for PO-2024-001',
        description: 'Get specific PO details',
        expectedAction: 'get_purchase_order_details',
      },
    ],
  },
  {
    name: 'Sales Orders',
    description: 'Questions about sales orders and customers',
    prompts: [
      {
        text: 'Show me recent sales orders',
        description: 'List recent sales',
        expectedAction: 'get_sales_orders',
      },
      {
        text: 'What orders do we have from customer ABC?',
        description: 'Filter by customer',
        expectedAction: 'get_sales_orders',
      },
      {
        text: 'List the last 10 sales orders',
        description: 'Limit results',
        expectedAction: 'get_sales_orders',
      },
      {
        text: 'Show sales for Nielsens',
        description: 'Customer name search',
        expectedAction: 'get_sales_orders',
      },
    ],
  },
  {
    name: 'Statistics & Overview',
    description: 'General business statistics and KPIs',
    prompts: [
      {
        text: 'Give me a quick overview of the business',
        description: 'Get statistics snapshot',
        expectedAction: 'get_statistics_snapshot',
      },
      {
        text: 'What season are we in?',
        description: 'Current season info',
        expectedAction: 'get_statistics_snapshot',
      },
      {
        text: 'How many active suppliers do we have?',
        description: 'Supplier count',
        expectedAction: 'get_statistics_snapshot',
      },
      {
        text: 'How many styles are in the system?',
        description: 'Style count',
        expectedAction: 'get_statistics_snapshot',
      },
    ],
  },
  {
    name: 'Create Actions (Write)',
    description: 'Actions that create or modify data (require confirmation)',
    prompts: [
      {
        text: 'Create a draft purchase order for Bell Rain with 100 pcs of RANY WHITE',
        description: 'Create draft PO - requires confirmation',
        expectedAction: 'create_draft_purchase_order',
      },
    ],
  },
  {
    name: 'Help & Navigation',
    description: 'General help and system navigation',
    prompts: [
      {
        text: 'What can you help me with?',
        description: 'Get help on capabilities',
        expectedAction: null,
      },
      {
        text: 'How do I check stock levels?',
        description: 'Feature guidance',
        expectedAction: null,
      },
      {
        text: 'What actions can you perform?',
        description: 'List available actions',
        expectedAction: null,
      },
      {
        text: 'Where do I find purchase orders?',
        description: 'Navigation help',
        expectedAction: null,
      },
    ],
  },
];

// Helper to get all prompts as a flat list
export function getAllPrompts(): PromptExample[] {
  return PROMPT_LIBRARY.flatMap(category => category.prompts);
}

// Helper to get prompts for a specific expected action
export function getPromptsForAction(actionName: string | null): PromptExample[] {
  return getAllPrompts().filter(p => p.expectedAction === actionName);
}

// Export a simple version for the UI (without metadata)
export function getSimplePromptLibrary(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const category of PROMPT_LIBRARY) {
    result[category.name] = category.prompts.map(p => p.text);
  }
  return result;
}
