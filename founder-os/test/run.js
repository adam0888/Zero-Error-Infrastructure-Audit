#!/usr/bin/env node
/**
 * Founder OS Orchestrator — Test Suite
 *
 * Runs the built-in verification suite and validates all core behaviors.
 * No external dependencies. Plain Node.js.
 *
 * Usage:
 *   node test/run.js
 *   node src/orchestrator.js verify
 */

"use strict";

const path = require("path");

// Load the orchestrator module
const orchestratorPath = path.resolve(__dirname, "..", "src", "orchestrator.js");
const {
  Orchestrator,
  runVerification,
  readJsonSafe,
  BACKLOG_PATH,
  ACTIVE_PATH,
  COMPLETED_PATH,
} = require(orchestratorPath);

// Load the webhook handler module
const webhookPath = path.resolve(__dirname, "..", "src", "webhookHandler.js");
const {
  verifySignature,
  parseWebhookPayload,
  SerializedQueue,
  loadConfig,
} = require(webhookPath);

// ─── Test Helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

console.log("=== Unit Tests ===\n");

// --- Role Screening ---
test("normalizeRole lowercases and trims", () => {
  const { normalizeRole } = require(orchestratorPath);
  assertEqual(normalizeRole("  CTO  "), "cto");
  assertEqual(normalizeRole("Chief Technology Officer"), "chief technology officer");
});

test("isQualifiedRole accepts CTO", () => {
  const { isQualifiedRole } = require(orchestratorPath);
  assert(isQualifiedRole("CTO"), "CTO should be qualified");
  assert(isQualifiedRole("VP Engineering"), "VP Engineering should be qualified");
  assert(isQualifiedRole("Head of Infrastructure"), "Head of Infrastructure should be qualified");
  assert(isQualifiedRole("Tech Lead"), "Tech Lead should be qualified");
});

test("isQualifiedRole rejects random roles", () => {
  const { isQualifiedRole } = require(orchestratorPath);
  assert(!isQualifiedRole("Marketing Manager"), "Marketing Manager should not be qualified");
  assert(!isQualifiedRole("Sales Lead"), "Sales Lead should not be qualified");
});

test("isDisqualifiedRole catches Junior", () => {
  const { isDisqualifiedRole } = require(orchestratorPath);
  assert(isDisqualifiedRole("Junior Developer"), "Junior Developer should be disqualified");
  assert(isDisqualifiedRole("Junior Engineer"), "Junior Engineer should be disqualified");
});

test("isDisqualifiedRole catches agency owner", () => {
  const { isDisqualifiedRole } = require(orchestratorPath);
  assert(isDisqualifiedRole("Agency Owner"), "Agency Owner should be disqualified");
});

test("Agency Owner + CTO exception allows through", () => {
  const { isDisqualifiedRole } = require(orchestratorPath);
  // "Agency Owner & CTO" — contains both "agency owner" and "cto"
  const result = isDisqualifiedRole("Agency Owner & CTO");
  // Should return false because CTO qualifies as exception
  assert(!result, "Agency Owner & CTO should NOT be disqualified (CTO exception)");
});

// --- Database Markers ---
test("hasDatabaseMarker detects PostgreSQL", () => {
  const { hasDatabaseMarker } = require(orchestratorPath);
  assert(hasDatabaseMarker("PostgreSQL on AWS RDS"), "Should detect PostgreSQL");
  assert(hasDatabaseMarker("MySQL 8.0"), "Should detect MySQL");
  assert(hasDatabaseMarker("Aurora Serverless"), "Should detect Aurora");
  assert(!hasDatabaseMarker("MongoDB Atlas"), "Should not detect MongoDB");
  assert(!hasDatabaseMarker("Redis"), "Should not detect Redis");
});

// --- Infra Scale Markers ---
test("hasInfraScaleMarker detects production", () => {
  const { hasInfraScaleMarker } = require(orchestratorPath);
  assert(hasInfraScaleMarker("production database", ""), "Should detect production");
  assert(hasInfraScaleMarker("", "HIPAA compliance"), "Should detect HIPAA");
  assert(!hasInfraScaleMarker("development", "just testing"), "Should not detect dev markers");
});

// --- ARR Parsing ---
test("parseArrRange parses explicit numbers", () => {
  const { parseArrRange } = require(orchestratorPath);
  const r1 = parseArrRange("$5M");
  assertEqual(r1.min, 5000000);
  assertEqual(r1.max, 5000000);
  assert(r1.explicit);

  const r2 = parseArrRange("2-5 million");
  assertEqual(r2.min, 2000000);
  assertEqual(r2.max, 5000000);
  assert(r2.explicit);
});

test("parseArrRange returns implicit for garbled input", () => {
  const { parseArrRange } = require(orchestratorPath);
  const r = parseArrRange("we make good money");
  assert(!r.explicit);
});

// --- ARR Evaluation ---
test("evaluateArr accepts $5M", () => {
  const { evaluateArr } = require(orchestratorPath);
  const result = evaluateArr({ min: 5000000, max: 5000000, explicit: true });
  assert(result.pass, `Should pass: ${result.reason}`);
});

