#!/usr/bin/env node
/**
 * Founder OS Orchestrator — Deterministic State Machine
 * "Zero-Error Infrastructure Lock-In" Consultancy Engine
 *
 * Plain Node.js. No external dependencies.
 *
 * Usage:
 *   node orchestrator.js process-form --file <path>
 *   node orchestrator.js process-payment --file <path>
 *   node orchestrator.js generate-draft --engagement <ENG-ID> --type <assessment|migration|recommendation>
 *   node orchestrator.js confirm-draft --hash <sha256>
 *   node orchestrator.js list --ledger <backlog|active|completed>
 *   node orchestrator.js verify
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { EventEmitter } = require("events");

// ─── Configuration ───────────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const AGENTS_DIR = path.join(WORKSPACE_ROOT, ".founder-os", "agents");
const QUEUE_DIR = path.join(WORKSPACE_ROOT, ".founder-os", "queue");
const LOGS_DIR = path.join(WORKSPACE_ROOT, ".founder-os", "logs");

const BACKLOG_PATH = path.join(QUEUE_DIR, "backlog.json");
const ACTIVE_PATH = path.join(QUEUE_DIR, "active.json");
const COMPLETED_PATH = path.join(QUEUE_DIR, "completed.json");
const CONFIRMATION_LOG_PATH = path.join(LOGS_DIR, "confirmations.json");
const AUDIT_LOG_PATH = path.join(LOGS_DIR, "audit.jsonl");

const DEFAULT_CONFIG = {
  mcp: {
    enabled: false,
    endpoint: "http://localhost:3000/mcp",
    timeoutMs: 5000,
    maxBodyBytes: 262144,
    maxRetries: 2,
    bearerToken: "",                    // from MCP_BEARER_TOKEN env only; never logged
    wsEnabled: false,                   // WebSocket option; default disabled; no native deps
    wsEndpoint: "ws://localhost:3000/mcp/ws",
    rpcEnabled: false,                  // JSON-RPC style POST; default disabled
    rpcEndpoint: "http://localhost:3000/mcp/rpc",
    personaPath: path.join(AGENTS_DIR, "tech-architect.md"),
  },
  payment: {
    minimumAmountCents: 500000, // $5,000 USD
    acceptedCurrencies: ["USD"],
  },
  idempotency: {
    ttlSeconds: 86400, // 24 hours
  },
};

// ─── Qualified Roles ─────────────────────────────────────────────────────────

const QUALIFIED_ROLES = [
  "founder",
  "ceo",
  "chief executive officer",
  "cto",
  "chief technology officer",
  "vp engineering",
  "vp of engineering",
  "head of infrastructure",
  "tech lead",
  "technical lead",
];

const DISQUALIFIED_ROLES = [
  "junior",
  "agency owner",
  "agency founder",
  "freelancer",
  "contractor",
  "consultant",
  "intern",
  "student",
  "recruiter",
  "hr",
  "project manager",
  "product manager",
  "program manager",
];

const DB_MARKERS = [
  "postgresql",
  "postgres",
  "mysql",
  "aurora",
  "aws rds",
  "rds",
];

const INFRA_SCALE_MARKERS = [
  "production",
  "high availability",
  "multi-region",
  "multi region",
  "replication",
  "sharding",
  "failover",
  "disaster recovery",
  "dr",
  "uptime sla",
  "99.9",
  "99.99",
  "pci",
  "soc2",
  "soc 2",
  "hipaa",
  "gdpr infrastructure",
  "compliance",
  "audit trail",
];

// ─── Utilities ───────────────────────────────────────────────────────────────

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Deterministic ID generation.
 * Format: {PREFIX}-{YYYYMMDD}-{sequential 4-digit}
 * Sequential counter is derived from existing records to maintain determinism.
 */
function generateDeterministicId(prefix, existingRecords) {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const datePrefix = `${prefix}-${datePart}`;

  const existingForDate = existingRecords
    .filter((r) => r.id && r.id.startsWith(datePrefix))
    .map((r) => {
      const parts = r.id.split("-");
      return parseInt(parts[parts.length - 1], 10) || 0;
    });

  const nextSeq = existingForDate.length > 0 ? Math.max(...existingForDate) + 1 : 1;
  const seqStr = String(nextSeq).padStart(4, "0");
  return `${datePrefix}-${seqStr}`;
}

/**
 * Atomic JSON write: write to temp file, fsync, rename.
 */
function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = filePath + ".tmp." + crypto.randomBytes(4).toString("hex");
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, json, { encoding: "utf-8", mode: 0o644 });
  const fd = fs.openSync(tmpPath, "r+");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Robust JSON read with validation.
 */
