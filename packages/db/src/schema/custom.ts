import { customType } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
/** bit(64) as a 64-char '0'/'1' string. */
export const bit64 = customType<{ data: string; driverData: string }>({ dataType: () => 'bit(64)' });
export const inet = customType<{ data: string; driverData: string }>({ dataType: () => 'inet' });