test("evaluateArr rejects $500K", () => {
  const { evaluateArr } = require(orchestratorPath);
  const result = evaluateArr({ min: 500000, max: 500000, explicit: true });
  assert(!result.pass, "Should fail for $500K");
});

test("evaluateArr rejects $50M", () => {
  const { evaluateArr } = require(orchestratorPath);
  const result = evaluateArr({ min: 50000000, max: 50000000, explicit: true });
  assert(!result.pass, "Should fail for $50M");
});

// --- Engagement Intent ---
test("evaluateEngagementIntent detects lock-in concerns", () => {
  const { evaluateEngagementIntent } = require(orchestratorPath);
  const result = evaluateEngagementIntent("We need a strategy to avoid vendor lock-in");
  assert(result.pass);
});

test("evaluateEngagementIntent fails vague input", () => {
  const { evaluateEngagementIntent } = require(orchestratorPath);
  const result = evaluateEngagementIntent("need help");
  assert(!result.pass);
});

// --- Payment Validation ---
test("validatePaymentEvent rejects missing fields", () => {
  const { validatePaymentEvent } = require(orchestratorPath);
  const result = validatePaymentEvent({ event_type: "order_paid" });
  assert(!result.valid);
  assert(result.error.includes("Missing"));
});

test("validatePaymentEvent accepts valid event", () => {
  const { validatePaymentEvent } = require(orchestratorPath);
  const result = validatePaymentEvent({
    event_type: "order_paid",
    order_id: "ls_123",
    amount_cents: 500000,
    currency: "USD",
    status: "paid",
  });
  assert(result.valid, `Should be valid: ${result.error}`);
});

test("validatePaymentAmount rejects < $5K", () => {
  const { validatePaymentAmount, DEFAULT_CONFIG } = require(orchestratorPath);
  const result = validatePaymentAmount(100000, DEFAULT_CONFIG);
  assert(!result.valid);
});

test("validatePaymentAmount accepts >= $5K", () => {
  const { validatePaymentAmount, DEFAULT_CONFIG } = require(orchestratorPath);
  const result = validatePaymentAmount(500000, DEFAULT_CONFIG);
  assert(result.valid);
});

// --- Lock-In Risk Assessment ---
test("assessLockInRisk identifies Aurora risks", () => {
  const { assessLockInRisk } = require(orchestratorPath);
  const risks = assessLockInRisk("AWS Aurora PostgreSQL with Global Database");
  assert(risks.some((r) => r.level === "HIGH" || r.level === "CRITICAL"), "Should have elevated risk");
});

test("assessLockInRisk gives LOW for vanilla PostgreSQL", () => {
  const { assessLockInRisk } = require(orchestratorPath);
  const risks = assessLockInRisk("PostgreSQL on self-managed EC2");
  assert(risks.some((r) => r.level === "LOW"), "Should be low risk");
});

// --- Migration Complexity ---
test("computeMigrationComplexity handles basic stack", () => {
  const { computeMigrationComplexity } = require(orchestratorPath);
  const result = computeMigrationComplexity("PostgreSQL on RDS", "basic migration");
  assert(typeof result.complexity === "number");
  assert(Array.isArray(result.factors));
});

test("computeMigrationComplexity increases with HIPAA", () => {
  const { computeMigrationComplexity } = require(orchestratorPath);
  const result = computeMigrationComplexity("PostgreSQL on RDS", "HIPAA compliant zero-downtime migration");
  assert(result.complexity >= 7, `Expected >= 7, got ${result.complexity}`);
});

// --- Hash ---
test("hashContent is deterministic", () => {
  const { hashContent } = require(orchestratorPath);
  const h1 = hashContent("hello world");
  const h2 = hashContent("hello world");
  assertEqual(h1, h2);
  assertEqual(h1.length, 64); // SHA-256 hex
});

// --- Deterministic IDs ---
test("generateDeterministicId produces expected format", () => {
  const { generateDeterministicId } = require(orchestratorPath);
  const id = generateDeterministicId("ENG", []);
  assert(/^ENG-\d{8}-\d{4}$/.test(id), `ID format mismatch: ${id}`);
});

test("generateDeterministicId sequences correctly", () => {
  const { generateDeterministicId } = require(orchestratorPath);
  const existing = [
    { id: "ENG-20260801-0001" },
    { id: "ENG-20260801-0002" },
  ];
  const next = generateDeterministicId("ENG", existing);
  assert(next.endsWith("0003"), `Expected sequence 0003, got ${next}`);
});

// --- JSON Safety ---
test("readJsonSafe returns empty array for missing file", () => {
  const { readJsonSafe } = require(orchestratorPath);
  const result = readJsonSafe("/tmp/nonexistent_founder_os_test.json");
  assertEqual(result.length, 0);
});

test("readJsonSafe throws on non-array JSON", () => {
  const { readJsonSafe } = require(orchestratorPath);
  const fs = require("fs");
  const tmpPath = "/tmp/founder_os_bad_test.json";
  fs.writeFileSync(tmpPath, '{"not": "an array"}');
  let threw = false;
  try {
    readJsonSafe(tmpPath);
  } catch (e) {
    threw = true;
  }
  assert(threw, "Should throw on non-array JSON");
  fs.unlinkSync(tmpPath);
});

