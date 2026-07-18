#!/usr/bin/env node

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const CONFIG_FILE = path.resolve(ROOT, process.env.CONFIG_FILE || "config.json");
const ADMIN_PAGE_FILE = path.join(ROOT, "public", "admin.html");
const TOKENS = new Map();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Strip these from upstream responses
const STRIP_RESPONSE = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
]);

// Don't forward these to upstream
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
]);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function parseAdminPath(v) {
  const s = String(v || "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) throw new Error("admin_path: 1-80 chars [A-Za-z0-9_-]");
  return s;
}

function parseAdminUsername(v) {
  const s = String(v || "").trim();
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(s)) throw new Error("admin_username: 1-64 chars");
  return s;
}

function parseAdminPassword(v) {
  const s = String(v || "");
  if (s.length < 12) throw new Error("admin_password: at least 12 characters");
  return s;
}

function parseTargetUrl(v) {
  let u;
  try { u = new URL(String(v || "")); } catch { throw new Error("target_url: must be a valid URL"); }
  if (u.protocol !== "https:") throw new Error("target_url: must use https:");
  return u;
}

function parseProxyPrefix(v) {
  if (!v) return "";
  const s = String(v).replace(/\/+$/, "");
  if (s && !/^(\/[A-Za-z0-9._~-]+)+$/.test(s)) {
    throw new Error("proxy_prefix: must be empty or a path like /internal-content");
  }
  return s;
}

function readConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error(`Config not found: ${CONFIG_FILE}`);
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch (e) { throw new Error(`Config parse error: ${e.message}`); }
}

function normalizeConfig(raw) {
  const tu = parseTargetUrl(raw.target_url);
  const port = parseInt(String(raw.port || 3030), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port: 1-65535");
  return {
    adminPassword: parseAdminPassword(process.env.ADMIN_PASSWORD || raw.admin_password),
    adminPath: parseAdminPath(process.env.ADMIN_PATH || raw.admin_path),
    adminUsername: parseAdminUsername(process.env.ADMIN_USERNAME || raw.admin_username || "admin"),
    bindHost: process.env.BIND_HOST || raw.bind_host || "0.0.0.0",
    port: parseInt(process.env.PORT || port, 10),
    proxyPrefix: parseProxyPrefix(
      process.env.PROXY_PREFIX !== undefined ? process.env.PROXY_PREFIX : raw.proxy_prefix
    ),
    targetBase: tu.toString().replace(/\/$/, ""),
    targetOrigin: tu.origin,
  };
}

function loadConfig() { return normalizeConfig(readConfigFile()); }

function serializeConfig(c) {
  return {
    target_url: c.targetBase,
    proxy_prefix: c.proxyPrefix,
    port: c.port,
    bind_host: c.bindHost,
    admin_path: c.adminPath,
    admin_username: c.adminUsername,
    admin_password: c.adminPassword,
  };
}

function writeConfig(c) {
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializeConfig(c), null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

function toPublicConfig(c) {
  return { admin_path: c.adminPath, admin_username: c.adminUsername, proxy_prefix: c.proxyPrefix, target_url: c.targetBase };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function pruneTokens() {
  const now = Date.now();
  for (const [t, ts] of TOKENS) { if (now - ts > TOKEN_TTL_MS) TOKENS.delete(t); }
}

function issueToken() {
  const t = crypto.randomBytes(24).toString("hex");
  TOKENS.set(t, Date.now());
  return t;
}

function rewriteLocation(loc, origin, prefix) {
  if (loc.startsWith(origin)) return (prefix + loc.slice(origin.length)) || "/";
  const h = new URL(origin).host;
  const sr = "//" + h;
  if (loc.startsWith(sr + "/") || loc === sr) return (prefix + loc.slice(sr.length)) || "/";
  return loc;
}

function rewriteHtml(html, origin, prefix) {
  const eo = escapeRe(origin);
  const eh = escapeRe(new URL(origin).host);

  // Replace existing base tags, inject ours
  html = html.replace(/<base\b[^>]*>/gi, "");
  if (prefix) html = html.replace(/(<head\b[^>]*>)/i, `$1<base href="${prefix}/">`);

  // Full origin URLs -> prefix + path
  html = html.replace(new RegExp(eo + "(/[^\"'<>\\s]*)", "g"), (_, p) => prefix + p);
  html = html.replace(new RegExp(eo + "(?=[\"'\\s<>]|$)", "g"), prefix || "/");

  // Protocol-relative
  html = html.replace(new RegExp("//" + eh + "(/[^\"'<>\\s]*)", "g"), (_, p) => prefix + p);

  // Absolute paths in HTML attributes (only when proxied under a prefix)
  if (prefix) {
    html = html.replace(/((?:href|src|action)=["'])(\/(?!\/)[^"']*)/gi,
      (_, a, p) => `${a}${prefix}${p}`);
  }

  return html;
}

function proxyRequest(config, req, res) {
  let parsed;
  try { parsed = new URL(req.url, "http://x"); }
  catch { return res.status(400).end(); }

  const upstreamUrl = config.targetBase + parsed.pathname + parsed.search;
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k !== "host") fwdHeaders[k] = v;
  }
  fwdHeaders.host = new URL(config.targetOrigin).host;

  let up;
  try { up = new URL(upstreamUrl); }
  catch { return res.status(400).end(); }

  const transport = up.protocol === "https:" ? https : http;
  const proxyReq = transport.request({
    hostname: up.hostname,
    port: up.port || (up.protocol === "https:" ? 443 : 80),
    path: up.pathname + up.search,
    method: req.method,
    headers: fwdHeaders,
  }, (proxyRes) => {
    const outHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      const lk = k.toLowerCase();
      if (STRIP_RESPONSE.has(lk)) continue;
      if (lk === "location") {
        outHeaders[k] = rewriteLocation(v, config.targetOrigin, config.proxyPrefix);
        continue;
      }
      if (lk === "set-cookie") {
        const cookies = Array.isArray(v) ? v : [v];
        outHeaders[k] = cookies.map(c =>
          c.replace(/;\s*domain=[^;]+/gi, "").replace(/;\s*samesite=[^;]+/gi, "; SameSite=Lax")
        );
        continue;
      }
      outHeaders[k] = v;
    }

    const ct = (proxyRes.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("text/html")) {
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
      return;
    }

    // Buffer HTML for URL rewriting
    delete outHeaders["content-length"];
    delete outHeaders["content-encoding"];
    const enc = (proxyRes.headers["content-encoding"] || "").toLowerCase();
    let body = proxyRes;
    if (enc === "gzip") body = proxyRes.pipe(zlib.createGunzip());
    else if (enc === "br") body = proxyRes.pipe(zlib.createBrotliDecompress());
    else if (enc === "deflate") body = proxyRes.pipe(zlib.createInflate());

    const chunks = [];
    body.on("data", c => chunks.push(c));
    body.on("end", () => {
      const html = rewriteHtml(
        Buffer.concat(chunks).toString("utf8"),
        config.targetOrigin,
        config.proxyPrefix
      );
      res.writeHead(proxyRes.statusCode, outHeaders);
      res.end(html, "utf8");
    });
    body.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); });
  });

  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.writeHead(504).end("timeout");
  });
  proxyReq.on("error", () => { if (!res.headersSent) res.writeHead(502).end("error"); });

  if (!["GET", "HEAD"].includes(req.method)) req.pipe(proxyReq); else proxyReq.end();
}

