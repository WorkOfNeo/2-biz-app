'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '../../../components/ui/card';
import { ArrowRight, Loader2 } from 'lucide-react';

export default function CallOffLearningRedirect() {
  const router = useRouter();
  
  useEffect(() => {
    // Redirect after a brief moment to show the message
    const timer = setTimeout(() => {
      router.push('/purchase/patterns');
    }, 2000);
    
    return () => clearTimeout(timer);
  }, [router]);
  
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Card className="max-w-md w-full">
        <CardContent className="py-12 text-center">
          <Loader2 className="h-12 w-12 animate-spin text-blue-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">
            Learning Studio has moved
          </h2>
          <p className="text-slate-600 mb-4">
            Redirecting you to Purchase Patterns...
          </p>
          <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
            <span>/purchase/call-off-learning</span>
            <ArrowRight className="h-4 w-4" />
            <span className="font-medium text-blue-600">/purchase/patterns</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
