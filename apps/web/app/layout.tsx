import './globals.css';
export const metadata = {
  title: 'Admin',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    noarchive: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      noarchive: true,
      nosnippet: true
    }
  }
};
import { ToastStack } from '../components/Toast';
import AppShell from './AppShell';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body className="min-h-screen bg-white text-gray-900">
        <AppShell>{children}</AppShell>
        <ToastStack />
      </body>
    </html>
  );
}

