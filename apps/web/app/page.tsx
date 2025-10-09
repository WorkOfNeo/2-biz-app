import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Statistics Admin</h1>
      <p className="text-sm text-gray-600">
        Go to <Link className="underline" href="/admin">/admin</Link> or <Link className="underline" href="/signin">/signin</Link>.
      </p>
      <div className="text-sm text-gray-500">Welcome. Use the sidebar to navigate.</div>
    </div>
  );
}