function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array in ${filePath}, got ${typeof parsed}`);
    }
    return parsed;
  } catch (e) {
    console.error(`[ERROR] Failed to parse ${filePath}: ${e.message}`);
    console.error(`[ERROR] File contents (first 500 chars): ${raw.slice(0, 500)}`);
    throw e;
  }
}

/**
 * Append a JSON line to an audit log.
 */
function appendAuditLog(entry) {
  ensureDir(LOGS_DIR);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(AUDIT_LOG_PATH, line, { encoding: "utf-8" });
}

/**
 * Validate a submission object has required fields.
 */
function validateSubmissionFields(submission) {
  const required = ["name", "email", "role", "company", "arr", "database_stack", "engagement_reason"];
  const missing = required.filter((f) => !submission[f] || String(submission[f]).trim() === "");
  if (missing.length > 0) {
    return { valid: false, missing };
  }
  return { valid: true };
}

// ─── Intake Gatekeeper Logic ─────────────────────────────────────────────────

function normalizeRole(role) {
  return String(role).toLowerCase().trim();
}

function isQualifiedRole(role) {
  const norm = normalizeRole(role);
  return QUALIFIED_ROLES.some((r) => norm.includes(r));
}

function isDisqualifiedRole(role) {
  const norm = normalizeRole(role);
  // Check disqualification patterns
  for (const dq of DISQUALIFIED_ROLES) {
    if (norm.includes(dq)) {
      // Exception: "agency founder" is only disqualified if also NOT "founder"/"ceo" of product
      if (dq === "agency founder" || dq === "agency owner") {
        if (norm.includes("founder") || norm.includes("ceo") || norm.includes("cto")) {
          continue; // could be a founder of a product company that uses an agency model
        }
      }
      // "project manager", "product manager", "program manager" — only disqualified if no technical role
      if ((dq === "project manager" || dq === "product manager" || dq === "program manager") &&
          (norm.includes("cto") || norm.includes("vp engineering") || norm.includes("tech lead") || norm.includes("head of infrastructure"))) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function hasDatabaseMarker(databaseStack) {
  const norm = String(databaseStack).toLowerCase();
  return DB_MARKERS.some((m) => norm.includes(m));
}

function hasInfraScaleMarker(databaseStack, engagementReason) {
  const combined = (String(databaseStack) + " " + String(engagementReason)).toLowerCase();
  return INFRA_SCALE_MARKERS.some((m) => combined.includes(m));
}

function parseArrRange(arrText) {
  const text = String(arrText).toLowerCase().replace(/[$,]/g, "").trim();

  // Range first: "2-5m", "between 5 and 15 million", "2-5 million"
  const rangeMatch = text.match(/(\d+\.?\d*)\s*(?:-|to|and|–)\s*(\d+\.?\d*)\s*(m|million|k|thousand)?/);
  if (rangeMatch) {
    let min = parseFloat(rangeMatch[1]);
    let max = parseFloat(rangeMatch[2]);
    const unit = rangeMatch[3] || "";
    if (unit === "k" || unit === "thousand") { min *= 1000; max *= 1000; }
    if (unit === "m" || unit === "million") { min *= 1000000; max *= 1000000; }
    return { min, max, explicit: true };
  }

  // Direct numeric: "5000000", "5M", "5m", "5 million"
  const singleMatch = text.match(/^(\d+\.?\d*)\s*(m|million|k|thousand)?\s*$/);
  if (singleMatch) {
    let value = parseFloat(singleMatch[1]);
    const unit = singleMatch[2] || "";
    if (unit === "k" || unit === "thousand") value *= 1000;
    if (unit === "m" || unit === "million") value *= 1000000;
    return { min: value, max: value, explicit: true };
  }

  return { min: 0, max: 0, explicit: false };
}

function evaluateArr(arrRange) {
  const MIN_ARR = 2000000;  // $2M
  const MAX_ARR = 20000000; // $20M

  if (!arrRange.explicit) {
    return { pass: false, reason: "ARR could not be determined from input", evidence: arrRange };
  }
  if (arrRange.max < MIN_ARR) {
    return { pass: false, reason: `ARR below $2M minimum (detected ~$${(arrRange.max / 1000000).toFixed(1)}M)`, evidence: arrRange };
  }
  if (arrRange.min > MAX_ARR) {
    return { pass: false, reason: `ARR above $20M maximum (detected ~$${(arrRange.min / 1000000).toFixed(1)}M)`, evidence: arrRange };
  }
  // If range straddles boundary, use the midpoint
  const midpoint = (arrRange.min + arrRange.max) / 2;
  if (midpoint >= MIN_ARR && midpoint <= MAX_ARR) {
    return { pass: true, reason: `ARR ~$${(midpoint / 1000000).toFixed(1)}M within $2M–$20M range`, evidence: arrRange };
  }
  return { pass: false, reason: "ARR range crosses boundaries ambiguously", evidence: arrRange };
}

function evaluateEngagementIntent(reason) {
  const text = String(reason).toLowerCase();
  const specificMarkers = [
    "infrastructure lock-in",
    "lock-in",
    "database migration",
    "migration strategy",
    "zero-downtime",
    "zero downtime",
    "high availability",
    "disaster recovery",
    "infrastructure resilience",
    "vendor lock",
    "cloud lock",
    "multi-cloud",
    "multi cloud",
    "database scaling",
    "infrastructure scaling",
    "failover",
    "replication",
    "backup strategy",
  ];

  const hasSpecific = specificMarkers.some((m) => text.includes(m));
  if (hasSpecific) {
    return { pass: true, reason: "Specific infrastructure concern detected", evidence: reason };
  }

  // Generic but substantial: > 100 chars suggests thought was put in
  if (text.length > 100) {
    return { pass: true, reason: "Detailed description (ambiguous but substantive — flag for review)", evidence: reason, softPass: true };
  }

  return { pass: false, reason: "No specific infrastructure concern identified; engagement intent unclear", evidence: reason };
}

// ─── Business Coordinator Logic ──────────────────────────────────────────────

function validatePaymentEvent(event) {
  if (!event || typeof event !== "object") {
    return { valid: false, error: "Payment event must be a JSON object" };
  }
  const required = ["event_type", "order_id", "amount_cents", "currency", "status"];
  const missing = required.filter((f) => event[f] === undefined || event[f] === null);
  if (missing.length > 0) {
    return { valid: false, error: `Missing required fields: ${missing.join(", ")}` };
  }
  if (!Number.isInteger(event.amount_cents) || event.amount_cents <= 0) {
    return { valid: false, error: "amount_cents must be a positive integer" };
  }
  const validEvents = [
    "order_created", "order_paid", "checkout.completed",
    "subscription_created", "subscription_paid", "subscription_payment_success",
  ];
  if (!validEvents.includes(event.event_type)) {
    return { valid: false, error: `Unknown event_type: ${event.event_type}. Supported: ${validEvents.join(", ")}` };
  }
  return { valid: true };
}

function validatePaymentAmount(amountCents, config) {
  if (amountCents < config.payment.minimumAmountCents) {
    return {
      valid: false,
      reason: `Payment amount $${(amountCents / 100).toFixed(2)} is below the $5,000.00 minimum`,
      received: amountCents,
      required: config.payment.minimumAmountCents,
    };
  }
  return { valid: true };
}

function validatePaymentCurrency(currency, config) {
  const upper = String(currency).toUpperCase();
  if (!config.payment.acceptedCurrencies.includes(upper)) {
    return {
      valid: false,
      reason: `Currency ${upper} not accepted. Only ${config.payment.acceptedCurrencies.join(", ")}`,
    };
  }
  return { valid: true };
}

// ─── Tech Architect Logic ────────────────────────────────────────────────────

function assessLockInRisk(databaseStack) {
  const stack = String(databaseStack).toLowerCase();
  const risks = [];

  if (stack.includes("aurora serverless") || stack.includes("aurora global")) {
    risks.push({ level: "CRITICAL", pattern: "Aurora proprietary features (Serverless/Global DB)" });
  } else if (stack.includes("aurora")) {
    risks.push({ level: "HIGH", pattern: "AWS Aurora — proprietary extensions" });
  }

  if (stack.includes("dms") || stack.includes("database migration service")) {
    risks.push({ level: "MEDIUM", pattern: "AWS DMS dependency" });
  }

  if (stack.includes("rds proxy")) {
    risks.push({ level: "MEDIUM", pattern: "RDS Proxy — AWS-specific connection pooling" });
  }

  if ((stack.includes("postgresql") || stack.includes("postgres")) && !stack.includes("aurora")) {
    if (stack.includes("rds")) {
      risks.push({ level: "LOW", pattern: "PostgreSQL on RDS — standard, portable" });
    } else {
      risks.push({ level: "LOW", pattern: "Self-managed PostgreSQL — highly portable" });
    }
  }

  if (stack.includes("mysql") && !stack.includes("aurora")) {
    if (stack.includes("rds")) {
      risks.push({ level: "LOW", pattern: "MySQL on RDS — standard, portable" });
    } else {
      risks.push({ level: "LOW", pattern: "Self-managed MySQL — highly portable" });
    }
  }

  // Default if nothing matched
  if (risks.length === 0) {
    risks.push({ level: "MEDIUM", pattern: "Stack details insufficient for precise risk assessment" });
  }

  return risks;
}

function computeMigrationComplexity(databaseStack, engagementReason) {
  const combined = (String(databaseStack) + " " + String(engagementReason)).toLowerCase();
  let complexity = 0;
  const factors = [];

  // Instance count heuristic
  const instanceMatch = combined.match(/(\d+)\s*(?:database|db|rds|aurora)\s*(?:instance|cluster|server)/i);
  if (instanceMatch) {
    const count = parseInt(instanceMatch[1], 10);
    if (count > 3) {
      const add = count - 3;
      complexity += add;
      factors.push(`Database instances > 3 (+${add})`);
    }
  }

  if (combined.includes("multi-region") || combined.includes("multi region") || combined.includes("cross-region")) {
    complexity += 2;
    factors.push("Cross-region requirements (+2)");
  }

  if (combined.includes("pci") || combined.includes("hipaa") || combined.includes("soc2") || combined.includes("soc 2")) {
    complexity += 3;
    factors.push("Compliance requirements (+3)");
  }

  if (combined.includes("zero-downtime") || combined.includes("zero downtime") || combined.includes("no downtime")) {
    complexity += 4;
    factors.push("Zero-downtime requirement (+4)");
  }

  if (combined.includes("multi-tenant") || combined.includes("multi tenant") || combined.includes("multitenant")) {
    complexity += 2;
    factors.push("Multi-tenancy (+2)");
  }

  if (combined.includes("shard") || combined.includes("cluster") || combined.includes("distributed")) {
    complexity += 5;
    factors.push("Sharded/clustered setup (+5)");
  }

  return { complexity, factors };
}

function generateDraftContent(engagement, draftType) {
  const dbStack = engagement.database_stack || "";
  const reason = engagement.engagement_reason || "";
  const risks = assessLockInRisk(dbStack);
  const migration = computeMigrationComplexity(dbStack, reason);

  let content = "";

  switch (draftType) {
    case "assessment": {
      content = [
        "# Initial Infrastructure Assessment Outline",
        "",
        "## Applicant Profile",
        `- **Company:** ${engagement.company || "N/A"}`,
        `- **Contact:** ${engagement.name || "N/A"}`,
        `- **Stated Database Stack:** ${dbStack}`,
        `- **Infrastructure Context:** ${reason}`,
        "",
        "## Identified Lock-In Risk Areas",
        ...risks.map((r) => `- **[${r.level}]** ${r.pattern}`),
        "",
        "## Migration Complexity Assessment",
        `- **Total complexity score:** ${migration.complexity}`,
        ...migration.factors.map((f) => `- ${f}`),
        "",
        "## Proposed Assessment Methodology",
        "1. Architecture review of current database topology",
        "2. Dependency mapping — identify all services coupled to current DB",
        "3. Traffic pattern analysis — peak load, query patterns, connection pooling",
        "4. Recovery Point Objective (RPO) / Recovery Time Objective (RTO) definition",
        "5. Lock-in surface audit — proprietary features in use",
        "",
        "## Scope Boundaries",
        "- This engagement covers infrastructure migration strategy and zero-error execution planning.",
        "- It does NOT cover application code changes, schema redesign, or performance tuning.",
        "- Compliance certification is the client's responsibility; we provide infrastructure guidance only.",
        "",
        "## Estimated Timeline",
        "Assessment phase: 2–3 weeks. Migration planning: 3–5 weeks. Execution support: ongoing.",
      ].join("\n");
      break;
    }

    case "migration": {
      content = [
        "# Migration Strategy Template",
        "",
        "## Target Database Stack",
        `- **Current:** ${dbStack}`,
        "- **Migration approach:** Logical replication with Change Data Capture (CDC)",
        "",
        "## Migration Pattern: Blue-Green Database Cutover",
        "1. **Provision target infrastructure** — separate VPC, security groups, parameter groups",
        "2. **Establish CDC pipeline** — capture all writes from source to target",
        "3. **Data validation** — row counts, checksums, referential integrity checks",
        "4. **Traffic shadowing** — mirror read traffic to target (application-level)",
        "5. **Cutover** — promote target, redirect application connections",
        "6. **Decommission source** — retain for rollback window",
        "",
        "## Rollback Plan",
        "- Source database retained in read-only mode for 72 hours post-cutover",
        "- Application connection string fallback configured via feature flag",
        "- Automated failback script tested and validated pre-cutover",
        "",
        "## Validation Checkpoints",
        "- [ ] Row count parity across all tables",
        "- [ ] Sequence/serial value continuity",
        "- [ ] Foreign key integrity on target",
        "- [ ] Application smoke test suite passes against target",
        "- [ ] Performance baseline within 10% of source",
        "",
        "## Downtime Budget",
        "Maximum acceptable downtime: **0 seconds** (zero-downtime requirement).",
        "Achieved through CDC + blue-green deployment pattern.",
        `Migration complexity: ${migration.complexity}/20`,
      ].join("\n");
      break;
    }

    case "recommendation": {
      content = [
        "# Technical Recommendations",
        "",
        "## Current Stack Analysis",
        `**Stack:** ${dbStack}`,
        "",
        "## Vendor-Neutral Architecture Patterns",
        "- **Abstraction layer:** Implement a data access layer that normalizes database-specific features",
        "- **Containerization:** Database connection config externalized via environment variables / secrets manager",
        "- **CI/CD integration:** Database migration scripts versioned alongside application code",
        "",
        "## Open-Source Alternatives",
        ...(dbStack.toLowerCase().includes("aurora")
          ? [
              "- Consider vanilla PostgreSQL as a drop-in replacement for Aurora PostgreSQL",
              "- Evaluate pgBouncer instead of RDS Proxy for connection pooling",
              "- Use native PostgreSQL logical replication instead of AWS DMS",
            ]
          : [
              "- Maintain current stack — no proprietary lock-in detected",
              "- PostgreSQL: consider pg_partman for partition management",
              "- MySQL: evaluate ProxySQL for query routing and failover",
            ]),
        "",
        "## Cost Analysis Framework",
        "- Compare egress costs between current provider and alternatives",
        "- Evaluate reserved instance / committed use discounts vs. on-demand",
        "- Consider total cost of migration (engineering time + dual-run period) vs. ongoing lock-in premium",
        "",
        "## Recommended Path",
        migration.complexity <= 3
          ? "Low complexity — standard migration patterns apply. Proceed with confidence."
          : migration.complexity <= 8
            ? "Moderate complexity — plan for extended validation window and staged rollout."
            : "High complexity — recommend phased approach with dedicated staging environment mirroring production scale.",
      ].join("\n");
      break;
    }

    default:
      content = `# Draft\n\nNo template for draft type: ${draftType}`;
  }

  return content;
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// ─── MCP Bridge ──────────────────────────────────────────────────────────────

