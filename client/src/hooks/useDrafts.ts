import { useCallback, useEffect, useState } from 'react';
import type {
  Clarification,
  EditableFields,
  HandoffAvailability,
  ManualCheckResult,
  OrderDraft,
  Refusal,
} from '@silexx/shared';
import * as api from '../services/api';

/** Per-card error, e.g. a stale version that made the card reload. */
export type CardErrors = Record<string, string>;

export interface UseDraftsReturn {
  drafts: OrderDraft[];
  clarifications: Clarification[];
  refusals: Refusal[];
  isParsing: boolean;
  busyId: string | null;
  error: string | null;
  cardErrors: CardErrors;
  availability: HandoffAvailability | null;
  submitTranscript: (transcript: string, symbolOverride?: string) => Promise<void>;
  edit: (d: OrderDraft, changes: EditableFields) => Promise<void>;
  acknowledge: (d: OrderDraft, codes: string[]) => Promise<void>;
  confirmAndHandOff: (d: OrderDraft) => Promise<void>;
  handOff: (d: OrderDraft) => Promise<void>;
  cancel: (d: OrderDraft) => Promise<void>;
  reconcile: (d: OrderDraft, result?: ManualCheckResult) => Promise<void>;
  dismissPrompts: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.');

export function useDrafts(token: string): UseDraftsReturn {
  const [drafts, setDrafts] = useState<OrderDraft[]>([]);
  const [clarifications, setClarifications] = useState<Clarification[]>([]);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<CardErrors>({});
  const [availability, setAvailability] = useState<HandoffAvailability | null>(null);

  const upsert = useCallback((d: OrderDraft) => {
    setDrafts((prev) => {
      if (d.state === 'cancelled') return prev.filter((p) => p.id !== d.id);
      const i = prev.findIndex((p) => p.id === d.id);
      if (i === -1) return [...prev, d];
      const next = prev.slice();
      next[i] = d;
      return next;
    });
  }, []);

  const refreshAvailability = useCallback(() => {
    api.fetchAvailability(token).then(setAvailability).catch(() => setAvailability(null));
  }, [token]);

  // Drafts live on the server: reload them so a refresh never loses work.
  useEffect(() => {
    api
      .fetchDrafts(token)
      .then((r) => setDrafts(r.drafts))
      .catch(() => undefined);
    refreshAvailability();
  }, [token, refreshAvailability]);

  /** Run one card action; on a stale/invalid-state answer, show the server's copy and say why. */
  const act = useCallback(
    async (d: OrderDraft, work: () => Promise<OrderDraft>) => {
      setBusyId(d.id);
      setCardErrors((e) => ({ ...e, [d.id]: '' }));
      try {
        upsert(await work());
      } catch (err) {
        if (err instanceof api.ApiRequestError && err.draft) upsert(err.draft);
        const why =
          err instanceof api.ApiRequestError && err.code === 'STALE_VERSION'
            ? 'This draft changed elsewhere, so it was reloaded. Review it again.'
            : message(err);
        setCardErrors((e) => ({ ...e, [d.id]: why }));
        if (err instanceof api.ApiRequestError && err.code === 'HANDOFF_DISABLED') refreshAvailability();
      } finally {
        setBusyId(null);
      }
    },
    [upsert, refreshAvailability],
  );

  const submitTranscript = useCallback(
    async (transcript: string, symbolOverride?: string) => {
      setIsParsing(true);
      setError(null);
      try {
        const r = await api.fetchParse(token, transcript, symbolOverride);
        r.drafts.forEach(upsert);
        setClarifications(r.clarifications);
        setRefusals(r.refusals);
      } catch (err) {
        setError(message(err));
      } finally {
        setIsParsing(false);
      }
    },
    [token, upsert],
  );

  const confirmAndHandOff = useCallback(
    (d: OrderDraft) =>
      act(d, async () => {
        const c = await api.confirmDraft(token, d);
        upsert(c);
        // Confirmation is recorded even if handoff is unavailable; the card says why.
        if (availability?.enabled === false) return c;
        return api.handoffDraft(token, c);
      }),
    [act, token, upsert, availability],
  );

  return {
    drafts,
    clarifications,
    refusals,
    isParsing,
    busyId,
    error,
    cardErrors,
    availability,
    submitTranscript,
    edit: (d, changes) => act(d, () => api.editDraft(token, d, changes)),
    acknowledge: (d, codes) => act(d, () => api.acknowledgeWarnings(token, d, codes)),
    confirmAndHandOff,
    handOff: (d) => act(d, () => api.handoffDraft(token, d)),
    cancel: (d) => act(d, () => api.cancelDraft(token, d)),
    reconcile: (d, result) => act(d, () => api.reconcileDraft(token, d, result)),
    dismissPrompts: () => {
      setClarifications([]);
      setRefusals([]);
      setError(null);
    },
  };
}
