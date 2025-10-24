import './globals.css';
export const metadata = { title: 'Admin' };
import { SidebarNav } from '../components/SidebarNav';
import { ToastStack } from '../components/Toast';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body className="min-h-screen bg-white text-gray-900">
        {typeof window !== 'undefined' && window.location.pathname === '/signin' ? (
          <main className="min-h-screen">{children}</main>
        ) : (
          <div className="flex min-h-screen">
            <aside className="sidebar w-64 p-4">
              <SidebarNav />
            </aside>
            <main className="flex-1 p-6">{children}</main>
          </div>
        )}
        <ToastStack />
      </body>
    </html>
  );
}