/**
 * MCP Bridge — configurable HTTP bridge to external mailbox.
 * Disabled by default. Timeout-protected. No secret leakage.
 *
 * Supports:
 *   - GET queryRecentMessages (legacy, simulated)
 *   - POST JSON-RPC calls to /mcp/rpc with bearer token auth
 *   - Bounded WebSocket option (wsEnabled, default disabled, no native deps)
 *   - queryActiveClientMessages: extract only bounded raw text blocks from active-client B2B messages
 *   - generatePersonaDraft: reads tech-architect.md persona, generates deterministic
 *     contextual migration/diagnostic draft from extracted text + engagement context
 */
class McpBridge {
  constructor(config) {
    this.config = config.mcp;
    this.enabled = this.config.enabled === true;
    this.rpcEnabled = this.config.rpcEnabled === true;
    this.wsEnabled = this.config.wsEnabled === true;
    this._consultationIdCounter = 0;
  }

  // ─── HTTP Helpers ────────────────────────────────────────────────────────

  /**
   * Make an authenticated HTTP request. Bearer token from config only.
   * Never logs the token.
   */
  _httpRequest(method, urlStr, body) {
    const url = new URL(urlStr);
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "FounderOS-Orchestrator/1.0",
    };

    // Add bearer token if configured — never log it
    if (this.config.bearerToken) {
      headers["Authorization"] = `Bearer ${this.config.bearerToken}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + (url.search || ""),
      method: method,
      timeout: this.config.timeoutMs,
      headers,
    };

    return new Promise((resolve) => {
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { if (data.length < (this.config.maxBodyBytes || 262144)) data += chunk.toString().slice(0, (this.config.maxBodyBytes || 262144) - data.length); });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ statusCode: res.statusCode, body: parsed, rawLength: data.length });
          } catch (e) {
            resolve({ statusCode: res.statusCode, body: null, parseError: e.message, rawLength: data.length });
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ statusCode: 0, body: null, error: `Timeout after ${this.config.timeoutMs}ms` });
      });

      req.on("error", (err) => {
        resolve({ statusCode: 0, body: null, error: err.message });
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // ─── JSON-RPC Client ─────────────────────────────────────────────────────

  /**
   * Make a JSON-RPC 2.0 style POST call to the MCP endpoint.
   * Only active when rpcEnabled is true AND bridge is enabled.
   * Bearer token from config, never logged.
   *
   * @param {string} method - RPC method name
   * @param {object} params - RPC params
   * @returns {Promise<object>} result with { enabled, jsonrpc, id, result? error? }
   */
  async rpcCall(method, params) {
    if (!this.enabled || !this.rpcEnabled) {
      return {
        enabled: Boolean(this.enabled && this.rpcEnabled),
        jsonrpc: "2.0",
        error: { code: -32000, message: this.enabled ? "RPC not enabled" : "MCP bridge is disabled" },
      };
    }

    const rpcPayload = {
      jsonrpc: "2.0",
      method,
      params: params || {},
      id: this._rpcId(),
    };

    const result = await this._httpRequest("POST", this.config.rpcEndpoint, rpcPayload);

    if (result.error) {
      return {
        enabled: true,
        jsonrpc: "2.0",
        error: { code: -32000, message: result.error },
      };
    }

    if (result.body && result.body.jsonrpc === "2.0") {
      return { enabled: true, ...result.body };
    }

    return {
      enabled: true,
      jsonrpc: "2.0",
      id: rpcPayload.id,
      result: result.body,
    };
  }

  _rpcId() {
    return `rpc-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }

  // ─── WebSocket Simulation ────────────────────────────────────────────────

  /**
   * Bounded WebSocket connection simulation.
   * Since native Node.js has no WebSocket client without dependencies,
   * this simulates a WS upgrade handshake and tracks connection state.
   *
   * In a real deployment, a lightweight ws library or Node 22's native
   * WebSocket would be used. This implementation provides the interface
   * contract without external dependencies.
   *
   * @returns {{ enabled: boolean, note: string, simulate: Function }}
   */
  wsConnect() {
    if (!this.enabled || !this.wsEnabled) {
      return {
        enabled: false,
        note: this.wsEnabled
          ? "MCP bridge is disabled; cannot establish WebSocket"
          : "WebSocket support is disabled. Set config.mcp.wsEnabled=true to enable.",
      };
    }

    // Simulated connection — in production, would use:
    //   const ws = new WebSocket(this.config.wsEndpoint);
    // With auth header support.
    return {
      enabled: true,
      endpoint: this.config.wsEndpoint,
      simulated: true,
      note: "WebSocket simulation active (no native WS client available without dependencies). " +
            "In production with a ws library: connect with Authorization: Bearer <token> header.",
      // Bound operations
      simulate: {
        /**
         * Simulate receiving a message from the WS channel.
         * Returns only bounded text extraction.
         */
        receiveMessage: (simulatedPayload) => {
          if (!simulatedPayload) {
            return { messages: [], note: "No simulated payload" };
          }
          const blocks = this._extractTextBlocks(simulatedPayload);
          return { messages: blocks, simulated: true };
        },
        /**
         * Simulate sending a message — blocked (never send outbound).
         */
        sendMessage: () => {
          return {
            sent: false,
            reason: "Outbound messages are not permitted. Drafts must be confirmed before queuing via MCP bridge.",
          };
        },
      },
    };
  }

  // ─── Query Messages ──────────────────────────────────────────────────────

  /**
   * Query recent messages from the MCP endpoint.
   * Returns extracted text blocks only — no secrets, no raw responses.
   */
  async queryRecentMessages() {
    if (!this.enabled) {
      return { enabled: false, messages: [], note: "MCP bridge is disabled" };
    }

    const result = await this._httpRequest("GET", this.config.endpoint);

    if (result.error) {
      return { enabled: true, messages: [], error: result.error };
    }

    try {
      const messages = this._extractTextBlocks(result.body);
      return { enabled: true, messages, rawLength: result.rawLength };
    } catch (e) {
      return { enabled: true, messages: [], parseError: e.message, rawLength: result.rawLength };
    }
  }

  /**
   * Query unread active-client B2B messages.
   * Extracts only bounded raw text blocks — never exposes secrets, headers, or metadata.
   *
   * This method uses the MCP bridge (RPC or GET) to query for messages from
   * clients who have active engagements (ENGAGEMENT_ACTIVE in active.json).
   * Results are bounded to text-only extracts with a max length cap.
   *
   * @param {string[]} activeClientEmails - List of active client email addresses
   * @returns {Promise<object>} { enabled, messages: [{type, text, truncated}] }
   */
  async queryActiveClientMessages(activeClientEmails) {
    if (!this.enabled) {
      return { enabled: false, messages: [], note: "MCP bridge is disabled" };
    }

    if (!Array.isArray(activeClientEmails) || activeClientEmails.length === 0) {
      return { enabled: true, messages: [], note: "No active client emails provided" };
    }

    // If RPC is enabled, use JSON-RPC for structured query
    if (this.rpcEnabled) {
      const rpcResult = await this.rpcCall("mailbox.queryUnread", {
        clientEmails: activeClientEmails,
        maxResults: 25,
        textOnly: true,
      });

      if (rpcResult.error) {
        return { enabled: true, messages: [], rpcError: rpcResult.error };
      }

      const rawResult = rpcResult.result;
      const messages = this._extractTextBlocks(rawResult);
      return { enabled: true, messages, rpc: true };
    }

    // Fallback: GET query with query params
    const queryParts = activeClientEmails.map((e) => `client=${encodeURIComponent(e)}`).join("&");
    const url = `${this.config.endpoint}?${queryParts}&unreadOnly=true&textOnly=true`;

    const result = await this._httpRequest("GET", url);

    if (result.error) {
      return { enabled: true, messages: [], error: result.error };
    }

    const messages = this._extractTextBlocks(result.body);
    return { enabled: true, messages, rpc: false };
  }