function main() {
  let config = loadConfig();
  const adminBase = `/${config.adminPath}`;
  const app = express();
  const json = express.json({ limit: "64kb" });
  app.disable("x-powered-by");

  // Admin UI
  app.get([adminBase, `${adminBase}/`], (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(ADMIN_PAGE_FILE);
  });

  // Login (no auth token needed)
  app.post(`${adminBase}/api/login`, json, (req, res) => {
    if (!safeEqual(req.body?.username, config.adminUsername) ||
        !safeEqual(req.body?.password, config.adminPassword)) {
      return res.status(401).json({ ok: false, message: "invalid credentials" });
    }
    pruneTokens();
    res.json({ ok: true, token: issueToken() });
  });

  // Auth middleware for remaining admin API routes
  app.use(`${adminBase}/api`, (req, res, next) => {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!t || !TOKENS.has(t)) return res.status(401).json({ ok: false, message: "unauthorized" });
    TOKENS.set(t, Date.now());
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get(`${adminBase}/api/config`, (req, res) => res.json({ ok: true, config: toPublicConfig(config) }));

  app.put(`${adminBase}/api/config`, json, (req, res) => {
    try {
      const b = req.body || {};
      const raw = {
        ...serializeConfig(config),
        target_url: b.target_url ?? config.targetBase,
        proxy_prefix: b.proxy_prefix ?? config.proxyPrefix,
        admin_username: b.admin_username ?? config.adminUsername,
      };
      if (String(b.admin_password || "").trim()) raw.admin_password = b.admin_password;
      const next = normalizeConfig(raw);
      writeConfig(next);
      config = next;
      res.json({ ok: true, config: toPublicConfig(config) });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  // Reverse-proxy everything else to the target
  app.use((req, res) => proxyRequest(config, req, res));

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`Listening ${config.bindHost}:${config.port}  target: ${config.targetBase}  admin: ${adminBase}`);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
