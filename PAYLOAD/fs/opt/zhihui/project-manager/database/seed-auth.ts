/**
 * Seed the shared-login admin user (idempotent upsert).
 * Usage: ZH_ADMIN_PASSWORD='...' pnpm tsx database/seed-auth.ts
 * The password is scrypt-hashed; the plaintext never touches disk.
 */
import 'dotenv/config'
import { randomBytes, scryptSync } from 'node:crypto'
import { pool } from '../apps/api/src/db/client.ts'

const password = process.env.ZH_ADMIN_PASSWORD
if (!password) {
  console.error('ZH_ADMIN_PASSWORD is required')
  process.exit(1)
}

const salt = randomBytes(16)
const hash = scryptSync(password, salt, 64)
const stored = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`

await pool.query(
  `INSERT INTO auth_users (username, password_hash, display_name)
   VALUES ('admin', $1, '系统管理员')
   ON CONFLICT (username) DO UPDATE
   SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
  [stored],
)
await pool.end()
console.log('auth admin user seeded.')