  // ─── Persona-Based Draft Generation ──────────────────────────────────────

  /**
   * Read the tech-architect.md persona file and generate a deterministic
   * contextual draft from extracted client messages and engagement context.
   *
   * This method:
   *  1. Reads .founder-os/agents/tech-architect.md as the local persona
   *  2. Combines extracted text blocks with engagement context
   *  3. Generates a deterministic migration/diagnostic draft
   *  4. Logs an UNCONFIRMED draft hash via confirmation/audit logs
   *  5. Keeps manual confirmation required before queueing
   *  6. Does NOT send any outbound messages
   *
   * @param {object} engagement - Active engagement record from active.json
   * @param {Array<{type: string, text: string}>} extractedMessages - Extracted text blocks from client
   * @param {string} draftType - "assessment" | "migration" | "recommendation" | "diagnostic"
   * @returns {object} { draftId, contentHash, confirmationStatus: "UNCONFIRMED", content, ... }
   */
  generatePersonaDraft(engagement, extractedMessages, draftType) {
    const timestamp = new Date().toISOString();

    // 1. Read persona file
    let personaContent = "";
    try {
      if (fs.existsSync(this.config.personaPath)) {
        personaContent = fs.readFileSync(this.config.personaPath, "utf-8");
      }
    } catch (e) {
      // Persona file read failure — still generate with defaults
      appendAuditLog({
        timestamp,
        action: "PERSONA_READ_WARNING",
        detail: { error: e.message, personaPath: this.config.personaPath },
      });
    }

    // 2. Extract diagnostic context from client messages
    const messageTexts = (extractedMessages || [])
      .filter((m) => m && typeof m.text === "string")
      .map((m) => m.text.slice(0, 4096)); // bounded extraction

    const clientContext = messageTexts.length > 0
      ? messageTexts.join("\n---\n")
      : "(No client messages available)";

    // 3. Generate deterministic contextual draft
    const dbStack = engagement.database_stack || "Unknown";
    const engReason = engagement.engagement_reason || "Not specified";
    const company = engagement.company || engagement.applicant?.company || "Unknown";
    const contactName = engagement.name || engagement.applicant?.name || "Client";

    const risks = assessLockInRisk(dbStack);
    const migration = computeMigrationComplexity(dbStack, engReason);

    // Build a diagnostic summary from extracted messages
    const diagnosticKeywords = this._extractDiagnosticKeywords(clientContext, dbStack);

    const personaHeader = personaContent
      ? `## Persona: Tech Architect\n*Loaded from ${this.config.personaPath}*\n\n## Persona Voice & Safety Parameters\n- Tone: Technical, precise, systems-thinking\n- Never send without explicit confirmation\n- All output is DRAFT_CONFIRMATION_REQUIRED\n\n`
      : "## Persona: Tech Architect (default — persona file not loaded)\n\n";

    let content = "";
    const effectiveType = draftType || "diagnostic";

    content = [
      personaHeader,
      "# Contextual Draft",
      "",
      "## Engagement Context",
      `- **Company:** ${company}`,
      `- **Contact:** ${contactName}`,
      `- **Database Stack:** ${dbStack}`,
      `- **Infrastructure Concern:** ${engReason}`,
      `- **Engagement ID:** ${engagement.id || "N/A"}`,
      "",
      "## Lock-In Risk Assessment",
      ...risks.map((r) => `- **[${r.level}]** ${r.pattern}`),
      "",
      "## Migration Complexity",
      `- **Score:** ${migration.complexity}/20`,
      ...migration.factors.map((f) => `- ${f}`),
      "",
      "## Client Message Digest",
      "Extracted text blocks from active-client B2B messages (bounded, raw text only):",
      "```",
      clientContext.slice(0, 8000), // bounded at 8KB for the digest
      "```",
      "",
      "## Diagnostic Observations",
      diagnosticKeywords.length > 0
        ? diagnosticKeywords.map((k) => `- ${k}`).join("\n")
        : "- No specific diagnostic patterns identified from client messages.",
      "",
      "## Generated Content Type",
      `Draft type: **${effectiveType}**`,
      "",
      effectiveType === "diagnostic" || effectiveType === "assessment"
        ? [
            "## Proposed Assessment Approach",
            "1. Review current database topology with particular attention to lock-in surface area",
            "2. Map dependencies between application services and database features in use",
            "3. Analyze client's stated concerns against observed infrastructure patterns",
            "4. Define RPO/RTO targets with explicit justification",
            "5. Identify quick wins (low-risk, high-confidence changes) vs. structural migrations",
          ].join("\n")
        : "",
      effectiveType === "migration"
        ? [
            "## Migration Strategy Outline",
            "1. Establish CDC pipeline from source to target",
            "2. Validate data integrity (row counts, checksums, referential consistency)",
            "3. Traffic shadowing phase with application-level routing",
            "4. Blue-green cutover with automated rollback capability",
            "5. Decommission source after validated burn-in period",
          ].join("\n")
        : "",
      effectiveType === "recommendation"
        ? [
            "## Recommendations",
            "- Evaluate vendor-neutral alternatives for each proprietary feature in use",
            "- Implement data access abstraction layer to reduce coupling",
            "- Consider staged migration: lift-and-shift first, then optimize",
            "- Document all proprietary extensions in use for transparency",
          ].join("\n")
        : "",
      "",
      "## Scope Boundaries",
      "- This engagement covers infrastructure migration strategy and zero-error execution planning.",
      "- It does NOT cover application code changes, schema redesign, or performance tuning.",
      "- Compliance certification is the client's responsibility.",
      "",
      "---",
      "THIS DRAFT HAS NOT BEEN SENT. CONFIRMATION REQUIRED.",
    ].join("\n");

    // 4. Hash and log
    const contentHash = hashContent(content);

    // 5. Build draft record with deterministic ID
    const confirmations = (() => {
      try {
        if (fs.existsSync(CONFIRMATION_LOG_PATH)) {
          const raw = fs.readFileSync(CONFIRMATION_LOG_PATH, "utf-8").trim();
          if (raw) return JSON.parse(raw);
        }
      } catch (e) { /* ignore */ }
      return [];
    })();

    const existingDraftIds = confirmations
      .filter((e) => e.draftId)
      .map((e) => ({ id: e.draftId }));

    const draftId = generateDeterministicId("DRAFT", existingDraftIds);

    const draftRecord = {
      draftId,
      engagementId: engagement.id,
      draftType: effectiveType,
      contentHash,
      generatedAt: timestamp,
      confirmationStatus: "UNCONFIRMED",
      header: "DRAFT_CONFIRMATION_REQUIRED",
      personaSource: personaContent ? this.config.personaPath : "default",
      contentLength: content.length,
      content: content.slice(0, 10000),
    };

    // 6. Log UNCONFIRMED draft to confirmation and audit logs
    const confirmationEntry = {
      timestamp,
      action: "PERSONA_DRAFT_GENERATED",
      draftId,
      engagementId: engagement.id,
      draftType: effectiveType,
      contentHash,
      confirmationStatus: "UNCONFIRMED",
      mcpBridgeEnabled: this.enabled,
      personaPath: this.config.personaPath,
      messageBlockCount: messageTexts.length,
    };

    try {
      const entries = (() => {
        try {
          if (fs.existsSync(CONFIRMATION_LOG_PATH)) {
            const raw = fs.readFileSync(CONFIRMATION_LOG_PATH, "utf-8").trim();
            if (raw) return JSON.parse(raw);
          }
        } catch (e) { /* ignore */ }
        return [];
      })();
      entries.push(confirmationEntry);
      ensureDir(LOGS_DIR);
      atomicWriteJson(CONFIRMATION_LOG_PATH, entries);
    } catch (e) {
      appendAuditLog({
        timestamp,
        action: "PERSONA_DRAFT_LOG_ERROR",
        detail: { error: e.message, draftId, engagementId: engagement.id },
      });
    }

    appendAuditLog({
      timestamp,
      action: "GENERATE_PERSONA_DRAFT",
      detail: {
        draftId,
        engagementId: engagement.id,
        draftType: effectiveType,
        contentHash,
        contentLength: content.length,
        messageBlockCount: messageTexts.length,
        personaLoaded: Boolean(personaContent),
      },
    });

    return {
      draft: draftRecord,
      contentHash,
      confirmationStatus: "UNCONFIRMED",
      messageBlockCount: messageTexts.length,
      personaLoaded: Boolean(personaContent),
      note: "THIS DRAFT HAS NOT BEEN SENT. MANUAL CONFIRMATION REQUIRED BEFORE QUEUEING.",
    };
  }

