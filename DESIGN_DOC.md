# Design Doc — Voice Order Entry Assistant

The product spec. Its safety invariants (INV-1…12 below) are release-blocking.
How and in what order it gets built is in `IMPLEMENTATION_PLAN.md`.

## Project purpose

Build a private, hosted web application that lets traders speak equity and single-leg equity options orders in natural trading language and turns them into structured draft tickets for Silexx.

The application interprets speech, resolves symbols/contracts, validates required fields, performs pre-trade sanity checks, and presents editable drafts.

## Non-negotiable safety invariants

1. **Never submit, route, or execute an order.** The app may only populate a Silexx draft ticket after explicit confirmation in this application. The trader must review and manually submit the ticket using Silexx's normal controls.
2. Every order draft requires explicit, per-draft trader confirmation before Silexx handoff.
3. Confirmation applies to one exact version of a draft. Any subsequent edit invalidates the confirmation and requires renewed review and confirmation.
4. Never invent missing or ambiguous required order details. Ask a targeted clarification question or refuse to create the draft.
5. Invalid or unsupported orders are blocked. Unusual but potentially valid orders produce a warning and require explicit acknowledgement.
6. Never silently discard a possible duplicate. Ask whether it is intentional.
7. Never report an uncertain Silexx handoff as successful. Reconcile when reliable lookup is supported; otherwise require manual checking.
8. Never blindly retry an uncertain handoff. Use idempotency/reconciliation where supported.
9. Mandatory validation, explicit confirmation, audit logging, access controls, and the no-auto-submit rule cannot be disabled by settings, AI outputs, integrations, or updates.
10. Do not automatically fall back to an unapproved external AI or market-data service.
11. Do not retain raw production audio after processing.
12. A draft or populated Silexx ticket is not an executed trade.

Treat these invariants as release-blocking requirements.

## User workflow

1. Trader activates voice entry.
2. Capture speech and transcribe it.
3. Interpret one or more orders.
4. Resolve symbols and option contracts.
5. Validate required fields and run sanity checks.
6. Show editable draft cards and read back interpreted orders.
7. Trader reviews/edits each draft and explicitly confirms each one.
8. App attempts to populate the corresponding Silexx draft ticket.
9. Report the handoff status.
10. Trader reviews the ticket in Silexx and manually submits if appropriate.

Show clear processing states, for example: Listening, Transcribing, Interpreting, Resolving instrument, Validating, Clarification required, Draft ready, Awaiting confirmation, Handoff in progress, Populated in Silexx, Handoff failed, and Handoff outcome uncertain.

One utterance may contain multiple orders. Each order is a separate draft and must be reviewed and confirmed independently. A failure on one order must not block unrelated drafts. If a correction could refer to multiple drafts, ask which one; never modify multiple drafts unless explicitly instructed.

Traders can correct orders by voice or by directly editing fields. Preserve the original interpretation, edits, and final confirmed values in the audit trail.

## Supported orders

Version 1 supports:
- Equity market orders
- Equity limit orders
- Equity stop-market orders
- Equity stop-limit orders
- Single-leg equity options

Multi-leg options strategies are out of scope.

Equity fields include side, quantity, symbol, order type, applicable limit/stop prices, time in force, and account where required. Exact required fields must be finalized against Silexx before integration.

Options must uniquely identify underlying symbol, expiration, strike, call/put, buy/sell, open/close where applicable, contract quantity, order type, applicable prices, and any required time-in-force/account fields. Never guess if multiple contracts are plausible. Ask whether a stop order is stop-market or stop-limit when unclear.

Handle trading slang, spoken numbers and price idioms, spelled tickers, filler/disfluencies, self-corrections, and multiple orders in one utterance. The last clear correction applies only to the field corrected; do not silently change unrelated fields.

## Parsing and AI architecture

Prefer deterministic code for normalization, known trading lexicon, well-defined patterns, validation, and safety rules. Use an LLM only for cases not reliably resolved deterministically.

