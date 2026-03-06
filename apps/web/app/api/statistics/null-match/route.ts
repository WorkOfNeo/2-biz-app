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

    const systemMessage = `Du er assistent for det skandinaviske modeengrosfirma 2-Biz.

KRITISK REGEL — MÅ ALDRIG BRYDES:
Feltet "comment_da" skal ALTID skrives på DANSK, uanset hvilket sprog inputtet er på.
Hvis inputtet er på svensk → oversæt til dansk.
Hvis inputtet er på norsk → oversæt til dansk.
Hvis inputtet er på engelsk → oversæt til dansk.
Skriv ALDRIG svensk, norsk eller engelsk i "comment_da". Kun og udelukkende dansk.
Hvis der ikke er nogen note i inputlinjen, sæt "comment_da" til en tom streng "".`;

    const userPrompt = `Salgsmedarbejdere har skrevet kundenoter på dansk, svensk, norsk eller engelsk.
Hver inputlinje repræsenterer én kunde, typisk i formatet:
  "[Kundenavn] [valgfrit: 0] [valgfrit: årsag/note]"

"0" efter kundenavnet er et separatortegn — ignorer det.

Opgave per linje:
1. Udtræk kundenavnet (alt før "0" eller noteteksten)
2. Fuzzy-match mod kundelisten (forkortelser, stavefejl, delvist navn, omordning)
3. Bestem null_action:
   - "permanently_closed": butikken lukker/er lukket/solgt uden fortsættelse af køb
   - "nulled": stopper køb, har ikke handlet i årevis, vil ikke købe, ubetalte fakturaer uden fremtidig intention
   - "none": uklar situation, mulighed for fremtidige køb, ny ejer overvejer, rent informativ note
4. Skriv comment_da på DANSK (oversæt fra svensk/norsk/engelsk). Tom streng hvis ingen note.

Oversættelseseksempler (HUSK: altid til dansk):
- "stänger butiken" → "Lukker butikken"
- "slutar köpa 2-Biz" → "Stopper med at købe 2-Biz"
- "har inte handlat på flera år" → "Har ikke handlet i flere år"
- "skall sälja butiken i höst men kanske köper lite på early autumn" → "Skal sælge butikken til efteråret, men køber måske lidt til early autumn"
- "nya ägare som planerar att köpa 2-Biz till hösten" → "Nye ejere som planlægger at købe 2-Biz til efteråret"
- "closing the store" → "Lukker butikken"
- "har sålt butiken till annan ägare" → "Har solgt butikken til ny ejer"

Null-handling nøgleord:
- permanently_closed: stänger, stängt, lukker, lukket, slutter, stenger, closed, säljer butiken (uden fortsættelse), stänger butiken
- nulled: slutar köpa, vill ej köpa, vil ikke kjøpe, har ikke handlet, har inte handlat, obetalda fakturor, ubetalte fakturaer, slutar, "0" (som enkelt tegn/ord), "null", "nullet", "nul" — disse ord i noten betyder eksplicit at kunden skal nulles
- none: kanske köper, planerar att köpa, nya ägare planerar, ny ejer overvejer, måske, muligens

Kundeliste (indeks: navn (kontonummer)):
${customerList}

Inputlinjer:
${inputs.map((n, i) => `${i}: ${n}`).join('\n')}

Returner JSON med "matches"-array. Hvert element:
{
  "input": "<original inputlinje>",
  "extracted_name": "<udtrukket kundenavn>",
  "account_no": "<kontonummer eller null>",
  "name": "<matchet kundenavn eller null>",
  "confidence": <0-100>,
  "null_action": "permanently_closed" | "nulled" | "none",
  "comment_da": "<note på DANSK eller tom streng>"
}

Confidence: 90-100 eksakt, 70-89 stærk, 50-69 mulig, 0-49 ingen match (account_no/name = null).
Kun gyldigt JSON.`;

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