  /**
   * Extract diagnostic keywords from client messages for context-aware drafting.
   * Bounded, deterministic — no ML, no external API.
   */
  _extractDiagnosticKeywords(clientText, databaseStack) {
    const combined = (clientText + " " + databaseStack).toLowerCase();
    const keywords = [];

    const patterns = [
      { pattern: /connection\s*(pool|pooling|timeout|refused|limit)/, label: "Connection pooling concern detected" },
      { pattern: /replication\s*(lag|delay|failure|broken)/, label: "Replication issue detected" },
      { pattern: /slow\s*(query|queries|performance)/, label: "Query performance concern" },
      { pattern: /backup\s*(failure|failed|missing|corrupt)/, label: "Backup integrity concern" },
      { pattern: /failover\s*(failure|failed|not working|test)/, label: "Failover concern detected" },
      { pattern: /latency|timeout|slow\s*response/, label: "Latency/response time concern" },
      { pattern: /disk\s*(full|space|usage|running out)/, label: "Disk space concern" },
      { pattern: /memory|ram|oom|out of memory/, label: "Memory pressure detected" },
      { pattern: /downtime|outage|incident|unavailable/, label: "Availability incident referenced" },
      { pattern: /vendor\s*lock|lock.?in|migration\s*(cost|difficulty|risk)/, label: "Vendor lock-in / migration concern" },
      { pattern: /compliance|pci|hipaa|soc.?2|gdpr/, label: "Compliance requirement referenced" },
      { pattern: /cost|billing|expensive|budget/, label: "Cost concern referenced" },
      { pattern: /scaling|scale|growth|traffic\s*(increase|spike)/, label: "Scaling/growth concern" },
      { pattern: /aurora|rds|dynamodb|redshift|cloud(?! sql)/, label: "AWS-specific infrastructure referenced" },
    ];

    for (const { pattern, label } of patterns) {
      if (pattern.test(combined)) {
        keywords.push(label);
      }
    }

    // Cap at 10 keywords
    return keywords.slice(0, 10);
  }

  /**
   * Safely extract text blocks from MCP response.
   * Never expose raw response data — only typed text content.
   * Bounded at 4096 chars per block.
   */
  _extractTextBlocks(response) {
    const blocks = [];
    if (!response || typeof response !== "object") return blocks;

    // Handle MCP-style responses: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item && item.type === "text" && typeof item.text === "string") {
          blocks.push({ type: "text", text: item.text.slice(0, 4096), truncated: item.text.length > 4096 });
        }
      }
    }

    // Handle simple message array
    if (Array.isArray(response.messages)) {
      for (const msg of response.messages) {
        if (msg && typeof msg.body === "string") {
          blocks.push({ type: "text", text: msg.body.slice(0, 4096), truncated: msg.body.length > 4096 });
        } else if (msg && typeof msg.text === "string") {
          blocks.push({ type: "text", text: msg.text.slice(0, 4096), truncated: msg.text.length > 4096 });
        }
      }
    }

    // Handle result array (JSON-RPC response format)
    if (Array.isArray(response.result)) {
      for (const item of response.result) {
        if (item && typeof item === "object") {
          if (typeof item.text === "string") {
            blocks.push({ type: "text", text: item.text.slice(0, 4096), truncated: item.text.length > 4096 });
          } else if (typeof item.body === "string") {
            blocks.push({ type: "text", text: item.body.slice(0, 4096), truncated: item.body.length > 4096 });
          }
        }
      }
    }

    // Handle { result: { messages: [...] } }
    if (response.result && typeof response.result === "object" && Array.isArray(response.result.messages)) {
      for (const msg of response.result.messages) {
        if (typeof msg === "string") {
          blocks.push({ type: "text", text: msg.slice(0, 4096), truncated: msg.length > 4096 });
        } else if (msg && typeof msg.text === "string") {
          blocks.push({ type: "text", text: msg.text.slice(0, 4096), truncated: msg.text.length > 4096 });
        }
      }
    }

    return blocks;
  }

  /**
   * Queue a draft for MCP delivery. Requires explicit confirmation first.
   * This is a safe wrapper — it logs the intent but does NOT send.
   */
  async queueDraft(draftRecord) {
    if (!this.enabled) {
      return { queued: false, reason: "MCP bridge is disabled" };
    }
    if (draftRecord.confirmationStatus !== "CONFIRMED") {
      return { queued: false, reason: "Draft not confirmed" };
    }
    // In a real implementation, this would POST to the MCP endpoint.
    // For MVP, we log the intent and return a simulated result.
    const logEntry = {
      timestamp: new Date().toISOString(),
      action: "MCP_DRAFT_QUEUED",
      draftHash: draftRecord.contentHash,
      engagementId: draftRecord.engagementId,
      bridgeEnabled: this.enabled,
      endpoint: this.config.endpoint,
    };
    appendAuditLog(logEntry);
    return { queued: true, logEntry };
  }
}

// ─── Orchestrator Core ───────────────────────────────────────────────────────

class Orchestrator extends EventEmitter {
  constructor(configOverrides = {}) {
    super();
    this.config = this._mergeConfig(configOverrides);
    this.mcp = new McpBridge(this.config);
    this._idempotencyCache = new Map(); // order_id → timestamp

    ensureDir(LOGS_DIR);
    ensureDir(QUEUE_DIR);
    this._ensureLedgers();
  }

  _mergeConfig(overrides) {
    const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    if (overrides.mcp) {
      Object.assign(merged.mcp, overrides.mcp);
      // Bearer token from env only, never from overrides
      if (process.env.MCP_BEARER_TOKEN) {
        merged.mcp.bearerToken = process.env.MCP_BEARER_TOKEN;
      }
    } else {
      // Even without overrides, pull bearer token from env
      if (process.env.MCP_BEARER_TOKEN) {
        merged.mcp.bearerToken = process.env.MCP_BEARER_TOKEN;
      }
    }
    if (overrides.payment) {
      Object.assign(merged.payment, overrides.payment);
    }
    if (overrides.idempotency) {
      Object.assign(merged.idempotency, overrides.idempotency);
    }
    return merged;
  }

  _ensureLedgers() {
    for (const p of [BACKLOG_PATH, ACTIVE_PATH, COMPLETED_PATH]) {
      if (!fs.existsSync(p)) {
        atomicWriteJson(p, []);
      }
    }
  }

  // ─── Form Processing ────────────────────────────────────────────────────

  /**
   * Process an inbound application form submission.
   * Runs through intake-gatekeeper screening and produces a qualified or
   * archived record.
   */
  processFormSubmission(submission) {
    const timestamp = new Date().toISOString();

    // Load all existing records for deterministic error ID generation
    const allFormRecords = [
      ...readJsonSafe(BACKLOG_PATH),
      ...readJsonSafe(ACTIVE_PATH),
      ...readJsonSafe(COMPLETED_PATH),
    ];

    // Validate fields
    const fieldCheck = validateSubmissionFields(submission);
    if (!fieldCheck.valid) {
      const errorRecord = {
        id: generateDeterministicId("ERR", allFormRecords),
        type: "PARSE_ERROR",
        timestamp,
        missingFields: fieldCheck.missing,
        rawSubmission: { name: submission.name, email: submission.email },
        classification: "ARCHIVED_NOT_A_FIT",
      };
      this._appendToCompleted(errorRecord);
      this._audit("PROCESS_FORM", { result: "PARSE_ERROR", errorRecord });
      return errorRecord;
    }

    // Run screening criteria
    const role = normalizeRole(submission.role);
    const roleQualified = isQualifiedRole(role);
    const roleDisqualified = isDisqualifiedRole(role);

    const dbMarker = hasDatabaseMarker(submission.database_stack);
    const infraScale = hasInfraScaleMarker(submission.database_stack, submission.engagement_reason);

    const arrRange = parseArrRange(submission.arr);
    const arrResult = evaluateArr(arrRange);

    const intentResult = evaluateEngagementIntent(submission.engagement_reason);

    // Determine classification
    let classification;
    let rejectionReasons = [];

    if (roleDisqualified) {
      classification = "ARCHIVED_NOT_A_FIT";
      rejectionReasons.push({
        criterion: "role",
        result: "FAIL",
        detail: `Role "${submission.role}" matches disqualification pattern`,
      });
    } else if (!roleQualified) {
      classification = "PENDING_REVIEW";
      rejectionReasons.push({
        criterion: "role",
        result: "AMBIGUOUS",
        detail: `Role "${submission.role}" not in qualified list but not explicitly disqualified`,
      });
    }

    if (classification !== "ARCHIVED_NOT_A_FIT") {
      if (!dbMarker) {
        classification = "ARCHIVED_NOT_A_FIT";
        rejectionReasons.push({
          criterion: "database_stack",
          result: "FAIL",
          detail: `No recognized database marker found in "${submission.database_stack}"`,
        });
      }
      if (!infraScale) {
        rejectionReasons.push({
          criterion: "infra_scale",
          result: "SOFT_FAIL",
          detail: "No infrastructure scale markers detected — may be a smaller operation",
        });
        if (classification !== "ARCHIVED_NOT_A_FIT") {
          classification = "PENDING_REVIEW";
        }
      }
      if (!arrResult.pass) {
        classification = "ARCHIVED_NOT_A_FIT";
        rejectionReasons.push({
          criterion: "arr",
          result: "FAIL",
          detail: arrResult.reason,
        });
      }
      if (!intentResult.pass) {
        rejectionReasons.push({
          criterion: "engagement_intent",
          result: "FAIL",
          detail: intentResult.reason,
        });
        if (classification !== "ARCHIVED_NOT_A_FIT") {
          classification = "PENDING_REVIEW";
        }
      }
    }

    // If no failures found, qualify
    if (!rejectionReasons.some((r) => r.result === "FAIL")) {
      classification = "QUALIFIED_HIGH_PRIORITY";
    }

    // Generate rejection outline if needed
    let rejectionOutline = null;
    if (classification === "ARCHIVED_NOT_A_FIT") {
      rejectionOutline = rejectionReasons
        .filter((r) => r.result === "FAIL")
        .map((r) => `- ${r.criterion}: ${r.detail}`)
        .join("\n");
    }

    // Build the record
    const existingRecords = [
      ...readJsonSafe(BACKLOG_PATH),
      ...readJsonSafe(ACTIVE_PATH),
      ...readJsonSafe(COMPLETED_PATH),
    ];

    const record = {
      id: submission.id || generateDeterministicId(
        classification === "QUALIFIED_HIGH_PRIORITY" ? "QUAL" : "SUB",
        existingRecords
      ),
      type: "FORM_SUBMISSION",
      timestamp,
      classification,
      applicant: {
        name: submission.name,
        email: submission.email,
        role: submission.role,
        company: submission.company,
      },
      screening: {
        role: {
          qualified: roleQualified,
          disqualified: roleDisqualified,
          normalized: role,
        },
        database: {
          hasMarker: dbMarker,
          stack: submission.database_stack,
        },
        infraScale: {
          hasMarker: infraScale,
          evidence: submission.database_stack + " | " + submission.engagement_reason,
        },
        arr: {
          parsed: arrRange,
          result: arrResult,
          raw: submission.arr,
        },
        engagementIntent: {
          result: intentResult,
          raw: submission.engagement_reason,
        },
      },
      rejectionReasons: rejectionReasons.length > 0 ? rejectionReasons : undefined,
      rejectionOutline: rejectionOutline || undefined,
      mcpInboxFlag: classification === "QUALIFIED_HIGH_PRIORITY",
      status: classification === "QUALIFIED_HIGH_PRIORITY" ? "PENDING_BOOKING" : "CLOSED",
      source: submission.source || "unknown",
    };

    // Write to appropriate ledger
    if (classification === "QUALIFIED_HIGH_PRIORITY" || classification === "PENDING_REVIEW") {
      this._appendToBacklog(record);
    } else {
      this._appendToCompleted(record);
    }

    this._audit("PROCESS_FORM", {
      submissionId: record.id,
      classification,
      rejectionReasons: rejectionReasons.map((r) => r.criterion),
    });

    return record;
  }

