import { z } from 'zod';

/** §12.1 Every search compiles to this. */
export const SearchQuery = z.object({
  people: z.object({ all: z.array(z.number().int()).optional(), any: z.array(z.number().int()).optional() }).optional(),
  time: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).optional(),
  place: z.object({ placeId: z.string().uuid().optional(), lat: z.number().optional(), lon: z.number().optional(), radiusM: z.number().optional(), city: z.string().optional() }).optional(),
  eventId: z.string().uuid().optional(),
  contributors: z.array(z.string().uuid()).optional(),
  mediaType: z.enum(['photo', 'video']).optional(),
  semantic: z.string().optional(),
  tags: z.array(z.string()).optional(),
  mode: z.enum(['events', 'media']).default('events'),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** A parsed chip shown above results so the user can see how the query was understood. */
export const SearchChip = z.object({
  kind: z.enum(['person', 'time', 'place', 'event', 'contributor', 'type', 'semantic', 'tag']),
  label: z.string(),
  value: z.unknown(),
  text: z.string().describe('the tokens consumed from the raw query'),
});
export type SearchChip = z.infer<typeof SearchChip>;
