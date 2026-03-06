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

    const prompt = `You are an assistant for a Scandinavian fashion wholesale company (2-Biz).
Sales staff have written a list of customer notes in Danish, Swedish, Norwegian, or English.
Each input line represents one customer entry, typically in the format:
  "[Customer Name] [optional: 0] [optional: reason/note]"

The "0" after the name is just a separator token — ignore it, it is NOT part of the name or the note.

Your tasks for each line:
1. Extract the customer name from the beginning of the line (before any "0" or note text)
2. Match the extracted name against the provided customer list (fuzzy match — handle abbreviations, partial names, typos, word reorderings, and name variations)
3. Based on the reason/note text, propose ONE action from: "permanently_closed", "nulled", or "add_comment"
4. Extract the note/reason text as a comment (everything after the name and optional "0")

Action decision rules:
- "permanently_closed": the business is closing, has closed, has been sold without continuation, or is permanently stopping all purchases
  Scandinavian keywords: stänger, stängt, stänger butiken, slutter, lukker, lukket, stenger, closed, har stängt, stänger för gott, säljer butiken (without buying continuation)
- "nulled": stops buying from 2-Biz, hasn't bought in years, doesn't want to buy, or has serious issues (unpaid invoices with no intent to continue)
  Scandinavian keywords: slutar köpa, vill ej köpa, vil ikke kjøpe, vil ikke købe, har ikke handlet, har inte handlat på flera år, obetalda fakturor (unpaid invoices), ubetalte fakturaer
- "add_comment": the situation is uncertain, the customer might buy in the future, new owners are considering buying, or the note is purely informational
  Scandinavian keywords: kanske köper, planerar att köpa, nye eiere som planerer, nueva ägare som planerar, skall sälja men kanske, ny ejer, muligens

When in doubt between "nulled" and "permanently_closed", prefer "permanently_closed" only if the store/business is clearly shutting down entirely.
When in doubt between "nulled" and "add_comment", prefer "add_comment" if there is any hint of future purchase possibility.

Customer list (index: name (account_no)):
${customerList}

Input lines to process:
${inputs.map((n, i) => `${i}: ${n}`).join('\n')}

Return a JSON object with a "matches" array. Each element must have exactly these fields:
{
  "input": "<original input line>",
  "extracted_name": "<customer name you extracted from the line>",
  "account_no": "<account_no or null if no confident match>",
  "name": "<matched customer name from the list, or null>",
  "confidence": <0-100>,
  "action": "permanently_closed" | "nulled" | "add_comment",
  "comment": "<the note/reason text, or empty string if none>"
}

Confidence guide:
- 90-100: exact or near-exact match
- 70-89: strong match (abbreviation, slight variation, word order difference)
- 50-69: possible match (partial name, ambiguous)
- 0-49: no good match — set account_no and name to null

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
