#!/usr/bin/env node
/**
 * Founder OS — Lemon Squeezy Webhook Handler
 * "Zero-Error Infrastructure Lock-In" Consultancy Engine
 *
 * Dependency-free native Node.js HTTP server.
 * Validates POST content type / body size, verifies X-Signature HMAC-SHA256,
 * parses Lemon Squeezy payload variants, normalizes to orchestrator payment
 * events, and processes through Orchestrator.processPaymentEvent.
 *
 * Usage:
 *   node src/webhookHandler.js                # Start server (default port 3100)
 *   node src/webhookHandler.js --port 4000    # Custom port
 *
 * Environment:
 *   LEMON_SQUEEZY_WEBHOOK_SECRET         — HMAC shared secret (fail closed if set)
 *   LEMON_SQUEEZY_WEBHOOK_DEV_BYPASS     — set to "1" to skip signature verification
 *                                         (only works when LEMON_SQUEEZY_WEBHOOK_SECRET
 *                                          is NOT set)
 *   MCP_BEARER_TOKEN                     — Bearer token for MCP bridge auth
 *   LS_WEBHOOK_PORT                      — Port override (default 3100)
 *   LS_WEBHOOK_MAX_BODY_BYTES            — Max body size (default 65536)
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const path = require("path");

const { Orchestrator } = require(path.resolve(__dirname, "orchestrator.js"));

// ─── Configuration ───────────────────────────────────────────────────────────

function loadConfig() {
  const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "";
  const devBypass = process.env.LEMON_SQUEEZY_WEBHOOK_DEV_BYPASS === "1";

  // Fail closed in production: if secret is set, signature MUST validate.
  // Dev bypass only allowed when secret is NOT set (unmistakable dev flag).
  let signatureRequired = false;
  let devBypassActive = false;

  if (secret) {
    signatureRequired = true;
    devBypassActive = false;
  } else if (devBypass) {
    signatureRequired = false;
    devBypassActive = true;
  } else {
    signatureRequired = true; // fail closed
    devBypassActive = false;
  }

  return {
    port: parseInt(process.env.LS_WEBHOOK_PORT || "3100", 10),
    maxBodyBytes: parseInt(process.env.LS_WEBHOOK_MAX_BODY_BYTES || "65536", 10),
    webhookSecret: secret,
    signatureRequired,
    devBypassActive,
    mcpBearerToken: process.env.MCP_BEARER_TOKEN || "",
  };
}

// ─── Signature Verification ──────────────────────────────────────────────────

/**
 * Verify Lemon Squeezy X-Signature header against raw body.
 * Lemon Squeezy signs the raw request body with HMAC-SHA256 using
 * the webhook secret, and places the hex digest in the X-Signature header.
 *
 * @param {string} rawBody - Raw request body as received
 * @param {string} signatureHeader - Value of X-Signature header
 * @param {string} secret - Webhook signing secret
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return { valid: false, reason: "Missing X-Signature header" };
  }

  if (!secret || typeof secret !== "string") {
    return { valid: false, reason: "No webhook secret configured" };
  }

  // Lemon Squeezy signature format: hex digest (no prefix)
  const expectedSig = signatureHeader.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSig)) {
    return { valid: false, reason: "X-Signature header is not a valid SHA-256 hex string" };
  }

  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf-8")
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    if (!crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(expectedSig, "hex"))) {
      return { valid: false, reason: "Signature mismatch" };
    }
  } catch (e) {
    return { valid: false, reason: `Signature comparison error: ${e.message}` };
  }

  return { valid: true };
}

// ─── Payload Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a Lemon Squeezy webhook payload into a normalized payment event.
 *
 * Supports both standard Lemon Squeezy v2 webhook format:
 *   { meta: { event_name: "..." }, data: { attributes: {...} } }
 * And legacy flat format:
 *   { event_type: "...", order_id: "...", ... }
 *
 * @param {object} body - Parsed JSON body of the webhook request
 * @returns {{ valid: boolean, event?: object, error?: string }}
 */