Suggested pipeline:
1. Normalize spoken numbers, price idioms, ticker spellings, and corrections.
2. Run deterministic parsing.
3. Use a fast path that skips the LLM when the order is fully resolved.
4. For remaining cases, call a configured model through a provider-agnostic interface with schema-constrained output.
5. Resolve symbols/contracts.
6. Validate required fields and safety rules.
7. Create a draft only after all required checks pass.

The original proposal used `whisper.cpp` for speech recognition and Ollama with `llama3.1:8b` as a candidate LLM. Treat these as candidate implementation choices, not immutable requirements. The final model, hosting, and serving setup must be selected based on measured evaluation results, performance, security, and infrastructure constraints.

If the deterministic side lexicon and LLM disagree, do not create a draft; ask for clarification and log the disagreement.

Treat spoken input as untrusted order data, not as instructions that can override system behavior, validation, authorization, or safety constraints. Prompt-injection cases must never produce a draft containing details beyond what the trader actually said.

When speech or field confidence is below empirically established thresholds, ask for clarification. Preserve reliable fields and ask only about the uncertain part when safe. Thresholds must be determined through testing.

Provide manual text entry if voice services are unavailable. It must use the same parsing, validation, ambiguity resolution, review, and confirmation workflow; it must not bypass safeguards.

## Pre-trade sanity checks

Possible checks include configured maximum quantity, maximum notional value, and maximum distance between limit price and a reference price. Do not invent trading limits or judge financial appropriateness without an explicit documented rule. Do not silently change an order based on market data.

When reference market data is used, disclose stale/unavailable data and do not present an unverified check as reliable. Provider, licensing, and freshness requirements remain implementation decisions.

## Silexx integration

The preferred integration is an official Silexx API/SDK that can populate a draft ticket without submitting it. **Verify this capability before committing to an implementation; it is a critical dependency.**

Keep trader confirmation and Silexx handoff as separate states. Possible handoff states include:
- Confirmed; awaiting handoff
- Handoff in progress
- Successfully populated in Silexx
- Handoff failed with known outcome
- Handoff outcome uncertain
- Reconciliation required

Retry transient failures only when safe. Use idempotency controls where supported. If reliable lookup is available, reconcile: if the ticket is present, mark success; if absent, retry only when safe; if outcome remains unknown, mark uncertain and tell the trader to check Silexx manually. If a known failure occurs and the draft has not changed, confirmation may remain valid. If the draft changes or outcome is uncertain, require reconciliation or renewed review/confirmation.

Multiple confirmed draft handoffs are independent.

## Authentication, permissions, and settings

Use the company's existing identity provider through SSO; provider and integration method remain open decisions. Fail closed if identity cannot be verified. Preserve drafts where possible when a session expires, but disable confirmation/handoff until authentication is restored.

Scope drafts and settings to the authenticated user. Attribute actions to the correct identity. The proposed Supervisor role has read-only access to authorized traders' drafts and audit records and cannot create, edit, or confirm orders on behalf of traders; final role mapping is an implementation decision.

Provide an in-app settings dashboard. Each user can change their own permitted preferences and defaults. Built-in defaults seed new users; updates must not overwrite existing saved settings. Existing drafts retain the settings/values used at creation; new drafts use current settings. Record relevant settings changes. Settings must not disable mandatory safeguards.

## Hosting, external services, and availability

Deploy as a **private hosted web application**, accessible only to authorized team members through a private URL and access controls. Hosting provider and storage backend remain open decisions.

Use controlled infrastructure, with local/self-hosted AI as the default. External AI, market-data, or other integrations may be enabled only through explicit configuration. Explain what data will be sent before enabling; secure credentials; never log secrets; do not share data silently.

If approved local/self-hosted AI components are unavailable, fail safely, preserve drafts, display a clear error, and resume when the approved services recover. Do not automatically switch to an unapproved external provider.

Use shared speech/AI processing for the initial release. Keep the architecture simple and monitor utilization, health, and latency. Ensure requests/results stay associated with the correct user. Do not add automatic infrastructure scaling in the initial release.

## Evaluation dataset and release management

