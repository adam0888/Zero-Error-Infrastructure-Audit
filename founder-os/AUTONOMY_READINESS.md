# Founder OS: Autonomy Readiness

## Ready now

The local Founder OS MVP is operational as a deterministic internal engine.

### Core operations

- Markdown-based agent personas:
  - Intake Gatekeeper
  - Business Coordinator
  - Tech Architect
- JSON flat-file ledgers:
  - `backlog.json`
  - `active.json`
  - `completed.json`
- Atomic ledger writes and audit logs
- Deterministic IDs with no random identifiers
- Application qualification:
  - Executive/technical role screening
  - Junior, agency, and nontechnical-manager filtering
  - PostgreSQL, MySQL, Aurora, and RDS detection
  - Infrastructure-scale checks
  - $2M–$20M ARR screening
- Lemon Squeezy payment-event processing:
  - `checkout.completed` and paid-event variants
  - $5,000+ USD threshold
  - Application matching
  - Idempotent webhook handling
  - `PENDING_BOOKING → ENGAGEMENT_ACTIVE`
- Technical draft generation:
  - Assessment
  - Migration strategy
  - Recommendations
- SHA-256 draft hashes and explicit confirmation records
- Safe MCP bridge implementation:
  - Disabled by default
  - Configurable HTTP endpoint
  - Text-block extraction
  - Timeout handling
  - No automatic send of unconfirmed drafts
- CLI and exported Node.js classes
- Passing verification:
  - `node test/run.js`: 49/49
  - `node src/orchestrator.js verify`: 12/12

## Needed before autonomous operation

The engine is ready as an internal foundation, but the business is **not yet fully autonomous**. The missing pieces are mostly integrations, production controls, and human-policy decisions.

### 1. Production hosting and process management

You need a secured always-on Linux host or VPS with:

- Supported Node.js runtime
- Private filesystem access
- Process manager such as `systemd` or Docker
- Automated backups for `.founder-os/queue/` and `.founder-os/logs/`
- Disk-space and process-health monitoring
- Restore testing

The current engine is a CLI/library, not an always-on public API.

### 2. Authenticated webhook receiver

You need a small HTTP adapter for Lemon Squeezy that:

1. Receives webhook requests
2. Verifies the Lemon Squeezy signature
3. Normalizes the payload
4. Writes a temporary event file or invokes the exported orchestrator
5. Processes the event exactly once
6. Returns an appropriate response
7. Handles retries safely

Do not expose `src/orchestrator.js` or the queue files directly to the public internet.

### 3. Real MCP mailbox deployment

The MCP bridge is present but disabled by default. To use it autonomously, you need:

- A running `/mcp` server
- Authentication and authorization
- TLS if accessed over a network
- Defined mailbox tools and request/response schemas
- Rate limits and timeout policy
- Logging without exposing secrets
- Tests against representative mailbox responses

The current bridge can query and queue controlled operations, but it is not itself a mailbox provider or MCP server.

### 4. Communication and calendar integrations

The business still needs actual integrations for:

- Email sending and receiving
- Calendar availability and booking
- Meeting links
- Client reminders
- Delivery notifications
- Support escalation

Founder OS currently generates drafts and logs confirmations; it does not provide email or calendar delivery by itself. Any outbound automation should include opt-out handling, recipient validation, and rate limits.

### 5. CRM and client identity model

You need a durable identity and relationship layer for:

- Contact and company identity
- Application-to-payment matching
- Engagement history
- Multiple contacts per client
- Duplicate applications
- Refunds, chargebacks, and cancellations
- Consent and communication preferences

The current flat files are suitable for the MVP and a single worker, but become fragile with concurrent operators or high volume.

### 6. Concurrency and recovery controls

Before multiple workers or webhooks run simultaneously, add:

- File locking or a single serialized worker
- Event inbox persistence
- Transaction/replay records
- Crash recovery
- Dead-letter queue
- Schema versioning
- Ledger integrity checks
- Backup rotation
- Restore procedures

Atomic file replacement protects individual writes, but does not make multi-process read-modify-write operations transactional.

### 7. Delivery automation

The Tech Architect persona can generate plans, but autonomous delivery requires additional workflow machinery:

- Engagement phases and deadlines
- Task decomposition
- Owner assignment
- Client artifact intake
- Technical evidence storage
- Review gates
- Sprint status tracking
- Acceptance criteria
- Escalation rules
- Final deliverable packaging

For infrastructure work, fully autonomous execution should remain restricted. The system can prepare recipes and identify likely bottlenecks, but production changes should require explicit technical approval.

### 8. Business rules requiring owner decisions

The system needs owner-approved policies for:

- Exact qualification boundaries
- Pricing and payment plans
- Refund and cancellation policy
- Whether borderline applicants receive manual review
- Booking availability
- Engagement start conditions
- What constitutes a completed engagement
- Which recommendations may be sent automatically
- When an engagement must escalate to a human
- Which client data may be retained and for how long

These are strategy and risk decisions, not engineering defaults.

## Recommended autonomy levels

### Level 1: Assisted operations — ready now

- Intake is screened automatically.
- Payment events activate engagements.
- Drafts are generated.
- You review and confirm communications.
- You manually run or supervise CLI commands.

### Level 2: Supervised automation — next milestone

Add:

- Authenticated Lemon Squeezy webhook adapter
- Email/calendar integrations
- MCP server authentication
- Scheduled worker
- Backup and monitoring
- Review dashboard
- Human approval gates for communication and production changes

This is the safest practical target for operating the consultancy.

### Level 3: High autonomy — later

Add:

- Durable event store
- Multi-process locking or a database
- Automated booking and reminders
- Client portal
- CRM and identity resolution
- SLA monitoring
- Automated delivery-status workflows
- Policy-based escalation
- Disaster recovery and audit reporting

Even at this level, production infrastructure changes and financially significant exceptions should retain explicit approval gates.

## Practical next build order

1. Add the authenticated Lemon Squeezy webhook receiver.
2. Deploy the engine as a single supervised worker.
3. Add secure backups and restore verification.
4. Connect an approved email/calendar system.
5. Deploy and authenticate the MCP mailbox server.
6. Add a lightweight operations dashboard.
7. Add file locking, dead-letter handling, and schema versioning.
8. Define and ratify business policies.
9. Automate routine client coordination while keeping financial, external-communication, and production-change approval gates.

## Bottom line

**The orchestration core is ready; the business execution perimeter is not.** What remains is the secure integration layer, production hosting, communications, booking, monitoring, and explicit operating policies required to let the system act without creating avoidable financial, privacy, or infrastructure risk.
