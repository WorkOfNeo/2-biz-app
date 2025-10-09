'use client';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { supabase } from '../../../../lib/supabaseClient';

export default function SeasonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data: season } = useSWR(id ? `season:${id}` : null, async () => {
    const { data, error } = await supabase.from('seasons').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return data as { id: string; name: string; year: number | null; created_at: string };
  });
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Season</h2>
      {season && (
        <div className="border rounded-md p-4">
          <div><strong>Name:</strong> {season.name}</div>
          <div><strong>Year:</strong> {season.year ?? '-'}</div>
          <div><strong>Created:</strong> {new Date(season.created_at).toLocaleString()}</div>
        </div>
      )}
      <div className="text-sm text-gray-600">More details and actions will appear here.</div>
    </div>
  );
}


