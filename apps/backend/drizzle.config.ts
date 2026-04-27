import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/database/schema/index.ts',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DB_PATH || 'elevenex.db' },
});