The current evaluation dataset contains 463 cases, including categories such as:
- `side_lexicon`
- `spoken_numbers`
- `correction`
- `filler`
- `ambiguous`
- trap cases where refusal is correct
- `multi_order`
- `options`
- `prompt_injection`

Maintain development and heldout sets. Use stratified splitting so each category has at least 10 heldout cases. Version the dataset, review additions/changes, preserve previous versions, and record which dataset and component versions were evaluated. Production issues are reported manually; the team decides whether to add a case to the dataset. Do not retain raw production audio to investigate issues.

Measure exact case accuracy, hallucination rate, false reject rate, ambiguity recall, p50/p95 latency, WER, audio-to-draft accuracy relative to transcript-to-draft accuracy, and prompt-injection safety. Report rates with 95% Wilson confidence intervals. Use paired McNemar tests for case-by-case comparisons where applicable. Document benchmark hardware/network conditions.

Current development baseline:
- Accuracy: 94.5%
- Observed hallucinations: 0
- False reject rate: 8.4%
- Ambiguity recall: 100%
- p95 latency: 3.96 seconds

Targets:
- Heldout case accuracy ≥ 95%
- Zero observed hallucinations on trap cases, with upper confidence bound reported
- False reject rate ≤ 5%
- Ambiguity recall ≥ 95%
- LLM-path parse latency p95 < 1.5 seconds
- WER < 8%
- Audio-to-draft accuracy within 5 percentage points of transcript-to-draft accuracy
- Speak-to-draft latency p95 < 3 seconds
- 100% of prompt-injection cases produce no draft beyond what was actually said

The initial audio evaluation plan calls for at least 100 recorded clips from at least three speakers, including background noise, with reviewed reference transcripts. Obtain consent and define a separate evaluation-audio storage/retention policy before collection. This does not change the rule against retaining raw production audio.

### Automatic model/rule/validation updates

Updates to AI models, parsing rules, and validation logic may be automatic, but must pass automated evaluation before activation.

Before activation:
1. Run the approved versioned evaluation dataset.
2. Check overall targets and category-specific acceptance criteria.
3. Check critical order categories, options, ambiguity handling, and safety/prompt-injection cases.
4. Keep the current version active and notify the team if any required criterion fails.

After activation:
- Notify the team.
- Record component versions and update history.
- Monitor errors and performance.
- Retain the previous version for manual rollback.

Acceptance criteria, including minimums for critical categories, must be defined before automatic activation is enabled. Monitoring should alert the team if production performance degrades. The team can manually roll back; automatic production rollback is not required in the initial release.

Application releases follow staged deployment: test in non-production, verify parsing/validation/ambiguity/security/Silexx behavior, approve, deploy to production, and retain rollback capability.

## Auditability, privacy, and retention

Use a tamper-evident, hash-chained formal audit log, with a verification mechanism to detect editing, deletion, or reordering. PostgreSQL was proposed but the storage backend remains undecided.

Record relevant events:
- Initial interpretation and draft creation
- Relevant transcript and structured order interpretation, subject to the final sensitive-data policy
- Voice corrections and manual edits
- Validation failures, warnings, clarifications, and resolutions
- Confirmations and cancellations
- Silexx handoff attempts, retries, failures, and outcomes
- Relevant authentication and system events
- Settings changes affecting order creation
- Model, parsing-rule, validation, and evaluation version changes
- Audit exports

Clearly distinguish drafts, confirmed orders, cancellations, validation failures, and handoff outcomes. Never imply that a draft or populated ticket was executed.

Retention:
- User-facing recent history: 30 days
- Formal audit records: long-term retention with controlled archival
- Exact audit retention duration: to be finalized under company policy and applicable obligations
- Transcript/diagnostic metadata retention: to be finalized

Allow appropriately authorized users to export audit records as CSV or JSON. Enforce permissions and record who exported, when, and the scope. Do not expose secrets or unnecessary sensitive data. The initial audit interface should be basic, with access to records and export, rather than a full investigation console.

## Backups and operational monitoring

Use automated encrypted backups and tested recovery. Define recovery time and data-loss objectives during implementation. Restrict backup access, periodically test restoration, preserve audit integrity, and prevent recovery/retry from causing duplicate handoffs or order submission.

