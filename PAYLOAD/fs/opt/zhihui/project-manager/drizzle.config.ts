import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './apps/api/src/db/schema.ts',
  out: './database/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://pm_user:pm_password@127.0.0.1:55432/project_manager' },
})
