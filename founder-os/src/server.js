#!/usr/bin/env node
/**
 * Founder OS — Combined Public Server
 * "Zero-Error Infrastructure Lock-In" Consultancy Engine
 *
 * Single deployable HTTP entrypoint for hosts (Render, Railway, Fly.io, a VPS)
 * that only expose one process/port. Combines:
 *
 *   POST /webhook   — Lemon Squeezy payment webhook (signature-verified)
 *   POST /intake    — Public application-form intake from the landing page
 *   GET  /health    — Host health check
 *
 * This does NOT replace webhookHandler.js — it reuses its exported signature
 * verification and payload parsing so the tested Lemon Squeezy logic is
 * untouched. It adds the missing public intake path that the landing page's
 * form actually needs, which did not exist anywhere in the codebase before.
 *
 * NOTE ON AUTONOMY: this endpoint classifies and stores applications only.
 * It does not send any outbound email or message. That matches the existing
 * design intent in PRODUCTION_SETUP.md — "No outbound messages are sent
 * automatically... all persona drafts require explicit human confirmation."
 * If you want auto-replies to applicants, that is a separate, deliberate
 * change — not something this file adds silently.
 *
 * Environment:
 *   PORT                            — Port to listen on (Render sets this)
 *   ALLOWED_ORIGIN                  — Your GitHub Pages origin, e.g.
 *                                     https://adam0888.github.io
 *   LEMON_SQUEEZY_WEBHOOK_SECRET    — HMAC shared secret (fail closed if set)
 *   LEMON_SQUEEZY_WEBHOOK_DEV_BYPASS — "1" to skip signature check (dev only)
 *   INTAKE_MAX_BODY_BYTES           — Max intake body size (default 16384)
 *   INTAKE_RATE_LIMIT_MAX           — Max intake requests per IP per window
 *                                     (default 5)
 *   INTAKE_RATE_LIMIT_WINDOW_MS     — Rate limit window (default 600000 = 10m)
 */

"use strict";

const http = require("http");
const path = require("path");

const {
  loadConfig: loadWebhookConfig,
  verifySignature,
  parseWebhookPayload,
} = require(path.resolve(__dirname, "webhookHandler.js"));

const { Orchestrator } = require(path.resolve(__dirname, "orchestrator.js"));

// ─── Configuration ───────────────────────────────────────────────────────────

function loadConfig() {
  const webhookConfig = loadWebhookConfig();
  return {
    ...webhookConfig,
    port: parseInt(process.env.PORT || webhookConfig.port || "3100", 10),
    allowedOrigin: process.env.ALLOWED_ORIGIN || "",
    intakeMaxBodyBytes: parseInt(process.env.INTAKE_MAX_BODY_BYTES || "16384", 10),
    intakeRateLimitMax: parseInt(process.env.INTAKE_RATE_LIMIT_MAX || "5", 10),
    intakeRateLimitWindowMs: parseInt(
      process.env.INTAKE_RATE_LIMIT_WINDOW_MS || "600000",
      10
    ),
  };
}

// ─── Minimal in-memory rate limiter (per IP) ─────────────────────────────────
// Note: this resets on process restart and does not share state across
// multiple instances. Fine for a single free-tier instance; if you scale
// horizontally later, move this to a shared store (Redis, etc.).

function createRateLimiter(maxRequests, windowMs) {
  const hits = new Map();

  return function isAllowed(ip) {
    const now = Date.now();
    const timestamps = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      hits.set(ip, timestamps);
      return false;
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    return true;
  };
}

// ─── CORS ────────────────────────────────────────────────────────────────────

function applyCors(req, res, allowedOrigin) {
  const origin = req.headers.origin || "";
  if (allowedOrigin && origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Signature");
}

// ─── Body reading helper ─────────────────────────────────────────────────────

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        req.destroy();
        return;
      }
      raw += chunk.toString("utf-8");
    });

    req.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Payload too large"), { code: "TOO_LARGE" }));
        return;
      }
      resolve(raw);
    });

    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── Intake field mapping ────────────────────────────────────────────────────
// Maps the landing page's form field names to the exact names
// orchestrator.processFormSubmission() / validateSubmissionFields() require.

