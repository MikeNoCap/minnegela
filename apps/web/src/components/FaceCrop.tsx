'use client';
import { API_URL } from '@/lib/config';

/** Face crops are streamed by the API (§18.6), never presigned. */
export function FaceCrop({ faceId, className = '' }: { faceId: string | null | undefined; className?: string }) {
  if (!faceId) return <div className={`tile ${className}`} />;
  return <div className={`tile overflow-hidden ${className}`}><img src={`${API_URL}/v1/faces/${faceId}/crop`} alt="" loading="lazy" className="w-full h-full object-cover" crossOrigin="use-credentials" /></div>;
}
