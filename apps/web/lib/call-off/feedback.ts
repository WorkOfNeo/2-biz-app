/**
 * Helper functions for call-off feedback
 */

/**
 * Get feedback summary for AI prompt
 */
export async function getFeedbackSummaryForAI(
  supabase: any,
  styleNos: string[],
  colors: string[],
  limit: number = 20
): Promise<string> {
  try {
    const { data } = await supabase
      .from('call_off_feedback')
      .select('style_no, color, verdict, notes, created_at')
      .in('style_no', styleNos)
      .in('color', colors)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!data || data.length === 0) {
      return '';
    }

    const correct = data.filter((f: any) => f.verdict === 'correct').length;
    const incorrect = data.filter((f: any) => f.verdict === 'incorrect').length;

    let summary = `\n\nPREVIOUS FEEDBACK (${data.length} entries, ${correct} correct, ${incorrect} incorrect):\n`;
    
    // Add notable feedback notes
    const withNotes = data.filter((f: any) => f.notes);
    if (withNotes.length > 0) {
      summary += 'User notes:\n';
      withNotes.slice(0, 5).forEach((f: any) => {
        summary += `- ${f.style_no} ${f.color} (${f.verdict}): ${f.notes}\n`;
      });
    }

    return summary;
  } catch {
    return '';
  }
}







