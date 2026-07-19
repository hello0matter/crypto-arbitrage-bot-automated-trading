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

const STRIP_RESPONSE = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
]);

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
]);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ── Config validation ────────────────────────────────────────────────────────

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

function parseReplaceRules(value) {
  if (!value || !Array.isArray(value)) return [];
  return value.map((r, i) => {
    if (typeof r.pattern !== "string" || !r.pattern) {
      throw new Error(`replace_rules[${i}]: pattern required`);
    }
    if (typeof r.replacement !== "string") {
      throw new Error(`replace_rules[${i}]: replacement required (can be empty string)`);
    }
    const mode = r.mode || "literal";
    if (!["literal", "regex"].includes(mode)) {
      throw new Error(`replace_rules[${i}]: mode must be literal or regex`);
    }
    if (mode === "regex") {
      try { new RegExp(r.pattern); } catch (e) {
        throw new Error(`replace_rules[${i}]: invalid regex — ${e.message}`);
      }
    }
    return { pattern: r.pattern, replacement: r.replacement, mode, comment: r.comment || "" };
  });
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
    replaceRules: parseReplaceRules(raw.replace_rules),
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
    replace_rules: c.replaceRules,
  };
}

function writeConfig(c) {
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializeConfig(c), null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

function toPublicConfig(c) {
  return {
    admin_path: c.adminPath,
    admin_username: c.adminUsername,
    proxy_prefix: c.proxyPrefix,
    replace_rules: c.replaceRules,
    target_url: c.targetBase,
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

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

// ── Content rewriting ────────────────────────────────────────────────────────

function applyRules(text, rules) {
  for (const rule of rules) {
    if (rule.mode === "regex") {
      try { text = text.replace(new RegExp(rule.pattern, "g"), rule.replacement); } catch {}
    } else {
      text = text.split(rule.pattern).join(rule.replacement);
    }
  }
  return text;
}

// Rewrite a single URL value (href/src/url() argument)
function rewriteSingleUrl(u, origin, prefix) {
  const t = u.trim();
  if (t.startsWith(origin + "/") || t === origin) return prefix + t.slice(origin.length) || "/";
  const sr = "//" + new URL(origin).host;
  if (t.startsWith(sr + "/") || t === sr) return prefix + t.slice(sr.length);
  if (t.startsWith("/") && !t.startsWith("//")) return prefix + t;
  return u;
}

function rewriteHtml(html, origin, prefix, rules) {
  const eo = escapeRe(origin);
  const eh = escapeRe(new URL(origin).host);

  // Apply replace_rules FIRST, before URL rewriting, so rules can match original full URLs
  html = applyRules(html, rules);

  // Remove existing base, inject ours so relative URLs resolve correctly
  html = html.replace(/<base\b[^>]*>/gi, "");
  if (prefix) html = html.replace(/(<head\b[^>]*>)/i, `$1<base href="${prefix}/">`);

  // Full origin URLs in text/attributes
  html = html.replace(new RegExp(eo + "(/[^\"'<>\\s]*)", "g"), (_, p) => prefix + p);
  html = html.replace(new RegExp(eo + "(?=[\"'\\s<>]|$)", "g"), prefix || "/");

  // Protocol-relative origin
  html = html.replace(new RegExp("//" + eh + "(/[^\"'<>\\s]*)", "g"), (_, p) => prefix + p);

  // Absolute paths in common attributes — skip paths already carrying the prefix
  if (prefix) {
    html = html.replace(
      /((?:href|src|action|data-src|data-href|content)=["'])(\/(?!\/)[^"']*)/gi,
      (m, a, p) => (p === prefix || p.startsWith(prefix + "/")) ? m : `${a}${prefix}${p}`
    );
    // srcset with space-separated entries
    html = html.replace(/(srcset=["'])([^"']+)/gi, (_, a, v) => {
      const rw = v.replace(/(\/(?!\/)[^\s,]+)/g,
        m => (m === prefix || m.startsWith(prefix + "/")) ? m : prefix + m);
      return a + rw;
    });
  }

  // url() in inline style attributes — skip already-prefixed paths
  html = html.replace(/(style=["'][^"']*url\()(['"]?)(\/(?!\/)[^'")]+)\2([^"']*["'])/gi,
    (m) => m.replace(/url\((['"]?)(\/(?!\/)[^'")]+)\1\)/g,
      (_, q, u) => (u === prefix || u.startsWith(prefix + "/"))
        ? `url(${q}${u}${q})`
        : `url(${q}${prefix}${u}${q})`));

  // Rewrite relative-path URLs in attribute values (e.g. href="style.css" → href="/prefix/style.css")
  // Runs after absolute-path pass so only bare relative paths remain
  if (prefix) {
    html = html.replace(
      /((?:href|src|action|data-src|data-href)=["'])([A-Za-z0-9_~.-][^"']*)/gi,
      (m, a, p) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) ? m : `${a}${prefix}/${p}`
    );
  }

  // Strip Cloudflare cdn-cgi challenge scripts (they can't work through a proxy domain)
  html = html.replace(/<script\b[^>]*\bsrc=["'][^"']*\/cdn-cgi\/[^"']*["'][^>]*><\/script>/gi, "");

  // Rewrite base64-encoded data-stealth attributes (used by stealthOpen() for downloads)
  // These bypass normal href rewriting since the URL is encoded
  html = html.replace(/data-stealth=["']([A-Za-z0-9+/=]+)["']/gi, (m, b64) => {
    try {
      let decoded = Buffer.from(b64, "base64").toString("utf8");
      // Apply replace_rules to the decoded URL
      decoded = applyRules(decoded, rules);
      // Re-encode and return
      const newB64 = Buffer.from(decoded, "utf8").toString("base64");
      return `data-stealth="${newB64}"`;
    } catch { return m; }
  });

  return html;
}

function rewriteCss(css, origin, prefix, rules) {
  const eo = escapeRe(origin);
  const eh = escapeRe(new URL(origin).host);
  const originHost = new URL(origin).host;

  // Apply replace_rules FIRST before URL rewriting
  css = applyRules(css, rules);

  // Route external (non-origin) @import url() through our /--ext-cdn/ handler.
  // Prevents render-blocking when the CDN is unreachable (e.g. Google Fonts in China).
  css = css.replace(/@import\s+url\((['"]?)(https?:\/\/[^'")]+)\1\)/gi, (m, q, extUrl) => {
    try {
      const eu = new URL(extUrl);
      if (eu.host === originHost) return m; // same origin — leave for url() pass below
      const ep = `${prefix}/--ext-cdn/?h=${encodeURIComponent(eu.host)}&p=${encodeURIComponent(eu.pathname + eu.search)}`;
      return `@import url(${q}${ep}${q})`;
    } catch { return m; }
  });

  // url() — the main fix for broken layout
  css = css.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
    // Skip URLs already routed through --ext-cdn (prevent double-rewriting)
    if (u.includes("--ext-cdn")) return m;
    const rw = rewriteSingleUrl(u, origin, prefix);
    return rw === u ? m : `url(${q}${rw}${q})`;
  });

  // @import
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (_, q, u) =>
    `@import ${q}${rewriteSingleUrl(u, origin, prefix)}${q}`);

  // Full origin and protocol-relative URLs remaining in text
  css = css.replace(new RegExp(eo + "(/[^\"'<>\\s;,)]*)", "g"), (_, p) => prefix + p);
  css = css.replace(new RegExp("//" + eh + "(/[^\"'<>\\s;,)]*)", "g"), (_, p) => prefix + p);

  return css;
}

function rewriteJs(js, origin, prefix, rules) {
  // Only apply custom rules on JS — minimal origin substitution to avoid breaking framework code
  return applyRules(js, rules);
}

function rewriteLocation(loc, origin, prefix) {
  if (loc.startsWith(origin)) return (prefix + loc.slice(origin.length)) || "/";
  const h = new URL(origin).host;
  const sr = "//" + h;
  if (loc.startsWith(sr + "/") || loc === sr) return (prefix + loc.slice(sr.length)) || "/";
  return loc;
}

function bufferAndRewrite(proxyRes, res, outHeaders, rewriteFn) {
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
    try {
      const result = rewriteFn(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(proxyRes.statusCode, outHeaders);
      res.end(result, "utf8");
    } catch {
      if (!res.headersSent) res.writeHead(502).end();
    }
  });
  body.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); });
}

// ── Proxy handler ─────────────────────────────────────────────────────────────

function proxyRequest(config, req, res) {
  let parsed;
  try { parsed = new URL(req.url, "http://x"); }
  catch { return res.status(400).end(); }

  const upstreamUrl = config.targetBase + parsed.pathname + parsed.search;

  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (!HOP_BY_HOP.has(lk) && lk !== "host") fwdHeaders[k] = v;
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
          c.replace(/;\s*domain=[^;]+/gi, "")
           .replace(/;\s*samesite=[^;]+/gi, "; SameSite=Lax")
           .replace(/;\s*\bsecure\b/gi, "")
        );
        continue;
      }
      outHeaders[k] = v;
    }

    const ct = (proxyRes.headers["content-type"] || "").toLowerCase();
    const { targetOrigin: origin, proxyPrefix: prefix, replaceRules: rules } = config;

    if (ct.includes("text/html")) {
      outHeaders["cache-control"] = "no-store";
      bufferAndRewrite(proxyRes, res, outHeaders,
        text => rewriteHtml(text, origin, prefix, rules));
      return;
    }

    if (ct.includes("text/css")) {
      bufferAndRewrite(proxyRes, res, outHeaders,
        text => rewriteCss(text, origin, prefix, rules));
      return;
    }

    if (ct.includes("javascript") && rules.length > 0) {
      bufferAndRewrite(proxyRes, res, outHeaders,
        text => rewriteJs(text, origin, prefix, rules));
      return;
    }

    res.writeHead(proxyRes.statusCode, outHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.writeHead(504).end("timeout");
  });
  proxyReq.on("error", () => { if (!res.headersSent) res.writeHead(502).end("error"); });

  if (!["GET", "HEAD"].includes(req.method)) req.pipe(proxyReq); else proxyReq.end();
}

// ── App setup ────────────────────────────────────────────────────────────────

function main() {
  let config = loadConfig();
  const adminBase = `/${config.adminPath}`;
  const app = express();
  const json = express.json({ limit: "128kb" });
  app.disable("x-powered-by");

  app.get([adminBase, `${adminBase}/`], (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(ADMIN_PAGE_FILE);
  });

  app.post(`${adminBase}/api/login`, json, (req, res) => {
    if (!safeEqual(req.body?.username, config.adminUsername) ||
        !safeEqual(req.body?.password, config.adminPassword)) {
      return res.status(401).json({ ok: false, message: "invalid credentials" });
    }
    pruneTokens();
    res.json({ ok: true, token: issueToken() });
  });

  app.use(`${adminBase}/api`, (req, res, next) => {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!t || !TOKENS.has(t)) return res.status(401).json({ ok: false, message: "unauthorized" });
    TOKENS.set(t, Date.now());
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get(`${adminBase}/api/config`, (req, res) =>
    res.json({ ok: true, config: toPublicConfig(config) }));

  app.put(`${adminBase}/api/config`, json, (req, res) => {
    try {
      const b = req.body || {};
      const raw = {
        ...serializeConfig(config),
        target_url: b.target_url !== undefined ? b.target_url : config.targetBase,
        proxy_prefix: b.proxy_prefix !== undefined ? b.proxy_prefix : config.proxyPrefix,
        replace_rules: b.replace_rules !== undefined ? b.replace_rules : config.replaceRules,
        admin_username: b.admin_username !== undefined ? b.admin_username : config.adminUsername,
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

  // External CDN proxy: serves CSS @import and font resources on behalf of the browser.
  // Solves render-blocking caused by blocked CDNs (e.g. Google Fonts behind GFW).
  // Path format: /--ext-cdn/?h=<hostname>&p=<urlencoded-path-and-query>
  app.get("/--ext-cdn/", (req, res) => {
    const host = String(req.query.h || "").slice(0, 253);
    const rawPath = String(req.query.p || "/");
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) return res.status(400).end();
    let up;
    try { up = new URL("https://" + host + rawPath); } catch { return res.status(400).end(); }

    const extReq = https.request({
      hostname: up.hostname, port: 443,
      path: up.pathname + up.search, method: "GET",
      headers: { "user-agent": "Mozilla/5.0", "accept": "*/*" },
    }, extRes => {
      const ct = (extRes.headers["content-type"] || "").toLowerCase();
      if (!ct.includes("css") && !ct.includes("font") && !ct.includes("woff") && !ct.includes("opentype")) {
        return res.status(403).end();
      }
      const outH = {
        "content-type": ct,
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      };
      if (ct.includes("css")) {
        const chunks = [];
        extRes.on("data", c => chunks.push(c));
        extRes.on("end", () => {
          let text = Buffer.concat(chunks).toString("utf8");
          const pfx = config.proxyPrefix;
          // Rewrite url() inside fetched CSS so nested font files also go through us
          text = text.replace(/url\((['"]?)(https?:\/\/[^'")]+)\1\)/gi, (_, q, eu) => {
            try {
              const u = new URL(eu);
              return `url(${q}${pfx}/--ext-cdn/?h=${encodeURIComponent(u.host)}&p=${encodeURIComponent(u.pathname + u.search)}${q})`;
            } catch { return _; }
          });
          res.writeHead(extRes.statusCode, outH);
          res.end(text, "utf8");
        });
        extRes.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); });
      } else {
        res.writeHead(extRes.statusCode, outH);
        extRes.pipe(res);
      }
    });
    extReq.setTimeout(15000, () => extReq.destroy());
    extReq.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); });
    extReq.end();
  });

  app.use((req, res) => proxyRequest(config, req, res));

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`Listening ${config.bindHost}:${config.port}  target: ${config.targetBase}  admin: ${adminBase}`);
    if (config.replaceRules.length) console.log(`Replace rules: ${config.replaceRules.length}`);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
