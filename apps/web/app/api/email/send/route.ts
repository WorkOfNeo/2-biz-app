import { NextRequest, NextResponse } from 'next/server';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

export async function GET() {
  const serviceId = process.env.EMAILJS_SERVICE_ID || process.env.EMAILJS_SERVICE_KEY || '';
  const templateId = process.env.EMAILJS_TEMPLATE_ID || '';
  const publicKey = process.env.EMAILJS_PUBLIC_KEY || '';
  const fromEmail = process.env.EMAILJS_FROM_EMAIL || '';
  const fromName = process.env.EMAILJS_FROM_NAME || '';
  return NextResponse.json({
    ok: Boolean(serviceId && templateId && publicKey && fromEmail),
    has: {
      EMAILJS_SERVICE_ID_or_KEY: Boolean(serviceId),
      EMAILJS_TEMPLATE_ID: Boolean(templateId),
      EMAILJS_PUBLIC_KEY: Boolean(publicKey),
      EMAILJS_FROM_EMAIL: Boolean(fromEmail),
      EMAILJS_FROM_NAME: Boolean(fromName || true),
    }
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const to: string[] = Array.isArray(body?.to) ? body.to : [];
    const subject: string = String(body?.subject || '').slice(0, 200);
    const html: string = String(body?.html || '');
    if (!to.length) return NextResponse.json({ error: 'Missing recipients' }, { status: 400 });
    if (!subject || !html) return NextResponse.json({ error: 'Missing subject/html' }, { status: 400 });

    const serviceId = process.env.EMAILJS_SERVICE_ID || process.env.EMAILJS_SERVICE_KEY || '';
    const templateId = process.env.EMAILJS_TEMPLATE_ID || '';
    const publicKey = process.env.EMAILJS_PUBLIC_KEY || '';
    const fromEmail = process.env.EMAILJS_FROM_EMAIL || '';
    const fromName = process.env.EMAILJS_FROM_NAME || '2-BIZ';
    const missing: string[] = [];
    if (!serviceId) missing.push('EMAILJS_SERVICE_ID/EMAILJS_SERVICE_KEY');
    if (!templateId) missing.push('EMAILJS_TEMPLATE_ID');
    if (!publicKey) missing.push('EMAILJS_PUBLIC_KEY');
    if (!fromEmail) missing.push('EMAILJS_FROM_EMAIL');
    if (missing.length) {
      return NextResponse.json({ error: 'Missing environment variables', missing }, { status: 500 });
    }

    // Send one-by-one to ensure proper personalization and deliverability
    for (const recipient of to) {
      const payload = {
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        template_params: {
          from_name: fromName,
          from_email: fromEmail,
          to_email: recipient,
          subject,
          // Your EmailJS template must include a variable like {{message_html}}
          message_html: html,
        },
      } as any;
      const res = await fetch(EMAILJS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let detail: any = null;
        try { detail = await res.json(); } catch { detail = await res.text(); }
        return NextResponse.json({ error: 'Email send failed', detail }, { status: 502 });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}


