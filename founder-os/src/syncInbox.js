#!/usr/bin/env node
"use strict";
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const { Orchestrator, McpBridge, readJsonSafe, atomicWriteJson, BACKLOG_PATH, ACTIVE_PATH, WORKSPACE_ROOT, appendAuditLog } = require("./orchestrator");
const LOCK_PATH = path.join(WORKSPACE_ROOT, ".founder-os", "sync-inbox.lock");
const DRAFT_LOG = path.join(WORKSPACE_ROOT, ".founder-os", "logs", "inbox-drafts.jsonl");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; const DEFAULT_ENDPOINT = "http://localhost:3000/mcp"; const MAX_BLOCKS = 25; const MAX_BODY = 256 * 1024;
function acquireLock(lockPath = LOCK_PATH, staleMs = 86400000) { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); try { const fd = fs.openSync(lockPath, "wx"); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); return true; } catch (e) { if (e.code !== "EEXIST") throw e; try { if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) { fs.unlinkSync(lockPath); return acquireLock(lockPath, staleMs); } } catch (_) {} return false; } }
function releaseLock(p = LOCK_PATH) { try { fs.unlinkSync(p); } catch (e) { if (e.code !== "ENOENT") throw e; } }
function normalizeMessages(messages) { return (Array.isArray(messages) ? messages : []).slice(0, MAX_BLOCKS).filter(m => m && typeof m.text === "string" && m.text.trim()).map(m => ({ type: "text", text: m.text.slice(0, 4096), truncated: m.text.length > 4096 })); }
function taskFor(message, engagement) { const key = crypto.createHash("sha256").update(JSON.stringify({ engagementId: engagement.id, text: message.text })).digest("hex"); return { id: `INBOX-${key.slice(0, 20)}`, type: "PENDING_TASK", status: "PENDING", source: "mcp-inbox", dedupeKey: key, engagementId: engagement.id, task: "Review active-client message", message: message.text, createdAt: new Date().toISOString() }; }
async function syncOnce(options = {}) {
  if (options.disabled || process.env.SYNC_INBOX_DISABLED === "1" || process.env.MCP_SYNC_ENABLED === "0") return { enabled: false, added: 0, reason: "disabled" };
  const active = readJsonSafe(ACTIVE_PATH).filter(r => r.status === "ENGAGEMENT_ACTIVE");
  const emails = active.map(r => r.customerEmail || (r.applicant && r.applicant.email)).filter(Boolean);
  if (!emails.length) return { enabled: true, added: 0, reason: "no-active-clients" };
  const orchestrator = options.orchestrator || new Orchestrator({ mcp: { enabled: true, endpoint: options.endpoint || process.env.MCP_ENDPOINT || DEFAULT_ENDPOINT, timeoutMs: Number(options.timeoutMs || 5000), rpcEnabled: false } });
  const response = options.messages ? { messages: options.messages } : await orchestrator.mcp.queryActiveClientMessages(emails);
  const messages = normalizeMessages(response.messages); const backlog = readJsonSafe(BACKLOG_PATH); const seen = new Set(backlog.map(r => r.dedupeKey)); const additions = [];
  for (const message of messages) for (const engagement of active) { const task = taskFor(message, engagement); if (!seen.has(task.dedupeKey)) { seen.add(task.dedupeKey); additions.push(task); } }
  if (additions.length) atomicWriteJson(BACKLOG_PATH, backlog.concat(additions));
  // Dedupe draft log entries: skip if same engagement+contentHash already logged
  const existingDraftHashes = (() => { try { if (fs.existsSync(DRAFT_LOG)) { const raw = fs.readFileSync(DRAFT_LOG, "utf-8").trim(); if (raw) { return raw.split("\n").filter(Boolean).map(line => { try { const e = JSON.parse(line); return `${e.engagementId || ""}::${e.contentHash || ""}`; } catch (_) { return ""; } }); } } } catch (_) {} return []; })();
  const draftSeen = new Set(existingDraftHashes.filter(Boolean));
  for (const engagement of active) { const related = messages.map(m => ({ type: "text", text: m.text })); if (related.length) { const draft = orchestrator.mcp.generatePersonaDraft(engagement, related, "diagnostic"); const dk = `${engagement.id}::${draft.contentHash}`; if (!draftSeen.has(dk)) { draftSeen.add(dk); fs.mkdirSync(path.dirname(DRAFT_LOG), { recursive: true }); fs.appendFileSync(DRAFT_LOG, JSON.stringify({ timestamp: new Date().toISOString(), engagementId: engagement.id, contentHash: draft.contentHash, confirmationStatus: "UNCONFIRMED", content: draft.draft.content }) + "\n"); } } }
  appendAuditLog({ timestamp: new Date().toISOString(), action: "SYNC_INBOX", messageCount: messages.length, added: additions.length }); return { enabled: true, added: additions.length, messages: messages.length };
}
function start(options = {}) { const intervalMs = Math.max(1000, Number(options.intervalMs || process.env.SYNC_INBOX_INTERVAL_MS || DEFAULT_INTERVAL_MS)); const lockPath = options.lockPath || LOCK_PATH; if (!acquireLock(lockPath, options.staleMs)) return { started: false, reason: "lock-held" }; let stopping = false, timer; const stop = () => { if (stopping) return; stopping = true; clearTimeout(timer); releaseLock(lockPath); }; process.once("SIGTERM", stop); process.once("SIGINT", stop); const tick = async () => { if (stopping) return; try { await syncOnce(options); } catch (e) { appendAuditLog({ timestamp: new Date().toISOString(), action: "SYNC_INBOX_FAILED", error: e.message }); } if (!stopping) timer = setTimeout(tick, intervalMs); }; tick(); return { started: true, stop, intervalMs }; }
if (require.main === module) { const r = start(); if (!r.started) { console.error("sync inbox already running"); process.exitCode = 1; } }
module.exports = { LOCK_PATH, DRAFT_LOG, DEFAULT_ENDPOINT, DEFAULT_INTERVAL_MS, acquireLock, releaseLock, normalizeMessages, taskFor, syncOnce, start };
