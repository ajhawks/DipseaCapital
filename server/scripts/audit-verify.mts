/**
 * Verify the audit hash chain in the store snapshot.
 *
 * Usage: npm run audit:verify [-- path/to/store.json]   (default: $DATA_PATH or data/store.json)
 * Exit code 0 = chain intact, 1 = tampered or unreadable.
 */
import { readFileSync } from 'node:fs';
import { verifyChain, type AuditRow } from '../src/services/audit/chain.js';

const path = process.argv[2] ?? process.env['DATA_PATH'] ?? 'data/store.json';
try {
  const { audit } = JSON.parse(readFileSync(path, 'utf-8')) as { audit: AuditRow[] };
  const result = verifyChain(audit);
  console.log(JSON.stringify({ path, ...result }));
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error(`Cannot verify ${path}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
