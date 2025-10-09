export const metadata = { title: 'Admin' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'Inter, system-ui, sans-serif', margin: 0 }}>
        <div style={{ display: 'flex', minHeight: '100vh' }}>
          <aside style={{ width: 220, borderRight: '1px solid #eee', padding: 16 }}>
            <nav style={{ display: 'grid', gap: 8 }}>
              <a href="/">Home</a>
              <div>
                <div style={{ fontWeight: 600, marginTop: 8 }}>Statistics</div>
                <div style={{ display: 'grid', marginLeft: 8 }}>
                  <a href="/admin">General</a>
                  <a href="/statistics/overview">Overview</a>
                  <a href="/statistics/countries">Countries</a>
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 600, marginTop: 8 }}>Settings</div>
                <div style={{ display: 'grid', marginLeft: 8 }}>
                  <a href="/settings/seasons">SEASONS</a>
                  <a href="/settings/salespersons">SALESPERSONS</a>
                  <a href="/settings/customers">CUSTOMERS</a>
                  <a href="/settings/misc">MISC</a>
                  <a href="/settings/runs">RUNS</a>
                </div>
              </div>
            </nav>
          </aside>
          <main style={{ flex: 1, padding: 16 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}

