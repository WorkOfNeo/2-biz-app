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

    const systemMessage = `You are a customer name matcher for a Scandinavian fashion wholesale company.
Your ONLY job is to match customer names from input lines to a customer list, and classify a null action.

COMMENT RULE — NEVER BREAK THIS:
The "comment_da" field must ALWAYS be written in Danish, regardless of the input language.
Translate Swedish, Norwegian, and English notes into Danish. Never output Swedish, Norwegian, or English in "comment_da".
If there is no note, set "comment_da" to an empty string "".`;

    const userPrompt = `Each input line is a customer that should be NULLED in our system.
The format is typically: "[Customer name] [optional: 0] [optional: reason/note]"
The "0" is just a separator token — ignore it when extracting the name.

YOUR TASK FOR EACH LINE:
1. Extract the customer name from the beginning of the line (everything before "0" or the note text)
2. Find the best fuzzy match in the customer list below. Be generous — match abbreviations, partial names, word reordering, minor typos, and name variations. A name like "Centrum" should match "Centrum ApS" at 90%+.
3. Set null_action — DEFAULT IS "nulled". Only change it if the note explicitly says otherwise:
   - "permanently_closed" ONLY IF: the note says the store is closing/closed/sold permanently (stänger, stängt, lukker, lukket, stenger, closed, slutter)
   - "none" ONLY IF: the note clearly says they might buy in the future (kanske köper, planerar köpa, overvejer, måske køber, ny ejer der vil købe)
   - "nulled" IN ALL OTHER CASES — including when there is no note, when "0" is the only marker, or when the note mentions unpaid invoices, stopped buying, hasn't ordered in years, etc.
4. Write comment_da in DANISH. Translate from Swedish/Norwegian/English if needed. Empty string if no note.

Examples of null_action decisions:
- "Centrum" → nulled (no note, default)
- "Centrum 0" → nulled ("0" is a null marker)
- "Centrum 0 många obetalda fakturor" → nulled (unpaid invoices)
- "Modecompaniet stängt" → permanently_closed
- "Mode Eva 0 nya ägare som planerar att köpa 2-Biz till hösten" → none (planning to buy)
- "Melio 0 slutar köpa 2-Biz" → nulled (stops buying)
- "Kanada Damshop stänger butiken" → permanently_closed

Translation examples for comment_da (always Danish output):
- "stänger butiken" → "Lukker butikken"
- "slutar köpa 2-Biz" → "Stopper med at købe 2-Biz"
- "har inte handlat på flera år" → "Har ikke handlet i flere år"
- "många obetalda fakturor" → "Mange ubetalte fakturaer"
- "skall sälja butiken i höst men kanske köper lite" → "Skal sælge butikken til efteråret, men køber måske lidt"
- "nya ägare som planerar att köpa 2-Biz till hösten" → "Nye ejere som planlægger at købe 2-Biz til efteråret"
- "har sålt butiken till annan ägare" → "Har solgt butikken til ny ejer"
- "closing the store" → "Lukker butikken"
- "vill ej köpa 2-Biz" → "Vil ikke købe 2-Biz"

CONFIDENCE SCORING — be generous, these are real business customers:
- 95-100: exact match or match with only legal suffix difference (ApS, AB, A/S, GmbH)
- 80-94: strong match — abbreviation, one word different, word order swapped
- 65-79: probable match — partial name, one word missing, minor variation
- 40-64: uncertain — could be the right customer but ambiguous
- 0-39: no reasonable match — set account_no and name to null

Customer list:
${customerList}

Input lines to process:
${inputs.map((n, i) => `${i}: ${n}`).join('\n')}

Return a JSON object with a "matches" array. Each element:
{
  "input": "<original input line>",
  "extracted_name": "<customer name extracted from the line>",
  "account_no": "<account_no from the list, or null if no match>",
  "name": "<matched customer name from the list, or null>",
  "confidence": <0-100>,
  "null_action": "permanently_closed" | "nulled" | "none",
  "comment_da": "<note translated to Danish, or empty string>"
}

Return only valid JSON.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userPrompt },
      ],
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
