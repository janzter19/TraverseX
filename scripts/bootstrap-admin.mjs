import { query, pool } from '../src/db.mjs';
import { hashPassword } from '../src/security.mjs';

const username = process.env.TRAVERSEX_BOOTSTRAP_USERNAME ?? 'admin';
const password = process.env.TRAVERSEX_BOOTSTRAP_PASSWORD;
if (!password || password.length < 8) throw new Error('TRAVERSEX_BOOTSTRAP_PASSWORD must be set and at least 8 characters');
await query('INSERT INTO traversex_admin_user (username, password_hash, must_change_password) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), must_change_password=1', [username, hashPassword(password)]);
await pool.end();
console.log(`Bootstrap admin ${username} created or reset. Change it immediately and unset the password environment variable.`);
