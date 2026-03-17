/**
 * Salesmen Email Handler
 * Sends scheduled salesperson statistics to individual salespersons
 */

import { sendEmailCore, type EmailResult, type LogFn } from './core.js';

/**
 * Payload for salesmen emails (from cron job)
 */
export interface SalesmenEmailPayload {
  recipient?: string;
  recipients?: string[];
  subject: string;
  body: string;
  context?: string;
  contextId?: string;
  contextName?: string;
  templateParams?: {
    salesman_pdf?: string;
    countries_pdf_url?: string;
    top15_salesmen_pdf?: string;
    [key: string]: string | undefined;
  };
}

/**
 * Sends a salesmen statistics email.
 * Called by the worker when processing 'send_email' jobs with context='salesmen_schedule'
 */
export async function sendSalesmenEmail(
  payload: SalesmenEmailPayload,
  log: LogFn
): Promise<EmailResult> {
  const { recipient, recipients, subject, body, contextId, contextName, templateParams } = payload;
  
  await log('info', `Processing salesmen statistics email for schedule "${contextName}"`, {
    scheduleId: contextId,
    scheduleName: contextName,
    recipient,
    recipients,
    recipientCount: recipients?.length || (recipient ? 1 : 0),
    hasSalesmanPdf: !!templateParams?.salesman_pdf,
    hasCountries: !!templateParams?.countries_pdf_url,
    hasTop15: !!templateParams?.top15_salesmen_pdf,
  });

  return sendEmailCore(
    {
      recipient,
      recipients,
      subject,
      body,
      context: 'salesmen_schedule',
      contextId,
      contextName,
      templateParams: templateParams as Record<string, string>,
    },
    log
  );
}


