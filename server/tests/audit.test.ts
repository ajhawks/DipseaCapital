import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { auditService } from '../src/services/audit/auditService.js';
import type { AuditEntry } from '../src/services/audit/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

let logPath: string;

beforeEach(() => {
  logPath = join(tmpdir(), `audit-test-${randomUUID()}.ndjson`);
  process.env['AUDIT_LOG_PATH'] = logPath;
});

afterEach(async () => {
  delete process.env['AUDIT_LOG_PATH'];
  try {
    await unlink(logPath);
  } catch {
    // File may not exist if the test never wrote anything.
  }
});

async function readEntries(): Promise<AuditEntry[]> {
  const raw = await readFile(logPath, 'utf-8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as AuditEntry);
}

describe('auditService.log', () => {
  test('writes a single NDJSON line with required fields', async () => {
    await auditService.log({ userId: 'u1', action: 'PARSE_REQUEST' });

    const [entry] = await readEntries();
    expect(entry).toBeDefined();
    expect(entry!.id).toMatch(UUID_RE);
    expect(entry!.timestamp).toMatch(ISO_RE);
    expect(entry!.userId).toBe('u1');
    expect(entry!.action).toBe('PARSE_REQUEST');
  });

  test('timestamp is close to current time', async () => {
    const before = Date.now();
    await auditService.log({ userId: 'u1', action: 'PARSE_REQUEST' });
    const after = Date.now();

    const [entry] = await readEntries();
    const ts = new Date(entry!.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 50); // allow 50 ms clock skew
  });

  test('includes optional fields when provided', async () => {
    await auditService.log({
      userId: 'u2',
      action: 'PARSE_SUCCESS',
      orderId: 'order-123',
      metadata: { transcriptLength: 42 },
    });

    const [entry] = await readEntries();
    expect(entry!.orderId).toBe('order-123');
    expect(entry!.metadata).toEqual({ transcriptLength: 42 });
    expect(entry!.errorCode).toBeUndefined();
  });

  test('appends on successive calls — never overwrites (append-only)', async () => {
    await auditService.log({ userId: 'u1', action: 'PARSE_REQUEST' });
    await auditService.log({ userId: 'u1', action: 'PARSE_SUCCESS', orderId: 'o1' });
    await auditService.log({ userId: 'u1', action: 'PARSE_FAILURE', errorCode: 'MISSING_FIELDS' });

    const entries = await readEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0]!.action).toBe('PARSE_REQUEST');
    expect(entries[1]!.action).toBe('PARSE_SUCCESS');
    expect(entries[2]!.action).toBe('PARSE_FAILURE');
  });

  test('every entry has a unique id', async () => {
    await auditService.log({ userId: 'u1', action: 'PARSE_REQUEST' });
    await auditService.log({ userId: 'u1', action: 'PARSE_SUCCESS' });

    const entries = await readEntries();
    expect(entries[0]!.id).not.toBe(entries[1]!.id);
  });

  test('no delete or update operations exist on the service', () => {
    const keys = Object.keys(auditService);
    expect(keys).toEqual(['log']);
  });
});