function parseWebhookPayload(body) {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  // Determine event type
  let eventType = body.event_type || "";

  // Lemon Squeezy v2 webhook format
  if (body.meta && body.meta.event_name) {
    eventType = body.meta.event_name;
  }

  // Also check data.attributes for event type hints
  if (!eventType && body.data && body.data.type) {
    const dtype = body.data.type;
    if (dtype === "orders" || dtype === "subscriptions") {
      // Infer from status
      const status = (body.data.attributes && body.data.attributes.status) || "";
      if (status === "paid") {
        eventType = dtype === "subscriptions" ? "subscription_paid" : "order_paid";
      } else {
        eventType = dtype === "subscriptions" ? "subscription_created" : "order_created";
      }
    }
  }

  if (!eventType) {
    return { valid: false, error: "Cannot determine event type from payload" };
  }

  // Map known Lemon Squeezy event names to internal event types
  const eventMap = {
    "order_created": "order_created",
    "order_paid": "order_paid",
    "checkout.completed": "order_paid",
    "order.refunded": "order_refunded",
    "subscription_created": "subscription_created",
    "subscription_paid": "subscription_paid",
    "subscription_payment_success": "subscription_paid",
    "subscription_updated": "subscription_updated",
  };

  const normalizedEventType = eventMap[eventType] || eventType;

  // Extract data from meta.custom_data (v2) or top-level custom_data (legacy)
  let customData = body.custom_data || {};
  if (body.meta && body.meta.custom_data && typeof body.meta.custom_data === "object") {
    customData = body.meta.custom_data;
  }
  // Also check data.attributes for nested custom_data
  if (body.data && body.data.attributes) {
    const attrs = body.data.attributes;
    // Some Lemon Squeezy payloads have custom_data at the order/subscription level
    if (attrs.custom_data && typeof attrs.custom_data === "object") {
      customData = { ...customData, ...attrs.custom_data };
    }
  }

  // Extract amount: try multiple locations
  let amountCents = body.amount_cents || body.amountCents || 0;
  if (body.data && body.data.attributes) {
    const attrs = body.data.attributes;
    if (attrs.total !== undefined) amountCents = attrs.total;
    if (attrs.amount !== undefined) amountCents = attrs.amount;
    if (attrs.first_order_item && attrs.first_order_item.price) {
      amountCents = attrs.first_order_item.price;
    }
  }
  amountCents = parseInt(amountCents, 10) || 0;

  // Extract currency
  let currency = body.currency || "USD";
  if (body.data && body.data.attributes && body.data.attributes.currency) {
    currency = body.data.attributes.currency;
  }

  // Extract order ID
  let orderId = body.order_id || body.orderId || "";
  if (body.data && body.data.id) {
    orderId = String(body.data.id);
  }
  if (body.meta && body.meta.order_id) {
    orderId = String(body.meta.order_id);
  }

  // Extract status
  let status = body.status || "";
  if (body.data && body.data.attributes && body.data.attributes.status) {
    status = body.data.attributes.status;
  }

  // Extract customer email
  let customerEmail = body.customer_email || body.user_email || "";
  if (body.data && body.data.attributes) {
    const attrs = body.data.attributes;
    if (attrs.user_email) customerEmail = attrs.user_email;
    if (attrs.email) customerEmail = attrs.email;
  }
  if (body.meta && body.meta.user_email) {
    customerEmail = body.meta.user_email;
  }

  // Extract company_name, database_stack from custom_data
  const applicationId = customData.application_id || "";
  const companyName = customData.company_name || body.company_name || "";
  const databaseStack = customData.database_stack || "";

  // Normalize to orchestrator payment event
  const event = {
    event_type: normalizedEventType,
    order_id: orderId,
    amount_cents: amountCents,
    currency: currency.toUpperCase() || "USD",
    status: status || "paid",
    customer_email: customerEmail,
    custom_data: {
      application_id: applicationId,
      company_name: companyName,
      database_stack: databaseStack,
    },
    received_at: new Date().toISOString(),
  };

  return { valid: true, event };
}

// ─── Serialized Processing Queue ─────────────────────────────────────────────

/**
 * Promise-based serialized queue for single-thread processing.
 * Ensures webhook events are processed one at a time in order.
 */
class SerializedQueue {
  constructor() {
    this._queue = [];
    this._processing = false;
  }

