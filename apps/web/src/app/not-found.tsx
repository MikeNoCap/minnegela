import Link from 'next/link';
export default function NotFound() {
  return <main className="min-h-screen flex flex-col items-center justify-center gap-2 text-ink-2"><p>Not in your view.</p><Link href="/" className="text-accent">Home</Link></main>;
}
