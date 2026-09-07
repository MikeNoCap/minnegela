'use client';
import Link from 'next/link';
import { usePeople, useReview, useMembers } from '@/lib/hooks';
import { Avatar } from '@/components/Avatar';
import { FaceCrop } from '@/components/FaceCrop';

export default function PeoplePage() {
  const people = usePeople();
  const members = useMembers();
  const review = useReview();
  const memberByPerson = new Map((members.data ?? []).filter((m) => m.personId != null).map((m) => [m.personId!, m]));
  const list = (people.data ?? []).filter((p) => !p.hidden);
  const named = list.filter((p) => !p.userId);
  const membersP = list.filter((p) => p.userId);
  const clusters = review.data?.unnamedClusters ?? [];
  return (
    <div className="space-y-8">
      <Section title="Members" people={membersP} sub={(p) => memberByPerson.get(p.id)?.consentFacesAt ? 'face recognition on' : 'not enrolled'} />
      <Section title="Named people" people={named} />
      {clusters.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between"><h2 className="text-ink-3 text-xs uppercase tracking-wide">Unnamed</h2><Link href="/review" className="text-[13px] text-accent">Name them in Review →</Link></div>
          <div className="mt-2 grid gap-3 grid-cols-3 sm:grid-cols-5 lg:grid-cols-8">
            {clusters.map((c) => (
              <Link key={c.id} href="/review" className="text-center space-y-1">
                <FaceCrop faceId={c.coverFaceId} className="aspect-square rounded-full mx-auto w-16" />
                <div className="text-[12px] text-ink-2">Unnamed ({c.n})</div>
              </Link>
            ))}
          </div>
        </section>
      )}
      {people.data && people.data.length === 0 && <p className="text-ink-3">No people yet. Enroll your face from the phone app, then confirm matches in Review.</p>}
    </div>
  );
}

function Section({ title, people, sub }: { title: string; people: Array<{ id: number; name: string | null; coverFaceId: string | null }>; sub?: (p: { id: number }) => string | undefined }) {
  if (!people.length) return null;
  return (
    <section>
      <h2 className="text-ink-3 text-xs uppercase tracking-wide">{title}</h2>
      <div className="mt-2 grid gap-3 grid-cols-3 sm:grid-cols-5 lg:grid-cols-8">
        {people.map((p) => (
          <Link key={p.id} href={`/people/${p.id}`} className="text-center space-y-1 group">
            {p.coverFaceId ? <FaceCrop faceId={p.coverFaceId} className="aspect-square rounded-full mx-auto w-16" /> : <div className="mx-auto w-16 flex justify-center"><Avatar name={p.name} seed={p.id} size={64} /></div>}
            <div className="text-[13px] group-hover:text-accent">{p.name ?? 'Unnamed'}</div>
            {sub?.(p) && <div className="text-[11px] text-ink-3">{sub(p)}</div>}
          </Link>
        ))}
      </div>
    </section>
  );
}
