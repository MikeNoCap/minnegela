'use client';
import { useMediaUrl, type UrlKind } from '@/lib/urls';

/** A tile that lazily receives its signed URL. Never spins: a quiet placeholder until the URL arrives. */
export function Thumb({ blobId, kind = 'thumb', alt = '', className = '', cover = true }: { blobId: string; kind?: UrlKind; alt?: string; className?: string; cover?: boolean }) {
  const url = useMediaUrl(blobId, kind);
  return (
    <div className={`tile relative overflow-hidden ${className}`}>
      {url && <img src={url} alt={alt} loading="lazy" decoding="async" className={`w-full h-full ${cover ? 'object-cover' : 'object-contain'}`} />}
    </div>
  );
}