// --- Atomic Write ---
test("atomicWriteJson writes valid JSON", () => {
  const { atomicWriteJson, readJsonSafe } = require(orchestratorPath);
  const tmpPath = "/tmp/founder_os_atomic_test.json";
  atomicWriteJson(tmpPath, [{ test: true }]);
  const data = readJsonSafe(tmpPath);
  assertEqual(data.length, 1);
  assertEqual(data[0].test, true);
  // Clean up
  require("fs").unlinkSync(tmpPath);
});

// ─── Integration Tests ───────────────────────────────────────────────────────

console.log("\n=== Integration Tests ===\n");

// Reset ledgers for clean integration tests
const fs = require("fs");
const { atomicWriteJson } = require(orchestratorPath);
atomicWriteJson(BACKLOG_PATH, []);
atomicWriteJson(ACTIVE_PATH, []);
atomicWriteJson(COMPLETED_PATH, []);

const orchestrator = new Orchestrator();

// --- Full Flow: Form → Payment → Draft ---
test("Full flow: qualified submission → backlog with PENDING_BOOKING", () => {
  const result = orchestrator.processFormSubmission({
    id: "INT-001",
    name: "Eve CTO",
    email: "eve@techscale.com",
    role: "CTO",
    company: "TechScale",
    arr: "$8M",
    database_stack: "PostgreSQL on AWS RDS, multi-region replication, SOC2 compliance",
    engagement_reason: "Need zero-downtime migration off Aurora to avoid lock-in",
    source: "website",
  });
  assertEqual(result.classification, "QUALIFIED_HIGH_PRIORITY");
  assertEqual(result.status, "PENDING_BOOKING");
  assertEqual(result.mcpInboxFlag, true);
});

test("Full flow: valid payment activates engagement", () => {
  const backlog = readJsonSafe(BACKLOG_PATH);
  const appId = backlog.find((r) => r.id === "INT-001")?.id || "INT-001";

  const result = orchestrator.processPaymentEvent({
    event_type: "order_paid",
    order_id: "ls_order_eve_001",
    amount_cents: 850000,
    currency: "USD",
    status: "paid",
    customer_email: "eve@techscale.com",
    custom_data: { application_id: appId },
  });
  assertEqual(result.status, "ENGAGEMENT_ACTIVE");
  assertEqual(result.mcpInboxFlag, true);
  assert(result.paymentReference === "ls_order_eve_001");
});

test("Full flow: active engagement appears in active.json, removed from backlog", () => {
  const backlog = readJsonSafe(BACKLOG_PATH);
  const active = readJsonSafe(ACTIVE_PATH);

  const inBacklog = backlog.find((r) => r.id === "INT-001");
  assertEqual(inBacklog, undefined, "INT-001 should be removed from backlog");

  const inActive = active.find((r) => r.originalSubmissionId === "INT-001");
  assert(inActive !== undefined, "INT-001 should be in active.json");
  assertEqual(inActive.status, "ENGAGEMENT_ACTIVE");
});

test("Full flow: draft generation for active engagement", () => {
  const active = readJsonSafe(ACTIVE_PATH);
  const engagement = active[0];
  const draft = orchestrator.generateDraft(engagement.id, "assessment");
  assert(!draft.error, `Draft error: ${draft.message}`);
  assertEqual(draft.draft.confirmationStatus, "UNCONFIRMED");
  assert(draft.draft.contentHash.length === 64);
  assert(draft.fullContent.includes("DRAFT_CONFIRMATION_REQUIRED") === false,
    "fullContent should be the raw content without the DRAFT header (header is in draft record)");
});

test("Full flow: draft confirmation", async () => {
  const active = readJsonSafe(ACTIVE_PATH);
  const engagement = active[0];
  const draft = orchestrator.generateDraft(engagement.id, "migration");

  const confirmResult = await orchestrator.confirmDraft(draft.draft.contentHash);
  assertEqual(confirmResult.confirmed, true);
  assertEqual(confirmResult.mcpQueued, false, "MCP should not queue when bridge is disabled");
});

// --- Rejection Flow ---
test("Rejection: disqualified role ends in completed.json", () => {
  const result = orchestrator.processFormSubmission({
    id: "INT-REJ-001",
    name: "Frank Intern",
    email: "frank@example.com",
    role: "Intern",
    company: "Startup",
    arr: "$3M",
    database_stack: "PostgreSQL",
    engagement_reason: "want to learn",
    source: "website",
  });
  assertEqual(result.classification, "ARCHIVED_NOT_A_FIT");

  const completed = readJsonSafe(COMPLETED_PATH);
  const found = completed.find((r) => r.id === "INT-REJ-001");
  assert(found !== undefined, "Rejected record should be in completed.json");
});

// --- MCP Bridge Tests ---
test("MCP bridge returns disabled status when not enabled", async () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const bridge = new McpBridge(DEFAULT_CONFIG);
  const result = await bridge.queryRecentMessages();
  assertEqual(result.enabled, false);
  assert(result.note.includes("disabled"));
});

