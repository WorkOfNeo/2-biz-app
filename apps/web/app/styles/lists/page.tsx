'use client';

import useSWR from 'swr';
import Link from 'next/link';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../lib/supabaseClient';

export default function StyleListsIndexPage() {
	const supabase = createClientComponentClient();
	const { has } = useRoles();
	const isAdmin = has('admin');

	const { data: lists } = useSWR(isAdmin ? 'stock-lists:all' : null, async () => {
		const { data, error } = await supabase.from('stock_lists').select('id, name').order('name', { ascending: true });
		if (error) throw error;
		return (data ?? []) as Array<{ id: string; name: string }>;
	});

	if (!isAdmin) {
		return (
			<div className="rounded-md border bg-white p-3 text-sm text-gray-600">Not authorized.</div>
		);
	}

	return (
		<div className="space-y-3">
			<div>
				<div className="text-xs text-gray-500">Styles</div>
				<h1 className="text-xl font-semibold">Style Lists</h1>
			</div>
			<div className="rounded-md border bg-white p-3">
				<div className="text-sm mb-2">Select a list</div>
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
					{(lists ?? []).map((row) => (
						<Link
							key={row.id}
							className="border rounded px-3 py-2 text-sm hover:bg-slate-50"
							href={`/styles/lists/${row.id}`}
						>
							{row.name}
						</Link>
					))}
					{(lists?.length || 0) === 0 && (
						<div className="text-xs text-gray-500">No lists yet. Create one in Settings → Styles.</div>
					)}
				</div>
			</div>
		</div>
	);
}


