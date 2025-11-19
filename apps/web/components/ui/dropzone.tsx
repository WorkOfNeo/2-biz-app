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
			className={
				'rounded border border-dashed p-4 cursor-pointer select-none bg-white ' +
				(dragOver ? 'border-slate-500 bg-slate-50 ' : 'border-slate-300 ') +
				className
			}
			onClick={onClick}
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
			{children ?? <div className="text-xs text-gray-600">Drag and drop files here, or click to browse</div>}
		</div>
	);
}


