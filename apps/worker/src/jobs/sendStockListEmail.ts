import type { SupabaseClient } from '@supabase/supabase-js';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

interface SendStockListEmailPayload {
  scheduleId: string;
  scheduleName: string;
  listName: string;
  listUrl: string;
  recipients: string[];
  emailBody: string;
}

interface JobResult {
  success: boolean;
  message?: string;
  data?: Record<string, any>;
}

/**
 * Sends a stock list email using EmailJS.
 * This runs on the Railway worker (server-side), so we need the private key.
 */
export async function sendStockListEmail(
  supabase: SupabaseClient,
  payload: SendStockListEmailPayload,
  log: (level: 'info' | 'error' | 'progress', msg: string, data?: Record<string, any>) => Promise<void>
): Promise<JobResult> {
  const { scheduleId, scheduleName, listName, listUrl, recipients, emailBody } = payload;

  // Get EmailJS config from environment
  const serviceId = process.env.EMAILJS_SERVICE_ID || '';
  const templateId = process.env.EMAILJS_TEMPLATE_ID || '';
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || '';
  const privateKey = process.env.EMAILJS_PRIVATE_KEY || '';
  const fromEmail = process.env.EMAILJS_FROM_EMAIL || '';
  const fromName = process.env.EMAILJS_FROM_NAME || '2-BIZ';

  if (!serviceId || !templateId || !publicKey || !privateKey) {
    await log('error', 'EmailJS configuration missing', {
      hasServiceId: !!serviceId,
      hasTemplateId: !!templateId,
      hasPublicKey: !!publicKey,
      hasPrivateKey: !!privateKey,
    });
    return {
      success: false,
      message: 'EmailJS configuration missing. Set EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY',
    };
  }

  await log('info', `Sending stock list email: ${listName}`, {
    scheduleName,
    listName,
    recipientCount: recipients.length,
  });

  const subject = `${listName} - Lagerliste`;
  const filename = `${listName} - Lagerliste.pdf`;

  // Build EmailJS payload with accessToken for server-side calls
  const emailPayload = {
    service_id: serviceId,
    template_id: templateId,
    user_id: publicKey,
    accessToken: privateKey,
    template_params: {
      to_email: recipients[0] || '',
      bcc_email: recipients.slice(1).join(','),
      subject,
      message_html: emailBody || 'Hermed lagerliste :)',
      from_name: fromName,
      from_email: fromEmail,
      stock_list_1_url: listUrl,
      stock_list_1_name: listName,
      stock_list_1_filename: filename,
    },
  };

  try {
    const res = await fetch(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    });

    if (res.ok) {
      await log('info', `Successfully sent ${listName} to ${recipients.length} recipient(s)`, {
        listName,
        recipientCount: recipients.length,
      });
      return {
        success: true,
        message: `Sent ${listName} to ${recipients.length} recipient(s)`,
        data: { listName, recipientCount: recipients.length },
      };
    } else {
      const errText = await res.text();
      await log('error', `Failed to send ${listName}: ${errText}`, {
        listName,
        status: res.status,
        error: errText,
      });
      return {
        success: false,
        message: `EmailJS error: ${res.status} - ${errText}`,
      };
    }
  } catch (err: any) {
    await log('error', `Exception sending ${listName}: ${err?.message || String(err)}`, {
      listName,
      error: err?.message || String(err),
    });
    return {
      success: false,
      message: `Exception: ${err?.message || String(err)}`,
    };
  }
}

