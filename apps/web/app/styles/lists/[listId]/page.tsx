'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { useMemo, useState } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRoles } from '../../../../lib/supabaseClient';

export default function StyleListDetailPage({ params }: { params: { listId: string } }) {
	const supabase = createClientComponentClient();
	const { has } = useRoles();
	const isAdmin = has('admin');
	const listId = params.listId;

	const { data: list } = useSWR(isAdmin && listId ? ['stock-lists:one', listId] : null, async () => {
		const { data, error } = await supabase.from('stock_lists').select('id, name').eq('id', listId).maybeSingle();
		if (error) throw error;
		return (data ?? null) as { id: string; name: string } | null;
	});

	const { data: styles } = useSWR(isAdmin && listId ? ['stock-list-styles:with-styles', listId] : null, async () => {
		const { data, error } = await supabase
			.from('stock_list_styles')
			.select('style:styles(id, style_no, style_name)')
			.eq('list_id', listId)
			.order('created_at', { ascending: true });
		if (error) throw error;
		// Supabase can sometimes infer joins as arrays; normalize to flat array of style objects
		const rows = (data ?? []) as Array<{ style: any }>;
		const arr = rows.flatMap((r) => Array.isArray(r.style) ? r.style : (r.style ? [r.style] : []));
		return (arr ?? []) as Array<{ id: string; style_no: string; style_name: string | null }>;
	});

	const [query, setQuery] = useState('');
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return styles ?? [];
		return (styles ?? []).filter((s) => (s.style_no || '').toLowerCase().includes(q) || (s.style_name || '').toLowerCase().includes(q));
	}, [styles, query]);

	if (!isAdmin) {
		return <div className="rounded-md border bg-white p-3 text-sm text-gray-600">Not authorized.</div>;
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<div>
					<div className="text-xs text-gray-500">Styles</div>
					<h1 className="text-xl font-semibold">{list?.name ? `List: ${list.name}` : 'Style List'}</h1>
				</div>
				<div className="text-xs">
					<Link href="/styles/lists" className="underline">All lists</Link>
				</div>
			</div>
			<div className="rounded-md border bg-white p-3">
				<div className="flex items-center justify-between">
					<div className="text-sm font-medium">Styles in list</div>
					<input
						className="text-xs border rounded px-2 py-1"
						placeholder="Search styles"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
				<div className="mt-2 space-y-2 max-h-[70vh] overflow-auto pr-1">
					{(filtered ?? []).map((s) => (
						<div key={s.id} className="border rounded">
							<div className="px-2 py-1 text-xs flex items-center justify-between">
								<div className="font-medium">{s.style_no}{s.style_name ? ` — ${s.style_name}` : ''}</div>
							</div>
							<div className="px-2 pb-2">
								<ListColorEditor listId={listId} styleId={s.id} />
							</div>
						</div>
					))}
					{(filtered?.length || 0) === 0 && (
						<div className="text-xs text-gray-500">No styles in this list.</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ListColorEditor({ listId, styleId }: { listId: string; styleId: string }) {
	const supabase = createClientComponentClient();
	// Available colors for the style
	const { data: colors } = useSWR(styleId ? ['style_colors:for-style', styleId] : null, async () => {
		const { data, error } = await supabase.from('style_colors').select('id, color').eq('style_id', styleId).order('color', { ascending: true });
		if (error) throw error;
		return (data ?? []) as Array<{ id: string; color: string }>;
	});
	// Per-list color includes
	const { data: includes, mutate } = useSWR(listId && styleId ? ['stock_list_colors:includes', listId, styleId] : null, async () => {
		const { data, error } = await supabase.from('stock_list_colors').select('style_color_id, include').eq('list_id', listId).eq('style_id', styleId);
		if (error) throw error;
		const m = new Map<string, boolean>();
		for (const r of (data ?? []) as any[]) m.set(r.style_color_id as string, r.include !== false);
		return m as Map<string, boolean>;
	});
	const [savingById, setSavingById] = useState<Record<string, boolean>>({});
	const total = (colors?.length || 0);
	const includedCount = useMemo(() => {
		if (!colors) return 0;
		let n = 0;
		for (const c of colors) {
			const on = includes?.has(c.id) ? (includes.get(c.id) as boolean) : true; // default ON when missing
			if (on) n++;
		}
		return n;
	}, [colors?.length, includes && Array.from((includes as Map<string, boolean>).entries()).map(([k,v])=>k+':'+String(v)).join(',')]);

	async function setInclude(styleColorId: string, next: boolean) {
		setSavingById((m) => ({ ...m, [styleColorId]: true }));
		await mutate((prev: any) => {
			const m = new Map<string, boolean>(prev as Map<string, boolean> | undefined);
			m.set(styleColorId, next);
			return m;
		}, false);
		try {
			await supabase.from('stock_list_colors').upsert({ list_id: listId, style_id: styleId, style_color_id: styleColorId, include: next } as any, { onConflict: 'list_id,style_color_id' as any });
			try { if (typeof window !== 'undefined' && 'vibrate' in window.navigator) window.navigator.vibrate(8); } catch {}
			await mutate();
		} catch {
			await mutate();
		} finally {
			setSavingById((m) => {
				const copy = { ...m };
				delete copy[styleColorId];
				return copy;
			});
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="text-[11px] text-gray-600">Included: <span className="font-medium text-black">{includedCount}</span> / {total}</div>
			<div className="flex flex-wrap gap-2">
				{(colors ?? []).map((c) => {
					const saving = !!savingById[c.id];
					const checked = includes?.has(c.id) ? (includes.get(c.id) as boolean) : true;
					const name = `color-${c.id}`;
					return (
						<div key={c.id} className={"inline-flex items-center gap-2 border rounded px-2 py-1 " + (saving ? 'opacity-60' : '')}>
							<div className="text-[11px] min-w-[72px]">{c.color}</div>
							<label className="inline-flex items-center gap-1 text-[11px]">
								<input
									type="radio"
									name={name}
									checked={checked === true}
									onChange={async () => { await setInclude(c.id, true); }}
									disabled={saving}
								/>
								On
							</label>
							<label className="inline-flex items-center gap-1 text-[11px]">
								<input
									type="radio"
									name={name}
									checked={checked === false}
									onChange={async () => { await setInclude(c.id, false); }}
									disabled={saving}
								/>
								Off
							</label>
						</div>
					);
				})}
			</div>
		</div>
	);
}