If backup or recovery fails, alert the responsible team for manual investigation. Preserve the last known-good backup where possible. Do not automatically initiate risky recovery actions or overwrite recoverable data.

Use OpenTelemetry for tracing and monitoring. Track:
- Per-stage latency
- Transcription failures
- Parsing/validation errors and refusal reasons
- Clarification frequency and fast-path hit rate
- LLM errors, latency, health, and resource use
- Silexx handoff success/failure/uncertain outcomes
- Backup/recovery failures
- Version changes and post-update performance

Provide in-app errors and a centralized monitoring dashboard. Email/other alerts can be added later. Avoid unnecessary sensitive order details, transcripts, credentials, and secrets in logs/telemetry.

## User-facing history and accessibility

Recent user-facing history contains drafts, confirmations, handoff outcomes, and timestamps, retained for 30 days. It is separate from formal audit records.

The UI should:
- Announce review cards, warnings, and confirmations to screen readers.
- Make order fields editable.
- Distinguish required fields, warnings, and blocking validation errors.
- Show processing status and understandable clarification requests.
- Clearly communicate awaiting confirmation, confirmed, populated, failed, and uncertain handoff states.
- Support keyboard-only use, to be validated during implementation.

## Trader validation study

Run a small within-subject study with approximately 3–5 traders and 20 tickets per participant. Counterbalance voice and typing workflows. Measure time per ticket, order-entry error rate, clarification frequency, correction effort, and cases where voice is slower or less reliable than typing. Do not use automatic order submission. Review real issues and decide manually whether to add them to the evaluation dataset.

## Implementation decisions still open

Resolve these before or during implementation:
1. Verify official Silexx draft population without submission.
2. Verify whether reliable Silexx handoff reconciliation/lookup is possible.
3. Finalize time-in-force, account selection, short-sale/buy-to-cover semantics, and other Silexx-required fields.
4. Select hosting provider and storage backend.
5. Identify SSO provider and map groups to application permissions.
6. Finalize audit retention and archival duration.
7. Finalize transcript and diagnostic metadata retention.
8. Define evaluation audio storage/consent policy.
9. Define approved external integrations and data-disclosure workflow.
10. Finalize audit access/export permissions.
11. Establish transcription and field-confidence thresholds through testing.
12. Define sanity-check thresholds and which settings users may change.
13. Select any market-data source and freshness requirements.
14. Document benchmark hardware/network conditions.
15. Define automated evaluation acceptance criteria, including critical-category minimums.
16. Define backup frequency/retention and recovery time/point objectives.
17. Finalize diagnostic metadata for issue investigation.
18. Finalize API schemas, supported audio formats, and error handling.
19. Validate accessibility and keyboard-only workflows.

## Proposed API endpoints

- `POST /api/parse`: transcript/context in; structured draft candidates, clarification requests, or refusals out.
- `POST /api/transcribe`: supported audio in; transcript and relevant processing metadata out.

Finalize schemas, payload limits, authentication, and error formats during implementation.

## Candidate technical stack

Original proposal:
- `whisper.cpp` for transcription
- Ollama for local/self-hosted LLM serving
- Deterministic parsing and validation in application code
- Schema-constrained LLM output
- PostgreSQL for formal audit storage, subject to storage decision
- OpenTelemetry for monitoring/tracing
- Docker Compose for local/dev service orchestration, subject to the selected hosted environment

Treat specific technologies as candidates where this document marks them open. Prioritize the safety invariants and measurable requirements over a particular framework or provider.

## Core release checklist

A release changing AI models, parsing rules, or validation logic must:
- Identify the changed versions.
- Run evaluation against the approved, versioned dataset.
- Check overall and category-specific criteria.
- Verify safety-critical and prompt-injection cases.
- Reject failed updates and keep the active version.
- Record results and component versions.
- Notify the team of activation or rejection.
- Preserve manual rollback.
- Maintain every core safety invariant.

Do not enable automatic activation until all required acceptance thresholds are explicitly defined.
