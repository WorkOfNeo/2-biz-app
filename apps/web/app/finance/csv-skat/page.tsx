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
			const header = (data[0] || []).map((h) => normalizeHeader(h));
			const idx = {
				linjenr: header.findIndex((h) => /linjenr/.test(h)),
				rapportnr: header.findIndex((h) => /rapportnr/.test(h)),
				landekode: header.findIndex((h) => h.includes('landeomraadekode') || h.includes('landeomraadekode') || h.includes('landeomradekode')),
				moms: header.findIndex((h) => h.includes('debitors momsregistreringsnr') || h.includes('momsregistreringsnr')),
				vaerdi: header.findIndex((h) => h.includes('samlede vaerdi af forsyninger') || h.includes('samlede værdi af forsyninger'.normalize('NFKD').replace(/[\u0300-\u036f]/g,''))),
				trans: header.findIndex((h) => h.includes('transaktionsindikator')),
			};
			const rows: InRow[] = [];
			for (let i = 1; i < data.length; i++) {
				const r = data[i] || [];
				const linjenr = Number(r[idx.linjenr] ?? 0);
				if (!Number.isFinite(linjenr)) continue;
				const land = String(r[idx.landekode] ?? '').trim();
				const momsRaw = String(r[idx.moms] ?? '').trim();
				const moms = momsRaw ? momsRaw.replace(/[A-Za-z]/g, '') : null; // strip letters
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
			setRowsIn(rows);
			buildOutput(rows, dateStr);
		} catch (e: any) {
			setError(e?.message || 'Failed to parse file');
		} finally {
			setBusy(false);
		}
	}

	function buildOutput(src: InRow[], dateStrParam: string) {
		// Exclude rows where country code equals 'NO'
		const filtered = src.filter((r) => String(r.landekode || '').toUpperCase() !== 'NO');
		// Sort by original linjenr to keep stable ordering
		filtered.sort((a, b) => (a.linjenr || 0) - (b.linjenr || 0));
		const header = ['0', '27492185', 'LISTE', '', '', '', '', '', ''];
		const out: any[][] = [header];
		let sum = 0;
		let lastLineNo = 0;
		for (const r of filtered) {
			lastLineNo = r.linjenr || lastLineNo;
			sum += r.vaerdi || 0;
			out.push([
				2,                           // col1
				r.linjenr,                   // col2
				dateStrParam,                // col3 YYYY-MM-DD
				27492185,                    // col4
				r.landekode || '',           // col5
				(r.momsnr || '').replace(/[A-Za-z]/g, ''), // col6 strip letters
				Number.isFinite(r.vaerdi) ? r.vaerdi : 0, // col7
				0,                           // col8
				0,                           // col9
			]);
		}
		// Last summary row
		out.push([
			10,                 // col1
			Number(lastLineNo || 0) + 1, // col2
			sum,                // col3: sum of "Samlede værdi af forsyninger" of present rows
			'', '', '', '', '', '',
		]);
		setRowsOut(out);
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
			// Comma-separated, quote fields containing comma
			const lines = rowsOut.map((row) =>
				row
					.map((cell) => {
						const s = String(cell ?? '');
						if (s.includes(',') || s.includes('"') || s.includes('\n')) {
							return `"${s.replace(/"/g, '""')}"`;
						}
						return s;
					})
					.join(',')
			);
			const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
			const { default: saveAs } = await import('file-saver');
			saveAs(blob, 'skat_export.csv');
		} catch (e: any) {
			alert(e?.message || 'Export CSV failed');
		}
	}

	async function exportXml() {
		try {
			if (rowsOut.length === 0) return;
			// Simple XML with columns col1..col9
			const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			const rows = rowsOut.map((r) => {
				const cols = r.map((c, i) => `<col${i + 1}>${esc(c)}</col${i + 1}>`).join('');
				return `<row>${cols}</row>`;
			}).join('');
			const xml = `<?xml version="1.0" encoding="UTF-8"?><skat>${rows}</skat>`;
			const blob = new Blob([xml], { type: 'application/xml' });
			const { default: saveAs } = await import('file-saver');
			saveAs(blob, 'skat_export.xml');
		} catch (e: any) {
			alert(e?.message || 'Export XML failed');
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
						<Button size="sm" variant="outline" onClick={exportXml} disabled={rowsOut.length === 0 || busy}>Export XML</Button>
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
								{rowsOut.slice(0, 25).map((r, i) => (
									<tr key={i}>
										{r.map((c, j) => (
											<td key={j} className="p-1 border">{String(c ?? '')}</td>
										))}
									</tr>
								))}
								{rowsOut.length > 25 && (
									<tr><td className="p-1 text-gray-500" colSpan={rowsOut[0]?.length || 9}>… {rowsOut.length - 25} more rows</td></tr>
								)}
							</tbody>
						</table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}