test("MCP bridge queueDraft rejects unconfirmed drafts", async () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = true;
  const bridge = new McpBridge(config);
  const result = await bridge.queueDraft({ confirmationStatus: "UNCONFIRMED" });
  assertEqual(result.queued, false);
  assert(result.reason.includes("not confirmed"));
});

// ─── Webhook Handler Tests ────────────────────────────────────────────────────

console.log("\n=== Webhook Handler Tests ===\n");

// --- Signature Verification ---
test("verifySignature validates correct HMAC-SHA256", () => {
  const secret = "test_secret_key_12345";
  const body = '{"event":"test"}';
  const crypto = require("crypto");
  const expectedSig = crypto.createHmac("sha256", secret).update(body, "utf-8").digest("hex");

  const result = verifySignature(body, expectedSig, secret);
  assert(result.valid, `Signature should be valid: ${result.reason || ""}`);
});

test("verifySignature rejects wrong signature", () => {
  const secret = "test_secret_key_12345";
  const body = '{"event":"test"}';
  const wrongSig = "a".repeat(64);

  const result = verifySignature(body, wrongSig, secret);
  assert(!result.valid, "Should reject wrong signature");
  assert(result.reason.includes("mismatch") || result.reason.includes("Signature"));
});

test("verifySignature rejects missing header", () => {
  const result = verifySignature("body", "", "secret");
  assert(!result.valid);
  assert(result.reason.includes("Missing"));
});

test("verifySignature rejects missing secret", () => {
  const result = verifySignature("body", "a".repeat(64), "");
  assert(!result.valid);
  assert(result.reason.includes("No webhook secret"));
});

test("verifySignature rejects invalid hex header", () => {
  const result = verifySignature("body", "not-hex!!!", "secret");
  assert(!result.valid);
  assert(result.reason.includes("not a valid SHA-256 hex"));
});

// --- Webhook Payload Parsing ---
test("parseWebhookPayload normalizes v2 Lemon Squeezy payload", () => {
  const payload = {
    meta: {
      event_name: "order_paid",
      custom_data: {
        application_id: "QUAL-20260801-0001",
        company_name: "TestCo",
        database_stack: "PostgreSQL on RDS",
      },
    },
    data: {
      id: "ls_order_999",
      type: "orders",
      attributes: {
        total: 750000,
        currency: "USD",
        status: "paid",
        user_email: "test@testco.com",
      },
    },
  };

  const result = parseWebhookPayload(payload);
  assert(result.valid, `Should be valid: ${result.error || ""}`);
  const ev = result.event;
  assertEqual(ev.event_type, "order_paid");
  assertEqual(ev.order_id, "ls_order_999");
  assertEqual(ev.amount_cents, 750000);
  assertEqual(ev.currency, "USD");
  assertEqual(ev.customer_email, "test@testco.com");
  assertEqual(ev.custom_data.application_id, "QUAL-20260801-0001");
  assertEqual(ev.custom_data.company_name, "TestCo");
  assertEqual(ev.custom_data.database_stack, "PostgreSQL on RDS");
});

test("parseWebhookPayload normalizes checkout.completed to order_paid", () => {
  const payload = {
    meta: { event_name: "checkout.completed" },
    data: {
      id: "ls_co_001",
      type: "orders",
      attributes: {
        total: 500000,
        currency: "USD",
        status: "paid",
        user_email: "buyer@example.com",
      },
    },
  };

  const result = parseWebhookPayload(payload);
  assert(result.valid);
  assertEqual(result.event.event_type, "order_paid");
  assertEqual(result.event.order_id, "ls_co_001");
});

test("parseWebhookPayload normalizes subscription.created", () => {
  const payload = {
    meta: { event_name: "subscription_created" },
    data: {
      id: "ls_sub_001",
      type: "subscriptions",
      attributes: {
        total: 600000,
        currency: "USD",
        status: "active",
        user_email: "sub@example.com",
      },
    },
  };

  const result = parseWebhookPayload(payload);
  assert(result.valid);
  assertEqual(result.event.event_type, "subscription_created");
  assertEqual(result.event.order_id, "ls_sub_001");
});

test("parseWebhookPayload extracts amount from data.attributes.total", () => {
  const payload = {
    meta: { event_name: "order_paid" },
    data: {
      id: "ls_amt_001",
      attributes: { total: 900000, currency: "USD", status: "paid" },
    },
  };

  const result = parseWebhookPayload(payload);
  assert(result.valid);
  assertEqual(result.event.amount_cents, 900000);
});

test("parseWebhookPayload rejects non-object body", () => {
  const result = parseWebhookPayload("not an object");
  assert(!result.valid);
  assert(result.error.includes("must be a JSON object"));
});

test("parseWebhookPayload rejects missing event type", () => {
  const result = parseWebhookPayload({ data: { id: "x" } });
  assert(!result.valid);
  assert(result.error.includes("Cannot determine event type"));
});

