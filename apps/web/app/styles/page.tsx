'use client';
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

export default function StylesPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-500">Styles</div>
          <h1 className="text-xl font-semibold">STYLES</h1>
        </div>
        <div className="relative">
          <button className="p-1 rounded hover:bg-gray-100" onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-2 w-44 rounded-md border bg-white shadow">
              <button className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50" onClick={() => setMenuOpen(false)}>
                Update styles
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-white p-3 text-sm text-gray-600">
        Placeholder for Styles content.
      </div>
    </div>
  );
}


