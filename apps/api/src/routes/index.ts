import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { meRoutes } from './me.js';
import { groupRoutes } from './groups.js';
import { syncRoutes } from './sync.js';
import { eventRoutes } from './events.js';
import { searchRoutes } from './search.js';
import { mediaRoutes } from './media.js';
import { peopleRoutes } from './people.js';
import { placeRoutes } from './places.js';
import { adminRoutes } from './admin.js';

export async function registerRoutes(app: FastifyInstance, ctx: AppContext) {
  for (const r of [meRoutes, groupRoutes, syncRoutes, eventRoutes, searchRoutes, mediaRoutes, peopleRoutes, placeRoutes, adminRoutes]) await app.register(r, ctx);
}
