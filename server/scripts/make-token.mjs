/**
 * Dev utility: mint a JWT for the app's login screen, signed with the
 * JWT_SECRET from the root .env (same secret the server verifies with).
 *
 * Usage:
 *   node scripts/make-token.mjs [userId] [expiresIn]
 *   node scripts/make-token.mjs amogh 30d
 */
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';

config({ path: new URL('../../.env', import.meta.url).pathname });

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is not set in the root .env');
  process.exit(1);
}

const userId = process.argv[2] ?? 'dev-user';
const expiresIn = process.argv[3] ?? '30d';

console.log(jwt.sign({ userId }, secret, { expiresIn }));
