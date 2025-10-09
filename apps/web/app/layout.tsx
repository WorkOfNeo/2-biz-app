import './globals.css';
export const metadata = { title: 'Admin' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900">
        <div className="flex min-h-screen">
          <aside className="sidebar w-64 p-4">
            <nav className="space-y-2">
              <a href="/">Home</a>
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-400 mt-4 mb-1">Statistics</div>
                <div className="space-y-1 ml-2">
                  <a href="/admin">General</a>
                  <a href="/statistics/overview">Overview</a>
                  <a href="/statistics/countries">Countries</a>
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-400 mt-4 mb-1">Settings</div>
                <div className="space-y-1 ml-2">
                  <a href="/settings/seasons">SEASONS</a>
                  <a href="/settings/salespersons">SALESPERSONS</a>
                  <a href="/settings/customers">CUSTOMERS</a>
                  <a href="/settings/misc">MISC</a>
                  <a href="/settings/runs">RUNS</a>
                </div>
              </div>
            </nav>
          </aside>
          <main className="flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}