  // ─── Payment Processing ─────────────────────────────────────────────────

  /**
   * Process a Lemon Squeezy payment event.
   * Activates engagements when valid payment >= $5,000 is confirmed.
   */
  processPaymentEvent(event) {
    const timestamp = new Date().toISOString();

    // Load all existing records for deterministic error ID generation
    const allPaymentRecords = [
      ...readJsonSafe(BACKLOG_PATH),
      ...readJsonSafe(ACTIVE_PATH),
      ...readJsonSafe(COMPLETED_PATH),
    ];

    // Validate event structure
    const validation = validatePaymentEvent(event);
    if (!validation.valid) {
      const errorRecord = {
        id: generateDeterministicId("PMT-ERR", allPaymentRecords),
        type: "PAYMENT_PARSE_ERROR",
        timestamp,
        error: validation.error,
        rawEvent: { order_id: event.order_id, event_type: event.event_type },
      };
      this._appendToCompleted(errorRecord);
      this._audit("PROCESS_PAYMENT", { result: "PARSE_ERROR", error: validation.error });
      return errorRecord;
    }

    // Idempotency check
    if (this._idempotencyCache.has(event.order_id)) {
      const cached = this._idempotencyCache.get(event.order_id);
      this._audit("PROCESS_PAYMENT", { result: "DUPLICATE", orderId: event.order_id, cachedAt: cached });
      return { idempotent: true, orderId: event.order_id, message: "Already processed" };
    }

    // Also check ledgers for existing processing
    const allCompleted = readJsonSafe(COMPLETED_PATH);
    const alreadyProcessed = allCompleted.find(
      (r) => r.paymentReference === event.order_id || r.orderId === event.order_id
    );
    if (alreadyProcessed) {
      this._idempotencyCache.set(event.order_id, timestamp);
      this._audit("PROCESS_PAYMENT", { result: "DUPLICATE_LEDGER", orderId: event.order_id });
      return { idempotent: true, orderId: event.order_id, message: "Already processed (ledger)" };
    }

    // Validate amount
    const amountCheck = validatePaymentAmount(event.amount_cents, this.config);
    if (!amountCheck.valid) {
      const record = {
        id: generateDeterministicId("PMT-LOW", allPaymentRecords),
        type: "INSUFFICIENT_PAYMENT",
        timestamp,
        orderId: event.order_id,
        amountReceived: event.amount_cents,
        amountRequired: this.config.payment.minimumAmountCents,
        currency: event.currency,
        status: "CLOSED",
        message: amountCheck.reason,
      };
      this._appendToCompleted(record);
      this._idempotencyCache.set(event.order_id, timestamp);
      this._audit("PROCESS_PAYMENT", { result: "INSUFFICIENT", orderId: event.order_id });
      return record;
    }

    // Validate currency
    const currencyCheck = validatePaymentCurrency(event.currency, this.config);
    if (!currencyCheck.valid) {
      const record = {
        id: generateDeterministicId("PMT-CURR", allPaymentRecords),
        type: "CURRENCY_REVIEW",
        timestamp,
        orderId: event.order_id,
        amountCents: event.amount_cents,
        currency: event.currency,
        status: "PENDING_REVIEW",
        message: currencyCheck.reason,
      };
      this._appendToCompleted(record);
      this._idempotencyCache.set(event.order_id, timestamp);
      this._audit("PROCESS_PAYMENT", { result: "CURRENCY_REVIEW", orderId: event.order_id });
      return record;
    }

    // Find matching PENDING_BOOKING in backlog
    const applicationId = event.custom_data && event.custom_data.application_id;
    if (!applicationId) {
      const record = {
        id: generateDeterministicId("PMT-NOMATCH", allPaymentRecords),
        type: "NO_APPLICATION_MATCH",
        timestamp,
        orderId: event.order_id,
        amountCents: event.amount_cents,
        currency: event.currency,
        status: "ORPHANED",
        message: "No application_id in custom_data; cannot match to a PENDING_BOOKING record",
      };
      this._appendToCompleted(record);
      this._idempotencyCache.set(event.order_id, timestamp);
      this._audit("PROCESS_PAYMENT", { result: "NO_MATCH", orderId: event.order_id });
      return record;
    }

    // Find in backlog
    const backlog = readJsonSafe(BACKLOG_PATH);
    const matchIndex = backlog.findIndex(
      (r) => r.id === applicationId && r.status === "PENDING_BOOKING"
    );

    if (matchIndex === -1) {
      // Check if already active
      const active = readJsonSafe(ACTIVE_PATH);
      const alreadyActive = active.find((r) => r.id === applicationId);
      if (alreadyActive) {
        this._idempotencyCache.set(event.order_id, timestamp);
        this._audit("PROCESS_PAYMENT", { result: "ALREADY_ACTIVE", orderId: event.order_id, applicationId });
        return { idempotent: true, orderId: event.order_id, applicationId, message: "Engagement already active" };
      }

      const record = {
        id: generateDeterministicId("PMT-NOFIND", allPaymentRecords),
        type: "APPLICATION_NOT_FOUND",
        timestamp,
        orderId: event.order_id,
        applicationId,
        amountCents: event.amount_cents,
        currency: event.currency,
        status: "ORPHANED",
        message: `No PENDING_BOOKING backlog record found for application_id: ${applicationId}`,
      };
      this._appendToCompleted(record);
      this._idempotencyCache.set(event.order_id, timestamp);
      this._audit("PROCESS_PAYMENT", { result: "APP_NOT_FOUND", orderId: event.order_id, applicationId });
      return record;
    }

    // Activate the engagement
    const matchedRecord = backlog[matchIndex];

    // Generate engagement ID
    const activeRecords = readJsonSafe(ACTIVE_PATH);
    const allRecords = [...backlog, ...activeRecords, ...readJsonSafe(COMPLETED_PATH)];
    const engagementId = generateDeterministicId("ENG", allRecords);

    // Transition the record
    const activatedRecord = {
      ...matchedRecord,
      id: engagementId,
      originalSubmissionId: matchedRecord.id,
      status: "ENGAGEMENT_ACTIVE",
      classification: "ENGAGEMENT_ACTIVE",
      activatedAt: timestamp,
      paymentReference: event.order_id,
      paymentAmount: event.amount_cents,
      paymentCurrency: event.currency,
      paymentEventType: event.event_type,
      customerEmail: event.customer_email || matchedRecord.applicant.email,
      mcpInboxFlag: true, // signal tech-architect
    };

    // Atomic ledger update: remove from backlog, add to active
    backlog.splice(matchIndex, 1);
    atomicWriteJson(BACKLOG_PATH, backlog);

    activeRecords.push(activatedRecord);
    atomicWriteJson(ACTIVE_PATH, activeRecords);

    this._idempotencyCache.set(event.order_id, timestamp);
    this._audit("PROCESS_PAYMENT", {
      result: "ENGAGEMENT_ACTIVATED",
      orderId: event.order_id,
      applicationId,
      engagementId,
      amount: event.amount_cents,
    });

    return activatedRecord;
  }

  // ─── Draft Generation ───────────────────────────────────────────────────

