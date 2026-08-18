import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AuditEntry } from './types.js';

export interface AuditService {
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void>;
}

export const auditService: AuditService = {
  async log(entry) {
    // Read path on each call so tests can redirect via AUDIT_LOG_PATH without
    // re-importing the module.
    const logPath = process.env['AUDIT_LOG_PATH'] ?? 'audit.ndjson';
    const fullEntry: AuditEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    await appendFile(logPath, JSON.stringify(fullEntry) + '\n', 'utf-8');
  },
};