function mapIntakePayload(body) {
  return {
    name: body.name || "",
    email: body.email || "",
    role: body.role || "",
    company: body.company || "",
    arr: body.arr || "",
    database_stack: body.database_stack || body.stack || "",
    engagement_reason: body.engagement_reason || body.trigger || "",
  };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

function createServer(config, orchestrator) {
  const intakeAllowed = createRateLimiter(
    config.intakeRateLimitMax,
    config.intakeRateLimitWindowMs
  );

  const server = http.createServer(async (req, res) => {
    applyCors(req, res, config.allowedOrigin);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // ── Lemon Squeezy payment webhook ──────────────────────────────────────
    // Accepts both /webhook (existing internal path) and /webhooks/lemon-squeezy
    // (the path documented in PRODUCTION_SETUP.md — previously a 404 due to a
    // mismatch between the docs and webhookHandler.js's own route check).
    if (
      req.method === "POST" &&
      (req.url === "/webhook" || req.url === "/webhooks/lemon-squeezy")
    ) {
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("application/json")) {
        sendJson(res, 415, { error: "Unsupported Media Type: expected application/json" });
        return;
      }

      let rawBody;
      try {
        rawBody = await readBody(req, config.maxBodyBytes);
      } catch (e) {
        sendJson(res, e.code === "TOO_LARGE" ? 413 : 400, { error: e.message });
        return;
      }

      if (!rawBody.trim()) {
        sendJson(res, 400, { error: "Empty body" });
        return;
      }

      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (e) {
        sendJson(res, 400, { error: "Invalid JSON", detail: e.message });
        return;
      }

      if (config.signatureRequired) {
        if (!config.webhookSecret) {
          sendJson(res, 500, { error: "Webhook secret not configured on server" });
          return;
        }
        const sigHeader = req.headers["x-signature"] || "";
        const sigResult = verifySignature(rawBody, sigHeader, config.webhookSecret);
        if (!sigResult.valid) {
          sendJson(res, 401, { error: "Signature verification failed", detail: sigResult.reason });
          return;
        }
      }

      const parseResult = parseWebhookPayload(parsedBody);
      if (!parseResult.valid) {
        sendJson(res, 400, { error: parseResult.error });
        return;
      }

      try {
        const paymentResult = orchestrator.processPaymentEvent(parseResult.event);
        sendJson(res, 200, {
          processed: true,
          status: paymentResult.status || paymentResult.type || "UNKNOWN",
          order_id: parseResult.event.order_id,
          idempotent: paymentResult.idempotent || false,
        });
      } catch (e) {
        console.error(`[WEBHOOK] Processing error: ${e.message}`);
        sendJson(res, 500, { error: "Internal processing error" });
      }
      return;
    }

    // ── Public application-form intake ─────────────────────────────────────
    if (req.method === "POST" && req.url === "/intake") {
      const ip = req.socket.remoteAddress || "unknown";
      if (!intakeAllowed(ip)) {
        sendJson(res, 429, { error: "Too many applications from this address. Try again later." });
        return;
      }

      const contentType = (req.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("application/json")) {
        sendJson(res, 415, { error: "Unsupported Media Type: expected application/json" });
        return;
      }

      let rawBody;
      try {
        rawBody = await readBody(req, config.intakeMaxBodyBytes);
      } catch (e) {
        sendJson(res, e.code === "TOO_LARGE" ? 413 : 400, { error: e.message });
        return;
      }

      if (!rawBody.trim()) {
        sendJson(res, 400, { error: "Empty body" });
        return;
      }

      let parsedBody;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (e) {
        sendJson(res, 400, { error: "Invalid JSON", detail: e.message });
        return;
      }

      // Honeypot: a hidden field real users never fill in. If populated,
      // silently accept without processing — don't tip off the bot.
      if (parsedBody._hp && String(parsedBody._hp).trim() !== "") {
        sendJson(res, 200, { received: true });
        return;
      }

      const submission = mapIntakePayload(parsedBody);

      try {
        const result = orchestrator.processFormSubmission(submission);
        sendJson(res, 200, {
          received: true,
          id: result.id,
          classification: result.classification,
        });
      } catch (e) {
        console.error(`[INTAKE] Processing error: ${e.message}`);
        sendJson(res, 500, { error: "Internal processing error" });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  return server;
}

function startServer(config, orchestrator) {
  const orch = orchestrator || new Orchestrator();
  const server = createServer(config, orch);

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.port, () => {
      console.log(`[SERVER] Founder OS public server listening on port ${config.port}`);
      console.log(`[SERVER] Webhook routes: POST /webhook, POST /webhooks/lemon-squeezy`);
      console.log(`[SERVER] Intake route:   POST /intake`);
      if (!config.allowedOrigin) {
        console.log(`[SERVER] ⚠ ALLOWED_ORIGIN not set — /intake will not send CORS headers, browser requests from your site will be blocked`);
      }
      if (config.devBypassActive) {
        console.log("[SERVER] ⚠ DEVELOPMENT MODE: webhook signature verification is BYPASSED");
      }
      resolve(server);
    });
  });
}

module.exports = { loadConfig, createServer, startServer, mapIntakePayload };

if (require.main === module) {
  const config = loadConfig();
  startServer(config)
    .then(() => console.log("[SERVER] Started successfully."))
    .catch((err) => {
      console.error(`[SERVER] Failed to start: ${err.message}`);
      process.exit(1);
    });
}
