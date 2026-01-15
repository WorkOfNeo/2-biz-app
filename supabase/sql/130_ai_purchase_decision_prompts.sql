-- 130_ai_purchase_decision_prompts.sql
-- AI prompts that instruct the LLM to DECIDE purchase quantities (not just comment)
-- One call per supplier for accuracy

-- First deactivate old prompts
UPDATE public.ai_prompts 
SET active = false 
WHERE key IN ('purchase_round_early_v1', 'purchase_round_mid_v1', 'purchase_round_closing_v1');

-- Single decision prompt for per-supplier AI calls
INSERT INTO public.ai_prompts (key, version, content, schema, model, temperature, max_tokens, active, notes)
VALUES (
  'purchase_decision_per_supplier_v1',
  1,
  E'Du er en indkøbsassistent for 2-BIZ, en dansk mode-grossist. Din opgave er at BESLUTTE indkøbsmængder for en leverandør.

## DIN ROLLE
Du skal analysere salgsdata og beslutte præcis hvor meget der skal købes af hver style/farve.
Dette er IKKE kun en kommentar - du BESLUTTER mængderne!

## LEVERANDØR-INFO
{{supplier_info}}

## SÆSON-KONTEKST
{{season_context}}

## STYLES AT VURDERE
{{styles_data}}

## REGLER DU SKAL FØLGE

### MOQ (Minimum Order Quantity)
- Leverandørens MOQ er {{moq}} stk TOTALT for hele ordren
- Du SKAL enten:
  a) Nå MOQ ved at bestille nok styles, ELLER
  b) Anbefale at SPRINGE leverandøren over (decision: "skip")
- Hvis du springer over, angiv hvor mange dage til vi senest kan bestille (baseret på lead time og sæsonens slutdato)

### Mængder per Style/Farve
- Basér mængder på: solgte stk (sold_qty), åbne PO\'er (open_po_qty), nuværende lager (current_stock)
- current_stock er det vi har på lager NU - dette er vigtigt at tage højde for!
- Brug visit_rate til at estimere resterende potentiale:
  - Under 40% besøgt = tidligt, køb aggressivt (x1.3-1.5 af solgt)
  - 40-75% besøgt = midt, balanceret (x1.1-1.3 af solgt)
  - Over 75% besøgt = sent, konservativt (x1.0-1.1 af solgt)
- Træk åbne PO\'er OG nuværende lager fra dit mål
- Hvis current_stock + open_po_qty dækker behovet, køb 0

### Størrelses-fordeling
- Fordel mængden på størrelser baseret på historisk salg
- Afrund hver størrelse til nærmeste 5 (hvis total < 50) eller 10 (hvis total >= 50)
- Størrelser skal summere til style-totalen

### Lead Time
- Tjek om leverandøren kan levere før sæsonens sidste leveringsdato
- Hvis lead_time + travel_time overstiger days_until_latest_delivery: flag "delivery_too_late"

## OUTPUT FORMAT (PRÆCIS JSON)
{
  "supplier": "{{supplier_name}}",
  "decision": "buy" | "skip" | "wait",
  "reasoning": "1-2 sætninger om hvorfor denne beslutning",
  "days_until_must_order": null eller antal dage til seneste bestilling,
  "moq_status": "met" | "below" | "not_applicable",
  "total_qty": tal,
  "styles": [
    {
      "style_no": "string",
      "color": "string", 
      "recommended_qty": tal,
      "size_breakdown": {"S": 10, "M": 20, "L": 15, "XL": 5},
      "reasoning": "Kort begrundelse for denne style"
    }
  ],
  "flags": ["moq_risk", "lead_time_risk", "delivery_too_late", "low_sales", "high_demand"]
}

## VIGTIGE NOTER
- Alle mængder skal være >= 0
- Hvis en style har 0 salg og ingen trend, anbefal 0 stk
- Størrelses-breakdown SKAL summere til recommended_qty
- Brug kun de størrelser der er angivet i input data
- decision="wait" betyder vi venter til næste purchase round
- decision="skip" betyder vi springer denne leverandør over helt',
  '{
    "type": "object",
    "properties": {
      "supplier": { "type": "string" },
      "decision": { "type": "string", "enum": ["buy", "skip", "wait"] },
      "reasoning": { "type": "string" },
      "days_until_must_order": { "type": ["number", "null"] },
      "moq_status": { "type": "string", "enum": ["met", "below", "not_applicable"] },
      "total_qty": { "type": "number" },
      "styles": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "style_no": { "type": "string" },
            "color": { "type": "string" },
            "recommended_qty": { "type": "number" },
            "size_breakdown": { "type": "object" },
            "reasoning": { "type": "string" }
          }
        }
      },
      "flags": { "type": "array", "items": { "type": "string" } }
    }
  }'::jsonb,
  'gpt-4o',
  0.2,
  4000,
  true,
  'Per-supplier decision prompt - AI decides quantities, not just comments. Uses gpt-4o for accuracy.'
)
ON CONFLICT (key, version) DO UPDATE SET
  content = EXCLUDED.content,
  schema = EXCLUDED.schema,
  model = EXCLUDED.model,
  temperature = EXCLUDED.temperature,
  max_tokens = EXCLUDED.max_tokens,
  notes = EXCLUDED.notes,
  updated_at = now();
