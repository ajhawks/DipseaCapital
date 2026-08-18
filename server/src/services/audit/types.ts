import type { OrderDraft } from '@silexx/shared';

export interface AuditEntry {
  id: string;
  timestamp: string;
  userId: string;
  action:
    | 'PARSE_REQUEST'
    | 'PARSE_SUCCESS'
    | 'PARSE_FAILURE'
    | 'DRAFT_SUBMITTED'
    | 'SILEXX_API_CALLED'
    | 'SILEXX_API_RESPONSE';
  orderId?: string;
  silexxTicketId?: string;
  /** never log raw audio / transcriptFragment */
  parsedFields?: Omit<OrderDraft, 'transcriptFragment'>;
  errorCode?: string;
  metadata?: Record<string, string | number | boolean>;
}