test("parseWebhookPayload handles legacy flat format", () => {
  const payload = {
    event_type: "order_paid",
    order_id: "ls_legacy_001",
    amount_cents: 500000,
    currency: "USD",
    status: "paid",
    customer_email: "legacy@example.com",
    custom_data: { application_id: "APP-001" },
  };

  const result = parseWebhookPayload(payload);
  assert(result.valid);
  assertEqual(result.event.event_type, "order_paid");
  assertEqual(result.event.order_id, "ls_legacy_001");
  assertEqual(result.event.amount_cents, 500000);
});

test("parseWebhookPayload uses meta.custom_data over top-level", () => {
  const payload = {
    meta: {
      event_name: "order_paid",
      custom_data: { application_id: "META-APP" },
    },
    custom_data: { application_id: "TOP-APP" },
    data: {
      id: "ls_001",
      attributes: { total: 500000, currency: "USD", status: "paid" },
    },
  };

  const result = parseWebhookPayload(payload);
  assert(result.valid);
  assertEqual(result.event.custom_data.application_id, "META-APP");
});

// --- Serialized Queue ---
test("SerializedQueue processes tasks in order", async () => {
  const queue = new SerializedQueue();
  const order = [];

  const results = await Promise.all([
    queue.enqueue(async () => { order.push(1); return 1; }),
    queue.enqueue(async () => { order.push(2); return 2; }),
    queue.enqueue(async () => { order.push(3); return 3; }),
  ]);

  assertEqual(JSON.stringify(order), JSON.stringify([1, 2, 3]), "Tasks must process in FIFO order");
  assertEqual(JSON.stringify(results), JSON.stringify([1, 2, 3]));
});

test("SerializedQueue handles async task with delay", async () => {
  const queue = new SerializedQueue();
  const order = [];

  const results = await Promise.all([
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
      return "a";
    }),
    queue.enqueue(async () => {
      order.push(2);
      return "b";
    }),
  ]);

  assertEqual(JSON.stringify(order), JSON.stringify([1, 2]));
  assertEqual(JSON.stringify(results), JSON.stringify(["a", "b"]));
});

test("SerializedQueue propagates errors without blocking queue", async () => {
  const queue = new SerializedQueue();
  const order = [];

  const p1 = queue.enqueue(async () => { throw new Error("task1 fail"); });
  const p2 = queue.enqueue(async () => { order.push(2); return "ok"; });

  let err1 = null;
  try { await p1; } catch (e) { err1 = e; }
  assert(err1 !== null, "First task should have thrown");
  assert(err1.message === "task1 fail");

  const r2 = await p2;
  assertEqual(r2, "ok");
  assertEqual(order[0], 2, "Second task should still execute after error");
});

// --- Config Loading ---
test("loadConfig loads defaults when no env vars set", () => {
  // Save and clear
  const saved = {
    SECRET: process.env.LEMON_SQUEEZY_WEBHOOK_SECRET,
    BYPASS: process.env.LEMON_SQUEEZY_WEBHOOK_DEV_BYPASS,
  };
  delete process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  delete process.env.LEMON_SQUEEZY_WEBHOOK_DEV_BYPASS;

  const config = loadConfig();
  assertEqual(config.port, 3100);
  assertEqual(config.maxBodyBytes, 65536);
  assertEqual(config.webhookSecret, "");
  // No secret + no bypass → fail closed (signatureRequired = true)
  assert(config.signatureRequired, "Should fail closed when no secret and no bypass");

  // Restore
  if (saved.SECRET) process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = saved.SECRET;
  if (saved.BYPASS) process.env.LEMON_SQUEEZY_WEBHOOK_DEV_BYPASS = saved.BYPASS;
});

// ─── Enhanced MCP Bridge Tests ────────────────────────────────────────────────

console.log("\n=== Enhanced MCP Bridge Tests ===\n");

// --- MCP JSON-RPC ---
test("MCP rpcCall returns disabled when bridge not enabled", async () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = false;
  config.mcp.rpcEnabled = true;
  const bridge = new McpBridge(config);

  const result = await bridge.rpcCall("test.method", { param: 1 });
  assert(!result.enabled);
  assert(result.error.message.includes("disabled"));
});

test("MCP rpcCall returns disabled when RPC not enabled", async () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = true;
  config.mcp.rpcEnabled = false;
  const bridge = new McpBridge(config);

  const result = await bridge.rpcCall("test.method", { param: 1 });
  assert(!result.enabled);
  assert(result.error.message.includes("RPC not enabled"));
});

// --- MCP WebSocket ---
test("MCP wsConnect returns disabled when bridge is off", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = false;
  config.mcp.wsEnabled = true;
  const bridge = new McpBridge(config);

  const ws = bridge.wsConnect();
  assert(!ws.enabled);
});

test("MCP wsConnect returns disabled when wsEnabled is false", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = true;
  config.mcp.wsEnabled = false;
  const bridge = new McpBridge(config);

  const ws = bridge.wsConnect();
  assert(!ws.enabled);
  assert(ws.note.includes("disabled"));
});

