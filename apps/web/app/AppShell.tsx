"use client";
import { usePathname } from 'next/navigation';
import { SidebarNav } from '../components/SidebarNav';
import { useRoles } from '../lib/supabaseClient';
import { useState } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/cn';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuth = pathname === '/signin';
  const { has } = useRoles();
  const hideSidebar = isAuth || has('sales');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  if (hideSidebar) {
    return <main className="min-h-screen">{children}</main>;
  }
  return (
    <div className="flex min-h-screen relative">
      <aside 
        className={cn(
          "sidebar flex-shrink-0 transition-all duration-300 ease-in-out overflow-hidden",
          sidebarOpen ? "w-64 p-4" : "w-0 p-0"
        )}
      >
        {sidebarOpen && <SidebarNav />}
      </aside>
      <main className="flex-1 min-w-0 relative">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "absolute top-4 z-10 transition-all duration-300",
            sidebarOpen ? "left-4" : "left-2"
          )}
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          {sidebarOpen ? (
            <PanelLeft className="h-5 w-5" />
          ) : (
            <PanelRight className="h-5 w-5" />
          )}
        </Button>
        <div className={cn("p-6 overflow-x-hidden", !sidebarOpen && "pl-12")}>
          {children}
        </div>
      </main>
    </div>
  );
}


