import { defineConfig } from 'drizzle-kit';
// Used only for `drizzle-kit studio` / introspection. Migrations are hand-written SQL in ./migrations.
export default defineConfig({ dialect: 'postgresql', schema: './src/schema/index.ts', dbCredentials: { url: process.env.DATABASE_URL_ADMIN ?? 'postgres://minnegela:minnegela@localhost:5432/minnegela' } });