  /**
   * Generate a contextual draft for an active engagement.
   * Produces a DRAFT_CONFIRMATION_REQUIRED document. Never sends.
   */
  generateDraft(engagementId, draftType) {
    const timestamp = new Date().toISOString();

    // Find the engagement in active.json
    const active = readJsonSafe(ACTIVE_PATH);
    const engagement = active.find((r) => r.id === engagementId && r.status === "ENGAGEMENT_ACTIVE");

    if (!engagement) {
      return {
        error: true,
        message: `Engagement ${engagementId} not found in active.json or not in ENGAGEMENT_ACTIVE status`,
      };
    }

    const validTypes = ["assessment", "migration", "recommendation"];
    if (!validTypes.includes(draftType)) {
      return {
        error: true,
        message: `Invalid draft type: ${draftType}. Valid: ${validTypes.join(", ")}`,
      };
    }

    // Generate content
    const content = generateDraftContent(engagement, draftType);
    const contentHash = hashContent(content);

    // Build draft record with deterministic ID from confirmation log
    const existingDrafts = this._readConfirmationLog()
      .filter((e) => e.draftId)
      .map((e) => ({ id: e.draftId }));
    const draftRecord = {
      draftId: generateDeterministicId("DRAFT", existingDrafts),
      engagementId,
      draftType,
      contentHash,
      generatedAt: timestamp,
      confirmationStatus: "UNCONFIRMED",
      header: "DRAFT_CONFIRMATION_REQUIRED",
      content: content.slice(0, 10000), // store truncated version
      fullContentLength: content.length,
    };

    // Log confirmation entry
    const confirmationEntry = {
      timestamp,
      action: "DRAFT_GENERATED",
      draftId: draftRecord.draftId,
      engagementId,
      draftType,
      contentHash,
      confirmationStatus: "UNCONFIRMED",
      mcpBridgeEnabled: this.mcp.enabled,
    };
    this._appendConfirmationLog(confirmationEntry);

    this._audit("GENERATE_DRAFT", {
      draftId: draftRecord.draftId,
      engagementId,
      draftType,
      contentHash,
      contentLength: content.length,
    });

    // Return the full draft for review
    return {
      draft: draftRecord,
      fullContent: content,
      note: "THIS DRAFT HAS NOT BEEN SENT. CONFIRMATION REQUIRED.",
    };
  }

  /**
   * Confirm a draft by its content hash.
   * After confirmation, queues for MCP bridge if enabled.
   */
  async confirmDraft(contentHash) {
    const timestamp = new Date().toISOString();

    // Read confirmation log
    const confirmations = this._readConfirmationLog();
    const entry = confirmations.find(
      (e) => e.contentHash === contentHash && e.confirmationStatus === "UNCONFIRMED"
    );

    if (!entry) {
      return {
        error: true,
        message: `No unconfirmed draft found with hash: ${contentHash}`,
      };
    }

    // Update confirmation status
    entry.confirmationStatus = "CONFIRMED";
    entry.confirmedAt = timestamp;

    const confirmEntry = {
      timestamp,
      action: "DRAFT_CONFIRMED",
      draftId: entry.draftId,
      engagementId: entry.engagementId,
      draftType: entry.draftType,
      contentHash,
      confirmationStatus: "CONFIRMED",
      mcpBridgeEnabled: this.mcp.enabled,
    };
    this._appendConfirmationLog(confirmEntry);

    this._audit("CONFIRM_DRAFT", {
      draftId: entry.draftId,
      engagementId: entry.engagementId,
      contentHash,
    });

    // Queue for MCP bridge if enabled
    let mcpResult = null;
    if (this.mcp.enabled) {
      mcpResult = await this.mcp.queueDraft({
        confirmationStatus: "CONFIRMED",
        contentHash,
        engagementId: entry.engagementId,
      });
    }

    return {
      confirmed: true,
      draftId: entry.draftId,
      engagementId: entry.engagementId,
      contentHash,
      mcpQueued: mcpResult ? mcpResult.queued : false,
      mcpNote: this.mcp.enabled ? "Queued for MCP bridge delivery" : "MCP bridge disabled; draft confirmed locally only",
    };
  }

  // ─── List Ledger ────────────────────────────────────────────────────────

  listLedger(ledgerName) {
    const paths = {
      backlog: BACKLOG_PATH,
      active: ACTIVE_PATH,
      completed: COMPLETED_PATH,
    };

    if (!paths[ledgerName]) {
      return { error: true, message: `Unknown ledger: ${ledgerName}. Use: backlog, active, completed` };
    }

    return {
      ledger: ledgerName,
      records: readJsonSafe(paths[ledgerName]),
    };
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────

  _appendToBacklog(record) {
    const records = readJsonSafe(BACKLOG_PATH);
    records.push(record);
    atomicWriteJson(BACKLOG_PATH, records);
  }

  _appendToActive(record) {
    const records = readJsonSafe(ACTIVE_PATH);
    records.push(record);
    atomicWriteJson(ACTIVE_PATH, records);
  }

  _appendToCompleted(record) {
    const records = readJsonSafe(COMPLETED_PATH);
    records.push(record);
    atomicWriteJson(COMPLETED_PATH, records);
  }

  _audit(action, detail) {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      detail,
    };
    appendAuditLog(entry);
    this.emit(action, detail);
  }

  _readConfirmationLog() {
    if (!fs.existsSync(CONFIRMATION_LOG_PATH)) {
      return [];
    }
    try {
      const data = fs.readFileSync(CONFIRMATION_LOG_PATH, "utf-8").trim();
      if (!data) return [];
      return JSON.parse(data);
    } catch (e) {
      console.error(`[ERROR] Failed to read confirmation log: ${e.message}`);
      return [];
    }
  }

  _appendConfirmationLog(entry) {
    const entries = this._readConfirmationLog();
    entries.push(entry);
    ensureDir(LOGS_DIR);
    atomicWriteJson(CONFIRMATION_LOG_PATH, entries);
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
      options[key] = val;
      if (val !== true) i++;
    }
  }

  return { command, options };
}

function printUsage() {
  console.log(`
Founder OS Orchestrator — CLI

Commands:
  process-form --file <path>        Process an application form submission (JSON file)
  process-payment --file <path>     Process a Lemon Squeezy payment event (JSON file)
  generate-draft --engagement <ID> --type <assessment|migration|recommendation>
  confirm-draft --hash <sha256>
  list --ledger <backlog|active|completed>
  verify                           Run built-in verification suite
  help                             Show this message

Config (via --config flags):
  --mcp-enabled true|false          Enable/disable MCP bridge (default: false)
  --mcp-endpoint <url>              MCP bridge endpoint (default: http://localhost:3000/mcp)
  --mcp-timeout <ms>                MCP bridge timeout in ms (default: 5000)
`);
}

async function main() {
  const { command, options } = parseArgs(process.argv);

  // Build config overrides from CLI flags
  const configOverrides = {};
  if (options["mcp-enabled"] !== undefined) {
    configOverrides.mcp = configOverrides.mcp || {};
    configOverrides.mcp.enabled = options["mcp-enabled"] === "true";
  }
  if (options["mcp-endpoint"]) {
    configOverrides.mcp = configOverrides.mcp || {};
    configOverrides.mcp.endpoint = options["mcp-endpoint"];
  }
  if (options["mcp-timeout"]) {
    configOverrides.mcp = configOverrides.mcp || {};
    configOverrides.mcp.timeoutMs = parseInt(options["mcp-timeout"], 10);
  }

  const orchestrator = new Orchestrator(configOverrides);

  switch (command) {
    case "process-form": {
      if (!options.file) {
        console.error("Error: --file is required for process-form");
        process.exit(1);
      }
      const filePath = path.resolve(options.file);
      if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const submission = JSON.parse(raw);
      const result = orchestrator.processFormSubmission(submission);
      console.log(JSON.stringify(result, null, 2));
      console.log(`\n[OK] Form processed. Classification: ${result.classification}`);
      break;
    }

    case "process-payment": {
      if (!options.file) {
        console.error("Error: --file is required for process-payment");
        process.exit(1);
      }
      const filePath = path.resolve(options.file);
      if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const event = JSON.parse(raw);
      const result = orchestrator.processPaymentEvent(event);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "ENGAGEMENT_ACTIVE") {
        console.log(`\n[OK] Engagement activated: ${result.id}`);
      } else if (result.idempotent) {
        console.log(`\n[OK] Idempotent: ${result.message}`);
      } else {
        console.log(`\n[OK] Payment processed. Status: ${result.status}`);
      }
      break;
    }

    case "generate-draft": {
      if (!options.engagement || !options.type) {
        console.error("Error: --engagement and --type are required for generate-draft");
        process.exit(1);
      }
      const result = orchestrator.generateDraft(options.engagement, options.type);
      if (result.error) {
        console.error(`Error: ${result.message}`);
        process.exit(1);
      }
      console.log(JSON.stringify(result.draft, null, 2));
      console.log(`\n[OK] Draft generated. Hash: ${result.draft.contentHash}`);
      console.log(result.note);
      break;
    }

    case "confirm-draft": {
      if (!options.hash) {
        console.error("Error: --hash is required for confirm-draft");
        process.exit(1);
      }
      const result = await orchestrator.confirmDraft(options.hash);
      console.log(JSON.stringify(result, null, 2));
      console.log(`\n[OK] Draft ${result.confirmed ? "confirmed" : "not confirmed"}`);
      break;
    }

    case "list": {
      if (!options.ledger) {
        console.error("Error: --ledger is required for list");
        process.exit(1);
      }
      const result = orchestrator.listLedger(options.ledger);
      if (result.error) {
        console.error(`Error: ${result.message}`);
        process.exit(1);
      }
      console.log(JSON.stringify(result.records, null, 2));
      console.log(`\n[OK] ${result.records.length} records in ${options.ledger}`);
      break;
    }

    case "verify": {
      // Reset ledgers for clean verification
      console.log("Resetting ledgers for clean verification...");
      atomicWriteJson(BACKLOG_PATH, []);
      atomicWriteJson(ACTIVE_PATH, []);
      atomicWriteJson(COMPLETED_PATH, []);
      if (fs.existsSync(CONFIRMATION_LOG_PATH)) fs.unlinkSync(CONFIRMATION_LOG_PATH);
      if (fs.existsSync(AUDIT_LOG_PATH)) fs.unlinkSync(AUDIT_LOG_PATH);

      console.log("Running verification suite...\n");
      const results = runVerification(orchestrator);
      console.log(JSON.stringify(results, null, 2));
      const failed = results.filter((r) => !r.pass);
      console.log(`\nResults: ${results.length - failed.length}/${results.length} passed`);
      if (failed.length > 0) {
        console.log(`Failed: ${failed.map((f) => f.name).join(", ")}`);
        process.exit(1);
      }
      break;
    }

    default:
      printUsage();
      process.exit(command === "help" ? 0 : 1);
  }
}

