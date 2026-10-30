import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrderDraft } from '@silexx/shared';
import { buildRow, type AuditData, type AuditEvent, type AuditRow } from '../audit/chain.js';

/**
 * Transactional store for drafts, the audit chain and the kill switch (R-ATOMIC).
 *
 * SPRINT STAND-IN for PostgreSQL (D3a): state lives in memory and is snapshotted
 * to a JSON file on every commit (write-temp-then-rename, so a crash leaves either
 * the old or the new snapshot, never half of one). Transactions are serialized by
 * a mutex and run on a copy of the state, so a throw anywhere — including an
 * audit append — discards every change. The interface is shaped so a Postgres
 * implementation can replace this without touching callers.
 */

export interface KillSwitch {
  tripped: boolean;
  reason?: string;
  at?: string;
}

interface State {
  drafts: Record<string, OrderDraft & { userId: string }>;
  audit: AuditRow[];
  killSwitch: KillSwitch;
}

export type StoredDraft = OrderDraft & { userId: string };

export interface Tx {
  getDraft(id: string): StoredDraft | undefined;
  listDrafts(predicate?: (d: StoredDraft) => boolean): StoredDraft[];
  putDraft(draft: StoredDraft): void;
  audit(entry: { userId: string; event: AuditEvent; draftId?: string; data?: AuditData }): AuditRow;
  getKillSwitch(): KillSwitch;
  setKillSwitch(k: KillSwitch): void;
  now(): string;
}

function emptyState(): State {
  return { drafts: {}, audit: [], killSwitch: { tripped: false } };
}

export class Store {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  /** Test hook: throw from inside an audit append to prove fail-closed behaviour. */
  failNextAudit = false;

  constructor(private readonly filePath?: string) {
    this.state =
      filePath && existsSync(filePath)
        ? (JSON.parse(readFileSync(filePath, 'utf-8')) as State)
        : emptyState();
  }

  /** Run `fn` atomically. Only synchronous work belongs inside: no network calls (R-ATOMIC 3). */
  transaction<T>(fn: (tx: Tx) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const working: State = structuredClone(this.state);
      const tx: Tx = {
        getDraft: (id) => {
          const d = working.drafts[id];
          return d ? structuredClone(d) : undefined;
        },
        listDrafts: (predicate) =>
          Object.values(working.drafts)
            .filter((d) => (predicate ? predicate(d) : true))
            .map((d) => structuredClone(d)),
        putDraft: (draft) => {
          working.drafts[draft.id] = structuredClone(draft);
        },
        audit: (entry) => {
          if (this.failNextAudit) {
            this.failNextAudit = false;
            throw new Error('audit append failed (injected)');
          }
          // Appends happen inside the serialized transaction, so the chain can't fork (R-ATOMIC 2).
          const row = buildRow(working.audit[working.audit.length - 1], entry, new Date().toISOString());
          working.audit.push(row);
          return row;
        },
        getKillSwitch: () => ({ ...working.killSwitch }),
        setKillSwitch: (k) => {
          working.killSwitch = { ...k };
        },
        now: () => new Date().toISOString(),
      };
      const result = fn(tx);
      this.persist(working);
      this.state = working;
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Read-only snapshot of the audit chain (append-only: there is no API to alter it). */
  auditRows(): readonly AuditRow[] {
    return structuredClone(this.state.audit);
  }

  private persist(state: State): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, this.filePath);
  }
}

let defaultStore: Store | undefined;

export function getStore(): Store {
  defaultStore ??= new Store(process.env['DATA_PATH'] ?? 'data/store.json');
  return defaultStore;
}

/** Tests swap in a fresh in-memory store. */
export function setStore(store: Store): void {
  defaultStore = store;
}