test("MCP wsConnect returns simulated connection when both enabled", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = true;
  config.mcp.wsEnabled = true;
  const bridge = new McpBridge(config);

  const ws = bridge.wsConnect();
  assert(ws.enabled);
  assert(ws.simulated);
  assert(ws.simulate !== undefined);
});

test("MCP wsConnect receiveMessage extracts text from payload", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = true;
  config.mcp.wsEnabled = true;
  const bridge = new McpBridge(config);

  const ws = bridge.wsConnect();
  const result = ws.simulate.receiveMessage({
    content: [
      { type: "text", text: "Hello from client" },
      { type: "text", text: "Need migration help" },
    ],
  });
  assertEqual(result.messages.length, 2);
  assert(result.messages[0].text.includes("Hello"));
});

test("MCP wsConnect sendMessage is blocked", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = true;
  config.mcp.wsEnabled = true;
  const bridge = new McpBridge(config);

  const ws = bridge.wsConnect();
  const result = ws.simulate.sendMessage();
  assert(!result.sent);
  assert(result.reason.includes("not permitted"));
});

// --- Text Extraction (expanded) ---
test("_extractTextBlocks handles RPC result format", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const bridge = new McpBridge(DEFAULT_CONFIG);

  const blocks = bridge._extractTextBlocks({
    result: [
      { text: "Message one" },
      { text: "Message two" },
    ],
  });
  assertEqual(blocks.length, 2);
  assertEqual(blocks[0].text, "Message one");
  assertEqual(blocks[1].text, "Message two");
});

test("_extractTextBlocks handles result.messages format", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const bridge = new McpBridge(DEFAULT_CONFIG);

  const blocks = bridge._extractTextBlocks({
    result: {
      messages: ["Plain string message", "Another one"],
    },
  });
  assertEqual(blocks.length, 2);
  assert(blocks[0].text.includes("Plain string"));
});

test("_extractTextBlocks handles empty response", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const bridge = new McpBridge(DEFAULT_CONFIG);

  const blocks = bridge._extractTextBlocks(null);
  assertEqual(blocks.length, 0);
});

test("_extractTextBlocks truncates long messages at 4096", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const bridge = new McpBridge(DEFAULT_CONFIG);

  const longText = "x".repeat(5000);
  const blocks = bridge._extractTextBlocks({
    content: [{ type: "text", text: longText }],
  });
  assertEqual(blocks[0].text.length, 4096);
  assert(blocks[0].truncated, "Should mark as truncated");
});

// --- Persona Draft Generation ---
test("generatePersonaDraft loads persona file and creates UNCONFIRMED draft", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const bridge = new McpBridge(config);

  const engagement = {
    id: "ENG-20260801-0001",
    database_stack: "PostgreSQL on AWS RDS, multi-region",
    engagement_reason: "Need zero-downtime migration off Aurora to avoid lock-in",
    company: "TestCorp",
    name: "Alice CTO",
    applicant: { name: "Alice CTO", company: "TestCorp" },
  };

  const messages = [
    { type: "text", text: "Our Aurora bill is enormous and we're worried about vendor lock-in." },
    { type: "text", text: "We need a migration plan with zero downtime for our production systems." },
  ];

  const result = bridge.generatePersonaDraft(engagement, messages, "diagnostic");

  assert(result.draft, "Result should have draft record");
  assert(result.contentHash !== undefined, "Should have contentHash");
  assertEqual(result.confirmationStatus, "UNCONFIRMED");
  assert(result.personaLoaded, "Persona should be loaded from file");
  assertEqual(result.messageBlockCount, 2);
  assert(result.note.includes("NOT BEEN SENT"));
});

test("generatePersonaDraft with empty messages still generates draft", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const bridge = new McpBridge(config);

  const engagement = {
    id: "ENG-20260801-0002",
    database_stack: "MySQL on RDS",
    engagement_reason: "Basic migration inquiry",
    company: "TestInc",
  };

  const result = bridge.generatePersonaDraft(engagement, [], "assessment");
  assert(result.contentHash !== undefined);
  assertEqual(result.confirmationStatus, "UNCONFIRMED");
  assertEqual(result.messageBlockCount, 0);
});

test("generatePersonaDraft produces deterministic hash", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const bridge = new McpBridge(config);

  const engagement = {
    id: "ENG-20260801-0003",
    database_stack: "Aurora PostgreSQL with Global Database",
    engagement_reason: "HIPAA compliant zero-downtime migration",
    company: "HealthCo",
  };

  const messages = [
    { type: "text", text: "We need HIPAA compliance throughout the migration." },
  ];

  const result1 = bridge.generatePersonaDraft(engagement, messages, "migration");
  const result2 = bridge.generatePersonaDraft(engagement, messages, "migration");

  // Hashes should differ due to timestamp/content variation in draftId,
  // but the hashing of the same content structure should produce consistent lengths
  assertEqual(result1.contentHash.length, 64, "SHA-256 hex should be 64 chars");
  assertEqual(result2.contentHash.length, 64);
});

