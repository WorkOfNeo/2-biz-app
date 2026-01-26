'use client';
import * as React from 'react';

type DropzoneProps = {
	accept?: string;
	multiple?: boolean;
	onFiles: (files: File[]) => void;
	className?: string;
	children?: React.ReactNode;
};

export function Dropzone({ accept, multiple = false, onFiles, className = '', children }: DropzoneProps) {
	const inputRef = React.useRef<HTMLInputElement | null>(null);
	const [dragOver, setDragOver] = React.useState(false);
	const onClick = () => inputRef.current?.click();
	const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.currentTarget.files ? Array.from(e.currentTarget.files) : [];
		if (files.length) onFiles(files);
		e.currentTarget.value = '';
	};
	const onDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(true);
	};
	const onDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(false);
	};
	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(false);
		const items = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
		if (items.length) {
			const filtered = accept ? items.filter(f => accept.split(',').some(a => f.name.toLowerCase().endsWith(a.trim().toLowerCase().replace('*','')))) : items;
			onFiles(filtered);
		}
	};
	return (
		<div
			role="button"
			tabIndex={0}
			className={[
				'group relative cursor-pointer select-none rounded-xl border border-dashed px-5 py-6 transition-colors',
				'bg-gradient-to-b from-white to-slate-50/50',
				'border-slate-200 hover:border-slate-300',
				'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 focus-visible:ring-offset-2',
				dragOver ? 'border-slate-400 bg-slate-50 ring-2 ring-slate-400/20' : '',
				className,
			].join(' ')}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onClick();
				}
			}}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			<input
				ref={inputRef}
				type="file"
				accept={accept}
				multiple={multiple}
				className="hidden"
				onChange={onChange}
			/>
			{children ?? (
				<div className="flex items-center gap-4">
					<div className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white shadow-sm">
						<svg
							className="h-5 w-5 text-slate-600"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="17 8 12 3 7 8" />
							<line x1="12" y1="3" x2="12" y2="15" />
						</svg>
					</div>
					<div className="min-w-0">
						<div className="text-sm font-semibold text-slate-900">
							Drag & drop {multiple ? 'files' : 'a file'} here
						</div>
						<div className="text-xs text-slate-600">
							or <span className="font-medium text-slate-800 underline underline-offset-2">click to browse</span>
							{accept ? <span className="text-slate-500"> ({accept})</span> : null}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}


