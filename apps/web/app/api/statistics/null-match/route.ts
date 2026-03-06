import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const runtime = 'nodejs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { inputs, customers } = await req.json() as {
      inputs: string[];
      customers: { account_no: string; name: string }[];
    };

    if (!inputs?.length || !customers?.length) {
      return NextResponse.json({ error: 'inputs and customers are required' }, { status: 400 });
    }

    const customerList = customers
      .map((c, i) => `${i}: ${c.name} (${c.account_no})`)
      .join('\n');

    const prompt = `You are a fuzzy customer name matcher for a fashion wholesale company.
Match each input name to the most similar customer in the customer list.
Consider abbreviations, partial names, minor typos, name reorderings, and common variations.

Customer list (index: name (account_no)):
${customerList}

Input names to match:
${inputs.map((n, i) => `${i}: ${n}`).join('\n')}

Return a JSON object with a "matches" array. Each element must have:
{ "input": "<original input>", "account_no": "<account_no or null>", "name": "<customer name or null>", "confidence": <0-100> }

Confidence guide:
- 90-100: exact or near-exact match
- 70-89: strong match (abbreviation, slight variation, word order difference)
- 50-69: possible match (partial name, ambiguous)
- 0-49: no good match — set account_no and name to null if confidence < 30

Return only valid JSON.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content ?? '{"matches":[]}';
    const parsed = JSON.parse(text);
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];

    return NextResponse.json({ matches });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
}
