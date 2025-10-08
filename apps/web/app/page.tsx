import Link from 'next/link';

export default function HomePage() {
  return (
    <div>
      <h1>Statistics Admin</h1>
      <p>
        Go to <Link href="/admin">/admin</Link> or <Link href="/signin">/signin</Link>.
      </p>
    </div>
  );
}

