'use client';
import * as React from 'react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Dropzone } from '../../../components/ui/dropzone';

type InRow = {
	linjenr: number;
	rapportnr: string | number | null;
	landekode: string;
	momsnr: string | null;
	vaerdi: number;
	transInd: string | null;
};

function toNumberDK(val: any): number {
	const n = Number(String(val ?? '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, ''));
	return Number.isFinite(n) ? n : 0;
}

function normalizeHeader(h: any): string {
	return String(h ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/\./g, '')
		.replace(/-/g, '')
		.replace(/\//g, '')
		.replace(/æ/g, 'ae')
		.replace(/ø/g, 'oe')
		.replace(/å/g, 'aa');
}

export default function CsvSkatPage() {
	const [dateStr, setDateStr] = React.useState<string>(() => {
		const d = new Date();
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		return `${yyyy}-${mm}-${dd}`;
	});
	const [rowsIn, setRowsIn] = React.useState<InRow[]>([]);
	const [rowsOut, setRowsOut] = React.useState<any[][]>([]);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [showAll, setShowAll] = React.useState(false);

	async function onFilesSelected(files: File[]) {
		setError(null);
		setRowsIn([]);
		setRowsOut([]);
		if (!files || files.length === 0) return;
		setBusy(true);
		try {
			const XLSX = await import('xlsx');
			const f = files[0]!;
			const buf = await f.arrayBuffer();
			const wb = XLSX.read(buf, { type: 'array' });
			const sheetName = wb.SheetNames?.[0];
			if (!sheetName) throw new Error('No sheet found');
			const sheet = wb.Sheets[sheetName];
			if (!sheet) throw new Error('Empty sheet');
			const data = XLSX.utils.sheet_to_json(sheet as any, { header: 1 }) as any[][];
			if (data.length === 0) throw new Error('Empty sheet');
			const rawHeader = data[0] || [];
			const header = rawHeader.map((h) => normalizeHeader(h));
			const idx = {
				linjenr: header.findIndex((h) => /linjenr/.test(h)),
				rapportnr: header.findIndex((h) => /rapportnr/.test(h)),
				landekode: header.findIndex((h) => h.includes('landeomraadekode') || h.includes('landeomraadekode') || h.includes('landeomradekode')),
				moms: header.findIndex((h) => h.includes('debitors momsregistreringsnr') || h.includes('momsregistreringsnr')),
				vaerdi: header.findIndex((h) => h.includes('samlede vaerdi af forsyninger') || h.includes('samlede værdi af forsyninger'.normalize('NFKD').replace(/[\u0300-\u036f]/g,''))),
				trans: header.findIndex((h) => h.includes('transaktionsindikator')),
			};
			console.log('[CsvSkat] Header detected', {
				fileName: f.name,
				totalRows: data.length,
				rawHeader,
				normalizedHeader: header,
				idx,
			});
			const requiredCols = ['linjenr', 'landekode', 'moms', 'vaerdi'] as const;
			const missing = requiredCols.filter((k) => idx[k] === -1);
			if (missing.length > 0) {
				console.error('[CsvSkat] Required columns not found in header', {
					missing,
					idx,
					normalizedHeader: header,
					rawHeader,
				});
				throw new Error(
					`Required columns not found: ${missing.join(', ')}. Header seen: "${rawHeader.map((c: any) => String(c ?? '')).join(' | ')}"`
				);
			}
			const rows: InRow[] = [];
			for (let i = 1; i < data.length; i++) {
				const r = data[i] || [];
				const linjenr = Number(r[idx.linjenr] ?? 0);
				if (!Number.isFinite(linjenr)) continue;
				const land = String(r[idx.landekode] ?? '').trim();
				const momsRaw = String(r[idx.moms] ?? '').trim();
				// For NL countries, preserve letters in VAT numbers; for others, strip letters
				const moms = momsRaw ? (land.toUpperCase() === 'NL' ? momsRaw : momsRaw.replace(/[A-Za-z]/g, '')) : null;
				const val = toNumberDK(r[idx.vaerdi]);
				const rapport = r[idx.rapportnr] ?? null;
				const trans = r[idx.trans] ?? null;
				rows.push({
					linjenr: Number(linjenr),
					rapportnr: rapport,
					landekode: land,
					momsnr: moms,
					vaerdi: val,
					transInd: trans ? String(trans) : null,
				});
			}
			if (data.length > 1 && rows.length === 0) {
				console.warn('[CsvSkat] No rows extracted from file', {
					dataRows: data.length - 1,
					idx,
				});
			}
			setRowsIn(rows);
			buildOutput(rows, dateStr);
		} catch (e: any) {
			setError(e?.message || 'Failed to parse file');
		} finally {
			setBusy(false);
		}
	}

	function buildOutput(src: InRow[], dateStrParam: string) {
		// Filter rules:
		// - Exclude rows where country code equals 'NO'
		// - Exclude rows missing Lande-/områdekode
		// - Exclude rows missing Debitors momsregistreringsnr (after stripping letters)
		const filtered: InRow[] = [];
		let excludedEmptyLand = 0;
		let excludedNO = 0;
		let excludedEmptyMoms = 0;
		for (const r of src) {
			const land = String(r.landekode || '').trim();
			// For NL countries, preserve letters in VAT numbers; for others, strip letters
			const moms = String(r.momsnr || '').trim();
			const momsCleaned = land.toUpperCase() === 'NL' ? moms : moms.replace(/[A-Za-z]/g, '');
			if (!land) { excludedEmptyLand++; continue; }
			if (land.toUpperCase() === 'NO') { excludedNO++; continue; }
			if (!momsCleaned) { excludedEmptyMoms++; continue; }
			filtered.push(r);
		}
		console.log('[CsvSkat] Filter results', {
			total: src.length,
			kept: filtered.length,
			excludedNO,
			excludedEmptyLand,
			excludedEmptyMoms,
		});
		if (filtered.length === 0 && src.length > 0) {
			console.warn('[CsvSkat] All rows filtered out', {
				total: src.length,
				excludedNO,
				excludedEmptyLand,
				excludedEmptyMoms,
			});
			setError(
				`All ${src.length} rows were filtered out (NO: ${excludedNO}, empty country: ${excludedEmptyLand}, empty VAT: ${excludedEmptyMoms}).`
			);
		}
		// Keep incoming order; we'll compute Linjenr sequentially starting at 1
		const header = [0, 27492185, 'LISTE', '', '', '', '', '', ''];
		const out: any[][] = [header];
		let sum = 0;
		let seq = 0;
		for (const r of filtered) {
			seq += 1; // calculated Linjenr (no relation to file's Linjenr)
			sum += r.vaerdi || 0;
			// For NL countries, preserve letters in VAT numbers; for others, strip letters
			const momsOutput = r.landekode?.toUpperCase() === 'NL' 
				? (r.momsnr || '') 
				: (r.momsnr || '').replace(/[A-Za-z]/g, '');
			out.push([
				2,                           // col1
				seq,                         // col2 (calculated Linjenr starting from 1)
				dateStrParam,                // col3 YYYY-MM-DD
				27492185,                    // col4
				r.landekode || '',           // col5
				momsOutput,                  // col6 (preserve letters for NL, strip for others)
				Number.isFinite(r.vaerdi) ? r.vaerdi : 0, // col7
				0,                           // col8
				0,                           // col9
			]);
		}
		// Last summary row
		out.push([
			10,                 // col1
			seq,               // col2: same as last calculated Linjenr
			sum,                // col3: sum of "Samlede værdi af forsyninger" of present rows
			'', '', '', '', '', '',
		]);
		setRowsOut(out);
		console.log('[CsvSkat] Output built', {
			headerRow: 1,
			dataRows: out.length - 2,
			summaryRow: 1,
			sum,
		});
	}

	React.useEffect(() => {
		if (rowsIn.length > 0) buildOutput(rowsIn, dateStr);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dateStr]);

	async function exportXlsx() {
		try {
			if (rowsOut.length === 0) return;
			const [XLSX, { default: saveAs }] = await Promise.all([import('xlsx'), import('file-saver')]);
			const wb = XLSX.utils.book_new();
			const ws = XLSX.utils.aoa_to_sheet(rowsOut);
			XLSX.utils.book_append_sheet(wb, ws, 'Skat');
			const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
			const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
			saveAs(blob, 'skat_export.xlsx');
		} catch (e: any) {
			alert(e?.message || 'Export XLSX failed');
		}
	}

	async function exportCsv() {
		try {
			if (rowsOut.length === 0) return;
			// Semicolon-separated; keep numbers as numeric tokens (no quotes)
			const delim = ';';
			const lines = rowsOut.map((row) =>
				row.map((cell) => {
					if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '0';
					const s = String(cell ?? '');
					if (s.includes(delim) || s.includes('"') || s.includes('\n')) {
						return `"${s.replace(/"/g, '""')}"`;
					}
					return s;
				}).join(delim)
			);
			const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
			const { default: saveAs } = await import('file-saver');
			saveAs(blob, 'skat_export.csv');
		} catch (e: any) {
			alert(e?.message || 'Export CSV failed');
		}
	}

	return (
		<div className="space-y-4">
			<div>
				<div className="text-xs text-gray-500">Finance</div>
				<h1 className="text-xl font-semibold">CSV - Skat</h1>
			</div>
			<Card>
				<CardHeader>
					<CardTitle className="text-sm">Upload & Settings</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="grid grid-cols-1 md:grid-cols-[1fr_200px] gap-3 items-end">
						<div>
							<label className="block text-xs mb-1 text-gray-700">Excel file (.xlsx/.xls)</label>
							<Dropzone accept=".xlsx,.xls" multiple={false} onFiles={onFilesSelected} />
						</div>
						<div>
							<label className="block text-xs mb-1 text-gray-700">Date (YYYY-MM-DD)</label>
							<Input type="date" value={dateStr} onChange={(e) => setDateStr(e.currentTarget.value)} />
						</div>
					</div>
					{error && <div className="text-xs text-red-700">{error}</div>}
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={exportXlsx} disabled={rowsOut.length === 0 || busy}>Export XLSX</Button>
						<Button size="sm" variant="outline" onClick={exportCsv} disabled={rowsOut.length === 0 || busy}>Export CSV</Button>
						{rowsIn.length > 0 && (
							<div className="text-xs text-gray-600">
								Rows loaded: {rowsIn.length.toLocaleString('da-DK')} · Included (excl. NO): {Math.max(0, rowsOut.length - 2).toLocaleString('da-DK')}
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			{rowsOut.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Preview</CardTitle>
					</CardHeader>
					<CardContent className="overflow-auto">
						<table className="min-w-full text-xs">
							<tbody>
								{(showAll ? rowsOut : rowsOut.slice(0, 25)).map((r, i) => (
									<tr key={i}>
										{r.map((c, j) => (
											<td key={j} className="p-1 border">{String(c ?? '')}</td>
										))}
									</tr>
								))}
								{!showAll && rowsOut.length > 25 && (
									<tr>
										<td className="p-1 text-blue-700 underline cursor-pointer" colSpan={rowsOut[0]?.length || 9}
											onClick={() => setShowAll(true)}
										>
											… {rowsOut.length - 25} more rows (click to expand)
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}


