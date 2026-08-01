#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Orchestrator, readJsonSafe, atomicWriteJson, BACKLOG_PATH, WORKSPACE_ROOT, appendAuditLog } = require("./orchestrator");
const LOCK_PATH = path.join(WORKSPACE_ROOT, ".founder-os", "worker.lock");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function acquireLock(lockPath = LOCK_PATH, staleMs = 24 * 60 * 60 * 1000) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try { const fd = fs.openSync(lockPath, "wx"); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fs.closeSync(fd); return true; }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    try { const st = fs.statSync(lockPath); if (Date.now() - st.mtimeMs > staleMs) { fs.unlinkSync(lockPath); return acquireLock(lockPath, staleMs); } } catch (_) {}
    return false;
  }
}
function releaseLock(lockPath = LOCK_PATH) { try { fs.unlinkSync(lockPath); } catch (e) { if (e.code !== "ENOENT") throw e; } }
function isExplicitInboxRecord(r) {
  return r && r.processed !== true && (r.type === "FORM_SUBMISSION_RAW" || r.type === "PAYMENT_EVENT") && (r.source || r.payload || r.data);
}
function payloadOf(r) { return r.payload || r.data || r.source; }
function recordKey(r) { return r.id || crypto.createHash("sha256").update(JSON.stringify(payloadOf(r))).digest("hex"); }
async function processOnce(orchestrator = new Orchestrator()) {
  const backlog = readJsonSafe(BACKLOG_PATH); const candidates = backlog.filter(isExplicitInboxRecord);
  if (!candidates.length) return { processed: 0, failed: 0, skipped: backlog.length };
  const remove = new Set(); let failed = 0;
  for (const input of candidates) {
    try {
      const result = input.type === "FORM_SUBMISSION_RAW" ? orchestrator.processFormSubmission(payloadOf(input)) : orchestrator.processPaymentEvent(payloadOf(input));
      if (result && result.error) throw new Error(result.message || "orchestrator rejected input");
      remove.add(recordKey(input)); appendAuditLog({ timestamp: new Date().toISOString(), action: "WORKER_PROCESSED_INBOX", inputId: input.id || null, inputType: input.type });
    } catch (e) { failed++; appendAuditLog({ timestamp: new Date().toISOString(), action: "WORKER_INPUT_FAILED", inputId: input.id || null, inputType: input.type, error: e.message }); }
  }
  if (remove.size) {
    // Re-read after orchestration: processing may append/transition ledger records.
    // Never overwrite those records with the stale snapshot used for classification.
    const latest = readJsonSafe(BACKLOG_PATH);
    atomicWriteJson(BACKLOG_PATH, latest.filter(r => !remove.has(recordKey(r))));
  }
  return { processed: remove.size, failed, skipped: backlog.length - candidates.length };
}
function start(options = {}) {
  const intervalMs = Math.max(1000, Number(options.intervalMs || process.env.WORKER_INTERVAL_MS || DEFAULT_INTERVAL_MS));
  const lockPath = options.lockPath || LOCK_PATH;
  if (!acquireLock(lockPath, options.staleMs)) return { started: false, reason: "lock-held" };
  let stopping = false, timer;
  const stop = () => { if (stopping) return; stopping = true; clearTimeout(timer); releaseLock(lockPath); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const tick = async () => { if (stopping) return; try { await processOnce(options.orchestrator); } catch (e) { appendAuditLog({ timestamp: new Date().toISOString(), action: "WORKER_TICK_FAILED", error: e.message }); } if (!stopping) timer = setTimeout(tick, intervalMs); };
  tick(); return { started: true, stop, intervalMs };
}
if (require.main === module) { const run = start(); if (!run.started) { console.error("worker already running"); process.exitCode = 1; } }
module.exports = { LOCK_PATH, DEFAULT_INTERVAL_MS, acquireLock, releaseLock, isExplicitInboxRecord, processOnce, start };
