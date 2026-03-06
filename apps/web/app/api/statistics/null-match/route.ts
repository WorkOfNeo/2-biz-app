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

    const prompt = `Du er assistent for det skandinaviske modeengrosfirma 2-Biz.
Salgsmedarbejdere har skrevet en liste med kundenoter på dansk, svensk, norsk eller engelsk.
Hver inputlinje repræsenterer én kunde, typisk i formatet:
  "[Kundenavn] [valgfrit: 0] [valgfrit: årsag/note]"

Det "0" der evt. forekommer efter kundenavnet er blot et separatortegn — ignorer det, det er IKKE en del af hverken navn eller note.

Din opgave for hver linje:
1. Udtræk kundenavnet fra starten af linjen (alt før "0" eller noteteksten)
2. Fuzzy-match det udtrukne navn mod den vedlagte kundeliste (håndter forkortelser, delvise navne, stavefejl, omordning af ord og navnevariationer)
3. Bestem den korrekte null-handling baseret på noteteksten:
   - "permanently_closed": butikken lukker, er lukket, er solgt uden fortsættelse, eller stopper permanent alle køb
   - "nulled": stopper køb hos 2-Biz, har ikke handlet i årevis, vil ikke købe, eller har alvorlige problemer (ubetalte fakturaer uden fremtidigt købsintention)
   - "none": situationen er uklar, der er mulighed for fremtidige køb, nye ejere overvejer køb, eller noten er rent informativ
4. Skriv kommentaren på DANSK — uanset om inputtet er på svensk, norsk eller engelsk, skal kommentaren altid skrives på dansk. Kommentaren er notens indhold omsat til dansk.

Regel for null-handling:
- "permanently_closed": stänger, stängt, stänger butiken, slutter, lukker, lukket, stenger, closed, stänger för gott, säljer butiken (uden købekontinuation), lukker butikken, stenger butikken
- "nulled": slutar köpa, vill ej köpa, vil ikke kjøpe, vil ikke købe, har ikke handlet, har inte handlat på flere år, obetalda fakturor, ubetalte fakturaer, slutar, stopper med at købe
- "none": kanske köper, planerar att köpa, nye eiere som planerer, nya ägare som planerar, ny ejer, muligens, måske, overvejer, kanske, mulig, possible

Kundeliste (indeks: navn (kontonummer)):
${customerList}

Inputlinjer der skal behandles:
${inputs.map((n, i) => `${i}: ${n}`).join('\n')}

Returner et JSON-objekt med et "matches"-array. Hvert element skal have præcis disse felter:
{
  "input": "<den originale inputlinje>",
  "extracted_name": "<kundenavnet du udtrukket fra linjen>",
  "account_no": "<kontonummer eller null hvis ingen sikker match>",
  "name": "<matchet kundenavn fra listen, eller null>",
  "confidence": <0-100>,
  "null_action": "permanently_closed" | "nulled" | "none",
  "comment_da": "<noteteksten skrevet på dansk, eller tom streng hvis ingen note>"
}

Confidence-guide:
- 90-100: eksakt eller næsten eksakt match
- 70-89: stærk match (forkortelse, lille variation, ordrækkefølge)
- 50-69: mulig match (delvist navn, tvetydigt)
- 0-49: ingen god match — sæt account_no og name til null

Returner kun gyldigt JSON.`;

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