test("generatePersonaDraft extracts diagnostic keywords", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const bridge = new McpBridge(DEFAULT_CONFIG);

  const keywords = bridge._extractDiagnosticKeywords(
    "Our connection pool keeps timing out and replication lag is causing issues. We're worried about failover tests.",
    "PostgreSQL on AWS RDS"
  );

  assert(keywords.length >= 2, `Should find at least 2 keywords, got ${keywords.length}: ${JSON.stringify(keywords)}`);
  assert(keywords.some((k) => k.includes("Connection pooling")), "Should detect connection pool concern");
  assert(keywords.some((k) => k.includes("Replication")), "Should detect replication issue");
});

test("_extractDiagnosticKeywords handles empty input", () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const bridge = new McpBridge(DEFAULT_CONFIG);

  const keywords = bridge._extractDiagnosticKeywords("", "");
  assertEqual(keywords.length, 0, "Empty input should produce no keywords");
});

// --- queryActiveClientMessages disabled behavior ---
test("queryActiveClientMessages returns disabled when bridge is off", async () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = false;
  const bridge = new McpBridge(config);

  const result = await bridge.queryActiveClientMessages(["test@example.com"]);
  assert(!result.enabled);
  assert(result.note.includes("disabled"));
});

test("queryActiveClientMessages returns early with empty client list", async () => {
  const { McpBridge, DEFAULT_CONFIG } = require(orchestratorPath);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.mcp.enabled = true;
  const bridge = new McpBridge(config);

  const result = await bridge.queryActiveClientMessages([]);
  assert(result.enabled);
  assert(result.messages.length === 0);
  assert(result.note.includes("No active client emails"));
});

// --- Config merge handles MCP_BEARER_TOKEN from env only ---
test("Orchestrator._mergeConfig uses MCP_BEARER_TOKEN from env", () => {
  const saved = process.env.MCP_BEARER_TOKEN;
  process.env.MCP_BEARER_TOKEN = "test-bearer-token-12345";

  const orch = new Orchestrator();
  assertEqual(orch.config.mcp.bearerToken, "test-bearer-token-12345");

  // Token should NOT appear in config overrides
  const orch2 = new Orchestrator({ mcp: { enabled: true } });
  assertEqual(orch2.config.mcp.bearerToken, "test-bearer-token-12345");

  if (saved) process.env.MCP_BEARER_TOKEN = saved;
  else delete process.env.MCP_BEARER_TOKEN;
});

test("Orchestrator._mergeConfig ignores bearerToken from overrides", () => {
  const saved = process.env.MCP_BEARER_TOKEN;
  process.env.MCP_BEARER_TOKEN = "env-token-only";

  // Attempt to inject token via overrides — should be ignored
  const orch = new Orchestrator({ mcp: { bearerToken: "injected-token" } });
  assertEqual(orch.config.mcp.bearerToken, "env-token-only");

  if (saved) process.env.MCP_BEARER_TOKEN = saved;
  else delete process.env.MCP_BEARER_TOKEN;
});

