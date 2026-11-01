import 'dotenv/config'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from '../apps/api/src/db/client.ts'

await migrate(db, { migrationsFolder: './database/migrations' })
await pool.end()
console.log('Database migrations applied.')
