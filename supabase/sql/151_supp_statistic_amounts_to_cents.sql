-- 151_supp_statistic_amounts_to_cents.sql
-- Ensure supp_statistic amount columns are stored in cents.
-- Converts values that were entered as DKK (e.g. 507.30 or 500) to cents (50730, 50000).
-- Heuristic: already in cents = whole number and abs(value) >= 10000. Otherwise treat as DKK and multiply by 100.

UPDATE public.supp_statistic
SET
  telefon_beløb = CASE
    WHEN telefon_beløb = 0 THEN 0
    WHEN telefon_beløb = floor(telefon_beløb) AND abs(telefon_beløb) >= 10000 THEN telefon_beløb
    ELSE round(telefon_beløb * 100)::numeric
  END,
  b2b_beløb = CASE
    WHEN b2b_beløb = 0 THEN 0
    WHEN b2b_beløb = floor(b2b_beløb) AND abs(b2b_beløb) >= 10000 THEN b2b_beløb
    ELSE round(b2b_beløb * 100)::numeric
  END,
  krediteret_beløb = CASE
    WHEN krediteret_beløb = 0 THEN 0
    WHEN krediteret_beløb = floor(krediteret_beløb) AND abs(krediteret_beløb) >= 10000 THEN krediteret_beløb
    ELSE round(krediteret_beløb * 100)::numeric
  END,
  samlet_beløb = CASE
    WHEN samlet_beløb = 0 THEN 0
    WHEN samlet_beløb = floor(samlet_beløb) AND abs(samlet_beløb) >= 10000 THEN samlet_beløb
    ELSE round(samlet_beløb * 100)::numeric
  END;
