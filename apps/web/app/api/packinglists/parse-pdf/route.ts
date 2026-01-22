import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type PackinglistSectionLine = {
  model: string;
  modelType: string | null;
  articleNumber: string | null;
  color: string | null;
  sizes: Record<string, number>;
  totalQty: number;
};

type PackinglistSection = {
  bellRainOrderNo: string | null;
  bizPoNo: string | null;
  lines: PackinglistSectionLine[];
};

type PackinglistParseResult = {
  templateId: string;
  templateName: string;
  deliveryDate: string | null;
  sections: PackinglistSection[];
};

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 });
    }

    // Convert PDF to base64 for GPT-4o vision
    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // Call GPT-4o with vision to parse the PDF
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert at parsing packing slip PDFs from Bell Rain. Extract all order information including:
- Delivery date
- Each section with "Our order nr." and "Your order nr."
- For each table row, extract:
  - Model name
  - Model type (e.g., TROUSER)
  - Article number (may include order numbers like "KARCEMONA / 6285")
  - Color
  - Quantities for each size (34, 36, 38, 40, 42, 44, 46)
  - Total quantity

Return ONLY valid JSON matching this exact structure:
{
  "templateId": "bell-rain",
  "templateName": "Bell Rain",
  "deliveryDate": "22 January 2026" or null,
  "sections": [
    {
      "bellRainOrderNo": "BR250022" or null,
      "bizPoNo": "6278 / 6285" or null,
      "lines": [
        {
          "model": "KARCAMONA",
          "modelType": "TROUSER" or null,
          "articleNumber": "KARCEMONA / 6285" or null,
          "color": "BLACK" or null,
          "sizes": { "34": 5, "36": 13, "38": 0, "40": 0, "42": 0, "44": 0, "46": 0 },
          "totalQty": 18
        }
      ]
    }
  ]
}

Important:
- Extract sizes accurately from the table columns
- If article number spans multiple lines, merge them (e.g., "KARCEMONA /" on one line and "6285" on next should become "KARCEMONA / 6285")
- Only include rows that have actual quantities (totalQty > 0)
- Calculate totalQty as the sum of all size quantities
- Return valid JSON only, no markdown formatting`
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:application/pdf;base64,${base64}`,
              },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4000,
    });

    const responseText = completion.choices[0]?.message?.content || '{}';
    let result: PackinglistParseResult;
    
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      console.error('[parse-pdf] Failed to parse AI response:', e);
      return NextResponse.json(
        { error: 'Failed to parse AI response', raw: responseText.slice(0, 500) },
        { status: 500 }
      );
    }

    // Validate and ensure structure
    if (!result.sections || !Array.isArray(result.sections)) {
      result.sections = [];
    }

    // Ensure all lines have proper structure
    for (const section of result.sections) {
      if (!section.lines || !Array.isArray(section.lines)) {
        section.lines = [];
      }
      for (const line of section.lines) {
        if (!line.sizes) {
          line.sizes = { '34': 0, '36': 0, '38': 0, '40': 0, '42': 0, '44': 0, '46': 0 };
        }
        // Recalculate totalQty from sizes
        line.totalQty = Object.values(line.sizes).reduce((sum, qty) => sum + (Number(qty) || 0), 0);
      }
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[parse-pdf] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to parse PDF' },
      { status: 500 }
    );
  }
}