  /**
   * Enqueue an async task. Returns a promise that resolves with the task's result.
   */
  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ taskFn, resolve, reject });
      this._processNext();
    });
  }

  async _processNext() {
    if (this._processing) return;
    if (this._queue.length === 0) return;

    this._processing = true;

    const { taskFn, resolve, reject } = this._queue.shift();

    try {
      const result = await taskFn();
      resolve(result);
    } catch (e) {
      reject(e);
    }

    this._processing = false;
    this._processNext();
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

/**
 * Create the webhook HTTP server.
 *
 * @param {object} config - Configuration from loadConfig()
 * @param {Orchestrator} orchestrator - Orchestrator instance
 * @returns {http.Server}
 */
function createServer(config, orchestrator) {
  const serialQueue = new SerializedQueue();

  const server = http.createServer(async (req, res) => {
    // Only POST to /webhook is handled
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Validate Content-Type
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unsupported Media Type: expected application/json" }));
      return;
    }

    // Read body with size limit
    let rawBody = "";
    let bodySize = 0;

    req.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > config.maxBodyBytes) {
        req.destroy();
        return;
      }
      rawBody += chunk.toString("utf-8");
    });

    req.on("end", async () => {
      // Check body was fully received
      if (bodySize > config.maxBodyBytes) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }

      if (!rawBody.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty body" }));
        return;
      }

      // Parse JSON
      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON", detail: e.message }));
        return;
      }

      // Verify signature
      if (config.signatureRequired) {
        if (!config.webhookSecret) {
          // Fail closed: no secret configured means reject all
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Webhook secret not configured on server" }));
          return;
        }

        const sigHeader = req.headers["x-signature"] || "";
        const sigResult = verifySignature(rawBody, sigHeader, config.webhookSecret);

        if (!sigResult.valid) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Signature verification failed", detail: sigResult.reason }));
          return;
        }
      }

      // Parse payload into normalized event
      const parseResult = parseWebhookPayload(parsedBody);
      if (!parseResult.valid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: parseResult.error }));
        return;
      }

      // Enqueue for serialized processing
      try {
        const result = await serialQueue.enqueue(() => {
          // Process through orchestrator
          const paymentResult = orchestrator.processPaymentEvent(parseResult.event);

          // Return a safe response (never log secrets or raw payload)
          return {
            processed: true,
            status: paymentResult.status || paymentResult.type || "UNKNOWN",
            order_id: parseResult.event.order_id,
            idempotent: paymentResult.idempotent || false,
          };
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        // Internal processing error — log but never expose internals
        console.error(`[WEBHOOK] Processing error for order ${parseResult.event.order_id}: ${e.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal processing error" }));
      }
    });

    req.on("error", (err) => {
      console.error(`[WEBHOOK] Request error: ${err.message}`);
    });
  });

  return server;
}

/**
 * Start the webhook server. Does not return (event-loop bound).
 *
 * @param {object} config - Configuration
 * @param {Orchestrator} [orchestrator] - Optional orchestrator instance
 * @returns {Promise<http.Server>}
 */
function startServer(config, orchestrator) {
  const orch = orchestrator || new Orchestrator();
  const server = createServer(config, orch);

  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      reject(err);
    });

    server.listen(config.port, () => {
      console.log(`[WEBHOOK] Lemon Squeezy webhook handler listening on port ${config.port}`);
      if (config.devBypassActive) {
        console.log("[WEBHOOK] ⚠ DEVELOPMENT MODE: signature verification is BYPASSED");
        console.log("[WEBHOOK] Set LEMON_SQUEEZY_WEBHOOK_SECRET to enable signature verification");
      }
      if (!config.signatureRequired && !config.devBypassActive) {
        console.log("[WEBHOOK] ⚠ Configuration incomplete: no secret set and dev bypass not active");
      }
      resolve(server);
    });
  });
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    }
  }
  return args;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  loadConfig,
  verifySignature,
  parseWebhookPayload,
  SerializedQueue,
  createServer,
  startServer,
};

// ─── Main ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cliArgs = parseCliArgs(process.argv);
  const config = loadConfig();
  if (cliArgs.port) {
    config.port = cliArgs.port;
  }

  startServer(config)
    .then(() => {
      console.log(`[WEBHOOK] Server started successfully.`);
    })
    .catch((err) => {
      console.error(`[WEBHOOK] Failed to start server: ${err.message}`);
      process.exit(1);
    });
}
