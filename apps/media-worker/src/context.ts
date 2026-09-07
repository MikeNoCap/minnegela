import type { Db } from '@minnegela/db';
import type { Config } from './config.js';
import type { Storage } from './storage.js';
import type { Logger } from './log.js';

export type Ctx = { db: Db; storage: Storage; cfg: Config; log: Logger };
