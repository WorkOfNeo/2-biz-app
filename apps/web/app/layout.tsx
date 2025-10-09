import './globals.css';
export const metadata = { title: 'Admin' };
import { SidebarNav } from '../components/SidebarNav';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body className="min-h-screen bg-white text-gray-900">
        <div className="flex min-h-screen">
          <aside className="sidebar w-64 p-4">
            <SidebarNav />
          </aside>
          <main className="flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}