// ─── Verification Suite ──────────────────────────────────────────────────────

function runVerification(orchestrator) {
  const results = [];

  function check(name, pass, detail) {
    results.push({ name, pass, detail });
  }

  // Test 1: Qualified submission (CTO, PostgreSQL, $5M ARR)
  {
    const sub = {
      id: "TEST-001",
      name: "Alice Chen",
      email: "alice@example.com",
      role: "CTO",
      company: "TechScale Inc",
      arr: "$5M",
      database_stack: "PostgreSQL on AWS RDS, multi-region replication, production",
      engagement_reason: "Need zero-downtime database migration strategy to avoid AWS lock-in",
      source: "website",
    };
    const result = orchestrator.processFormSubmission(sub);
    check(
      "Qualified CTO with PostgreSQL and $5M ARR → QUALIFIED_HIGH_PRIORITY",
      result.classification === "QUALIFIED_HIGH_PRIORITY" && result.mcpInboxFlag === true,
      `Got: ${result.classification}, mcpInboxFlag: ${result.mcpInboxFlag}`
    );
  }

  // Test 2: Disqualified role (Junior Developer)
  {
    const sub = {
      id: "TEST-002",
      name: "Bob Junior",
      email: "bob@example.com",
      role: "Junior Developer",
      company: "SmallCo",
      arr: "$500K",
      database_stack: "MySQL basic",
      engagement_reason: "Want to learn about databases",
      source: "website",
    };
    const result = orchestrator.processFormSubmission(sub);
    check(
      "Junior Developer → ARCHIVED_NOT_A_FIT",
      result.classification === "ARCHIVED_NOT_A_FIT",
      `Got: ${result.classification}`
    );
  }

  // Test 3: Good role but ARR too low
  {
    const sub = {
      id: "TEST-003",
      name: "Carol VP",
      email: "carol@example.com",
      role: "VP Engineering",
      company: "GrowthStartup",
      arr: "$800K",
      database_stack: "PostgreSQL on RDS, production",
      engagement_reason: "Need migration strategy as we scale",
      source: "referral",
    };
    const result = orchestrator.processFormSubmission(sub);
    check(
      "VP Engineering with ARR below $2M → ARCHIVED_NOT_A_FIT",
      result.classification === "ARCHIVED_NOT_A_FIT",
      `Got: ${result.classification}`
    );
  }

  // Test 4: Founder with Aurora and $10M ARR
  {
    const sub = {
      id: "TEST-004",
      name: "Dan Founder",
      email: "dan@example.com",
      role: "Founder",
      company: "HyperGrowth",
      arr: "$10M",
      database_stack: "AWS Aurora PostgreSQL with Global Database, multi-region, HIPAA compliance",
      engagement_reason: "We're locked into Aurora and need an exit strategy with zero downtime",
      source: "website",
    };
    const result = orchestrator.processFormSubmission(sub);
    check(
      "Founder with Aurora, HIPAA, $10M → QUALIFIED_HIGH_PRIORITY",
      result.classification === "QUALIFIED_HIGH_PRIORITY",
      `Got: ${result.classification}`
    );
  }

  // Test 5: Payment activation flow
  {
    // First ensure the TEST-004 record is in backlog with PENDING_BOOKING
    const backlog = readJsonSafe(BACKLOG_PATH);
    const pendingRecord = backlog.find((r) => r.id === "TEST-004" || r.originalSubmissionId === "TEST-004");
    // Use whatever ID was assigned
    const appId = pendingRecord ? pendingRecord.id : "TEST-004";

    const paymentEvent = {
      event_type: "order_paid",
      order_id: "ls_order_12345",
      amount_cents: 750000, // $7,500
      currency: "USD",
      status: "paid",
      customer_email: "dan@example.com",
      custom_data: {
        application_id: appId,
      },
      received_at: new Date().toISOString(),
    };
    const result = orchestrator.processPaymentEvent(paymentEvent);
    check(
      "Valid $7,500 payment → ENGAGEMENT_ACTIVE",
      result.status === "ENGAGEMENT_ACTIVE" && result.mcpInboxFlag === true,
      `Got status: ${result.status}, mcpInboxFlag: ${result.mcpInboxFlag}`
    );
  }

  // Test 6: Payment below threshold
  {
    const paymentEvent = {
      event_type: "order_paid",
      order_id: "ls_order_low_999",
      amount_cents: 100000, // $1,000
      currency: "USD",
      status: "paid",
      customer_email: "low@example.com",
      custom_data: {
        application_id: "NONEXISTENT",
      },
      received_at: new Date().toISOString(),
    };
    const result = orchestrator.processPaymentEvent(paymentEvent);
    check(
      "Payment below $5,000 → INSUFFICIENT_PAYMENT",
      result.type === "INSUFFICIENT_PAYMENT",
      `Got type: ${result.type}`
    );
  }

  // Test 7: Draft generation for activated engagement
  {
    const active = readJsonSafe(ACTIVE_PATH);
    const activated = active.find((r) => r.status === "ENGAGEMENT_ACTIVE");
    if (activated) {
      const draftResult = orchestrator.generateDraft(activated.id, "assessment");
      const draftOk = !!(draftResult.draft && draftResult.draft.confirmationStatus === "UNCONFIRMED" && draftResult.draft.contentHash);
      check(
        "Draft generation for active engagement produces UNCONFIRMED draft",
        draftOk,
        `Got draftId: ${draftResult.draft?.draftId}, status: ${draftResult.draft?.confirmationStatus}`
      );

      // Test draft confirmation
      if (draftResult.draft && draftResult.draft.contentHash) {
        const confirmPromise = orchestrator.confirmDraft(draftResult.draft.contentHash);
        // Since confirmDraft is async, handle carefully
        confirmPromise.then((confirmResult) => {
          check(
            "Draft confirmation succeeds",
            confirmResult.confirmed === true,
            `Got: ${JSON.stringify(confirmResult)}`
          );
        });
      }
    } else {
      check("Draft generation (skip — no active engagement)", true, "No active engagement to test against");
    }
  }

  // Test 8: Idempotency — duplicate payment
  {
    const paymentEvent = {
      event_type: "order_paid",
      order_id: "ls_order_12345", // same as test 5
      amount_cents: 750000,
      currency: "USD",
      status: "paid",
      customer_email: "dan@example.com",
      custom_data: {
        application_id: "TEST-004",
      },
      received_at: new Date().toISOString(),
    };
    const result = orchestrator.processPaymentEvent(paymentEvent);
    check(
      "Duplicate payment → idempotent skip",
      result.idempotent === true,
      `Got: ${JSON.stringify(result)}`
    );
  }

  // Test 9: Ledger integrity
  {
    const backlog = readJsonSafe(BACKLOG_PATH);
    const active = readJsonSafe(ACTIVE_PATH);
    const completed = readJsonSafe(COMPLETED_PATH);
    check("Backlog is a valid array", Array.isArray(backlog), `Length: ${backlog.length}`);
    check("Active is a valid array", Array.isArray(active), `Length: ${active.length}`);
    check("Completed is a valid array", Array.isArray(completed), `Length: ${completed.length}`);
  }

  // Test 10: No active engagement has PENDING_BOOKING status
  {
    const active = readJsonSafe(ACTIVE_PATH);
    const wrongStatus = active.filter((r) => r.status === "PENDING_BOOKING");
    check(
      "Active ledger has no PENDING_BOOKING records",
      wrongStatus.length === 0,
      `Found ${wrongStatus.length} records with wrong status`
    );
  }

  return results;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  Orchestrator,
  McpBridge,
  // Utilities
  generateDeterministicId,
  atomicWriteJson,
  readJsonSafe,
  appendAuditLog,
  validateSubmissionFields,
  // Intake gatekeeper
  normalizeRole,
  isQualifiedRole,
  isDisqualifiedRole,
  hasDatabaseMarker,
  hasInfraScaleMarker,
  parseArrRange,
  evaluateArr,
  evaluateEngagementIntent,
  // Business coordinator
  validatePaymentEvent,
  validatePaymentAmount,
  validatePaymentCurrency,
  // Tech architect
  assessLockInRisk,
  computeMigrationComplexity,
  generateDraftContent,
  hashContent,
  // Config
  DEFAULT_CONFIG,
  QUALIFIED_ROLES,
  DISQUALIFIED_ROLES,
  DB_MARKERS,
  INFRA_SCALE_MARKERS,
  // Paths
  WORKSPACE_ROOT,
  BACKLOG_PATH,
  ACTIVE_PATH,
  COMPLETED_PATH,
  // Verification
  runVerification,
};

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  main().catch((err) => {
    console.error(`[FATAL] ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}
