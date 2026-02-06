# Purchase Patterns - Better Strategy

## Current Problem
The current "Purchase Patterns" dashboard tracks **user adjustments** (how much you manually change AI suggestions). But this isn't the right metric because:

- You're iterating on the **AI prompts** themselves in the database
- Changes happen at the prompt level, not in the purchase UI
- You want to see which **prompt versions** perform better
- The feedback loop is: Prompt → AI Output → Evaluation → New Prompt

## Better Approach: Prompt Performance Tracking

### What to Track

1. **Prompt Version Performance**
   - Which prompt versions have higher approval rates?
   - Which prompts lead to fewer skips?
   - Which prompts get quantities closer to what you want?

2. **Prompt Evolution Over Time**
   - Trend line: Is approval rate improving as prompts evolve?
   - Version comparison: v3 vs v4 vs v5
   - Regression detection: Did a new prompt make things worse?

3. **Prompt Context Performance**
   - Does prompt X work better for "early" stage?
   - Does prompt Y work better for certain suppliers?
   - Does prompt Z handle MOQ better?

### Data We Have

From `purchase_ai_runs` and `purchase_ai_line_feedback`:
- `prompt_key` - which prompt was used
- `prompt_version` - which version
- `verdict` - approved/adjusted/skipped
- `suggested_qty` vs `adjusted_qty` - how close was AI?
- `purchase_stage` - context (early/mid/closing)
- `supplier_name` - which supplier

### Recommended Dashboard Structure

#### Tab 1: Prompt Performance Overview
**Cards:**
- Current Active Prompt: `purchase_decision_per_supplier_v1 v5`
- Current Approval Rate: `72%` (↑ 8% from v4)
- Avg Adjustment Ratio: `1.15x` (AI suggests too little)
- Most Recent Run: `2 hours ago`

**Chart:** Approval Rate by Prompt Version
- X-axis: Prompt versions (v1, v2, v3, v4, v5)
- Y-axis: Approval rate %
- Shows trend of improvement

#### Tab 2: Version Comparison
**Table:** Detailed version metrics
| Version | Rounds | Suggestions | Approved | Adjusted | Skipped | Approval Rate | Active |
|---------|--------|-------------|----------|----------|---------|---------------|--------|
| v5      | 12     | 245         | 176      | 58       | 11      | 71.8%         | ✓      |
| v4      | 8      | 189         | 120      | 54       | 15      | 63.5%         |        |
| v3      | 5      | 142         | 75       | 52       | 15      | 52.8%         |        |

**Insights:**
- "v5 improved approval rate by 8.3% over v4"
- "v5 reduced skip rate from 7.9% to 4.5%"
- "Best performing prompt for early stage: v5 (78% approval)"

#### Tab 3: Context-Specific Performance
**By Stage:**
- Early: v5 = 78% approval, v4 = 65% approval
- Mid: v5 = 72% approval, v4 = 64% approval  
- Closing: v5 = 68% approval, v4 = 61% approval

**By Supplier Type:**
- High MOQ suppliers: v5 = 65% approval (better MOQ handling)
- Low lead time suppliers: v5 = 80% approval
- International suppliers: v5 = 71% approval

#### Tab 4: Prompt Change Log
**Timeline of Changes:**
```
v5 (2024-02-05) - Active
✓ Added country-aware waiting logic
✓ Changed formula to (net_need × 1.4) + 50
✓ Improved MOQ enforcement
→ Result: +8.3% approval rate

v4 (2024-01-28)
- Added purchase stage awareness
- Adjusted for supplier lead times
→ Result: +10.7% approval rate

v3 (2024-01-20)
- Initial prompt with basic logic
→ Result: 52.8% approval baseline
```

### Implementation

**API Endpoint:** `/api/purchase/prompt-performance`

Query:
```sql
SELECT 
  r.prompt_key,
  r.prompt_version,
  r.purchase_stage,
  COUNT(DISTINCT r.id) as round_count,
  COUNT(f.id) as total_suggestions,
  SUM(CASE WHEN f.verdict = 'approved' THEN 1 ELSE 0 END) as approved_count,
  SUM(CASE WHEN f.verdict = 'adjusted' THEN 1 ELSE 0 END) as adjusted_count,
  SUM(CASE WHEN f.verdict = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
  AVG(CASE 
    WHEN f.verdict = 'adjusted' AND f.suggested_qty > 0
    THEN f.adjusted_qty::float / f.suggested_qty
  END) as avg_adjustment_ratio
FROM purchase_ai_runs r
LEFT JOIN purchase_ai_line_feedback f ON f.purchase_run_id = r.id
WHERE r.status = 'completed'
  AND r.prompt_key = 'purchase_decision_per_supplier_v1'
GROUP BY r.prompt_key, r.prompt_version, r.purchase_stage
ORDER BY r.prompt_version DESC, r.purchase_stage;
```

**UI Component:** `apps/web/app/purchase/prompt-performance/page.tsx`

### Benefits

1. ✅ **Tracks what matters**: Prompt iteration, not user tweaking
2. ✅ **Shows improvement**: Clear trend as prompts evolve
3. ✅ **Context-aware**: Shows which prompts work in which situations
4. ✅ **Actionable**: "v5 is 8% better than v4 - keep it active"
5. ✅ **Regression detection**: "v6 made things worse - rollback"

### Migration Path

1. Keep current "Purchase Patterns" for now (shows user behavior)
2. Add new "Prompt Performance" dashboard (shows AI improvement)
3. Eventually combine insights or deprecate one

## Decision

**Option A:** Transform "Purchase Patterns" → "Prompt Performance"
- Pros: Cleaner, more focused
- Cons: Loses user behavior insights

**Option B:** Add "Prompt Performance" as separate feature
- Pros: Both perspectives available
- Cons: More UI complexity

**Recommendation:** Option B initially, then Option A once we validate the approach.

## Next Steps

1. Run the SQL fix to enable APP PO deletion
2. Decide if we want Prompt Performance dashboard
3. If yes, implement it following the structure above