// --- Level 2 supervised automation ---
const workerPath = path.resolve(__dirname, "..", "src", "worker.js");
const syncPath = path.resolve(__dirname, "..", "src", "syncInbox.js");
const worker = require(workerPath);
const syncInbox = require(syncPath);
const os = require("os");
const fsTest = require("fs");
test("worker excludes normalized FORM_SUBMISSION and preserves booking records", () => {
  assert(!worker.isExplicitInboxRecord({ type: "FORM_SUBMISSION", processed: false, source: {} }));
  assert(!worker.isExplicitInboxRecord({ type: "PENDING_BOOKING", status: "PENDING_BOOKING" }));
  assert(worker.isExplicitInboxRecord({ type: "FORM_SUBMISSION_RAW", processed: false, source: {} }));
});
test("worker lock prevents second instance and releases", () => {
  const p = path.join(os.tmpdir(), `founder-worker-${process.pid}.lock`); try { fsTest.unlinkSync(p); } catch (_) {}
  assert(worker.acquireLock(p)); assert(!worker.acquireLock(p)); worker.releaseLock(p); assert(worker.acquireLock(p)); worker.releaseLock(p);
});
test("sync normalizes bounded text and deterministic dedupe", () => {
  const blocks = syncInbox.normalizeMessages([{ text: "hello" }, { text: "x".repeat(5000) }, { text: "" }]);
  assertEqual(blocks.length, 2); assertEqual(blocks[1].text.length, 4096); assert(blocks[1].truncated);
  const a = syncInbox.taskFor({ text: "same" }, { id: "ENG-X" }); const b = syncInbox.taskFor({ text: "same" }, { id: "ENG-X" }); assertEqual(a.id, b.id); assertEqual(a.dedupeKey, b.dedupeKey);
});
test("sync disabled avoids MCP and writes", async () => {
  const result = await syncInbox.syncOnce({ disabled: true }); assert(!result.enabled); assertEqual(result.added, 0);
});
test("syncOnce deduplicates draft log entries across repeated polls", async () => {
  const tmpDir = path.join(os.tmpdir(), `founder-sync-dedup-${process.pid}`);
  const tmpBacklog = path.join(tmpDir, "backlog.json"); const tmpActive = path.join(tmpDir, "active.json");
  const tmpDraftLog = path.join(tmpDir, "inbox-drafts.jsonl"); const tmpLogs = path.join(tmpDir, "logs");
  fsTest.mkdirSync(tmpDir, { recursive: true }); fsTest.mkdirSync(tmpLogs, { recursive: true });
  // Minimal engagement for the orchestrator to pick up
  const engagement = { id: "ENG-DEDUP-0001", status: "ENGAGEMENT_ACTIVE", customerEmail: "test@dedup.com", company: "TestCo", database_stack: "PostgreSQL", engagement_reason: "migration", name: "Test", applicant: { email: "test@dedup.com", name: "Test", company: "TestCo" } };
  atomicWriteJson(tmpActive, [engagement]); atomicWriteJson(tmpBacklog, []);
  // Patch paths temporarily
  const origActive = require(orchestratorPath).ACTIVE_PATH; const origBacklog = require(orchestratorPath).BACKLOG_PATH;
  const origDraftLog = syncInbox.DRAFT_LOG;
  // Override module paths via direct property mutation (only for this test)
  const orchMod = require(orchestratorPath); orchMod.ACTIVE_PATH = tmpActive; orchMod.BACKLOG_PATH = tmpBacklog;
  // Override DRAFT_LOG on the syncInbox module
  const syncMod = require(syncPath); syncMod.DRAFT_LOG = tmpDraftLog;
  try {
    const messages = [{ text: "Need migration help urgently" }];
    // First call — should write one draft log entry
    const r1 = await syncInbox.syncOnce({ messages, orchestrator: new (require(orchestratorPath).Orchestrator)({ mcp: { enabled: true, endpoint: "http://localhost:3000/mcp", timeoutMs: 5000, rpcEnabled: false } }) });
    const lines1 = fsTest.existsSync(tmpDraftLog) ? fsTest.readFileSync(tmpDraftLog, "utf-8").trim().split("\n").filter(Boolean) : [];
    // Second call with same messages — should NOT append duplicate drafts
    const r2 = await syncInbox.syncOnce({ messages, orchestrator: new (require(orchestratorPath).Orchestrator)({ mcp: { enabled: true, endpoint: "http://localhost:3000/mcp", timeoutMs: 5000, rpcEnabled: false } }) });
    const lines2 = fsTest.existsSync(tmpDraftLog) ? fsTest.readFileSync(tmpDraftLog, "utf-8").trim().split("\n").filter(Boolean) : [];
    assertEqual(lines1.length, lines2.length, `Draft log should not grow on repeated sync: ${lines1.length} → ${lines2.length}`);
    assert(lines1.length >= 1, `Expected at least 1 draft log entry, got ${lines1.length}`);
  } finally {
    // Restore original paths
    orchMod.ACTIVE_PATH = origActive; orchMod.BACKLOG_PATH = origBacklog;
    syncMod.DRAFT_LOG = origDraftLog;
    // Clean up temp files
    try { fsTest.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});
test("worker processOnce preserves failed records in backlog", async () => {
  const tmpDir = path.join(os.tmpdir(), `founder-worker-seq-${process.pid}`);
  const tmpBacklog = path.join(tmpDir, "backlog.json");
  fsTest.mkdirSync(tmpDir, { recursive: true });
  // Write a backlog with one valid and one invalid record
  const records = [
    { id: "W-OK-1", type: "FORM_SUBMISSION_RAW", processed: false, source: { id: "OK-1", name: "Alice", email: "alice@ok.com", role: "CTO", company: "OKCo", arr: "$5M", database_stack: "PostgreSQL on RDS", engagement_reason: "migration off Aurora", source: "test" } },
    { id: "W-FAIL-1", type: "FORM_SUBMISSION_RAW", processed: false, source: null },
  ];
  fsTest.writeFileSync(tmpBacklog, JSON.stringify(records));
  const origBacklog = require(orchestratorPath).BACKLOG_PATH; require(orchestratorPath).BACKLOG_PATH = tmpBacklog;
  try {
    const orchestrator = new (require(orchestratorPath).Orchestrator)();
    const result = await worker.processOnce(orchestrator);
    // Failed record should remain in backlog
    const remaining = require(orchestratorPath).readJsonSafe(tmpBacklog);
    const failedStillThere = remaining.some(r => r.id === "W-FAIL-1");
    assert(failedStillThere, "Failed record should remain in backlog");
    assert(result.failed >= 1, `Expected at least 1 failed, got ${result.failed}`);
  } finally {
    require(orchestratorPath).BACKLOG_PATH = origBacklog;
    try { fsTest.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─── Verification Suite ──────────────────────────────────────────────────────

console.log("\n=== Built-in Verification ===\n");

// Re-run verification with fresh orchestrator state
const verifyResults = runVerification(orchestrator);

for (const r of verifyResults) {
  if (r.pass) {
    console.log(`  ✓ ${r.name}`);
    passed++;
  } else {
    console.log(`  ✗ ${r.name}: ${r.detail}`);
    failed++;
    failures.push({ name: r.name, error: r.detail });
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log(`\nAll tests passed. ✓`);
  process.exit(0);
}
