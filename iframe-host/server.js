#!/usr/bin/env node

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = __dirname;
const CONFIG_FILE = path.resolve(ROOT, process.env.CONFIG_FILE || "config.json");
let DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || "data");
let ACCESS_FILE = path.join(DATA_DIR, "access.jsonl");
const PUBLIC_DIR = path.join(ROOT, "public");
const TOKENS = new Map();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ensureUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("仅支持 http/https");
  return url.toString();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function randomPassword() {
  return crypto.randomBytes(12).toString("base64url");
}

async function createInteractiveConfig() {
  if (!process.stdin.isTTY) {
    throw new Error("config.json 不存在；请先在交互终端运行一次，或复制 config.example.json");
  }

  const targetInput = await ask("请输入你的站点 URL: ");
  const titleInput = await ask("页面标题(默认 Embedded Site): ");
  const portInput = await ask("监听端口(默认 3030): ");
  const userInput = await ask("后台账号(默认 admin): ");
  const generatedPassword = randomPassword();
  const passwordInput = await ask(`后台密码(直接回车自动生成 ${generatedPassword}): `);
  const trustProxyInput = await ask("是否位于 Nginx/反向代理后面，需要信任 X-Forwarded-For？(yes/no，默认 no): ");

  const config = {
    target_url: ensureUrl(targetInput),
    title: titleInput || "Embedded Site",
    port: clampNumber(portInput, 3030, 1, 65535),
    admin_user: userInput || "admin",
    admin_password: passwordInput || generatedPassword,
    trust_proxy: parseBoolean(trustProxyInput, false),
    data_dir: "data",
    retention_days: 30,
    max_records: 10000,
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`配置已保存到 ${CONFIG_FILE}`);
  return config;
}

async function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } else if (!process.env.TARGET_URL) {
    fileConfig = await createInteractiveConfig();
  }

  const targetUrl = ensureUrl(process.env.TARGET_URL || fileConfig.target_url);
  const config = {
    targetUrl,
    title: process.env.PAGE_TITLE || fileConfig.title || "Embedded Site",
    port: clampNumber(process.env.PORT || fileConfig.port, 3030, 1, 65535),
    adminUser: process.env.ADMIN_USER || fileConfig.admin_user || "admin",
    adminPassword: process.env.ADMIN_PASSWORD || fileConfig.admin_password || "",
    trustProxy: parseBoolean(process.env.TRUST_PROXY, Boolean(fileConfig.trust_proxy)),
    dataDir: path.resolve(ROOT, process.env.DATA_DIR || fileConfig.data_dir || "data"),
    retentionDays: clampNumber(process.env.RETENTION_DAYS || fileConfig.retention_days, 30, 1, 3650),
    maxRecords: clampNumber(process.env.MAX_RECORDS || fileConfig.max_records, 10000, 100, 1000000),
  };

  if (config.adminPassword.length < 8) throw new Error("后台密码至少需要 8 个字符");
  return config;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req, trustProxy) {
  let value = req.socket.remoteAddress || "";
  if (trustProxy && req.headers["x-forwarded-for"]) {
    value = String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return value.replace(/^::ffff:/, "");
}

function parseDevice(userAgent) {
  const ua = String(userAgent || "");
  let os = "Unknown";
  let browser = "Unknown";
  let device = "Desktop";

  if (/Android/i.test(ua)) { os = "Android"; device = /Mobile/i.test(ua) ? "Mobile" : "Tablet"; }
  else if (/iPhone/i.test(ua)) { os = "iOS"; device = "Mobile"; }
  else if (/iPad/i.test(ua)) { os = "iPadOS"; device = "Tablet"; }
  else if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\//i.test(ua)) browser = "Opera";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua)) browser = "Safari";
  else if (/curl\//i.test(ua)) { browser = "curl"; device = "CLI"; }

  return { os, browser, device };
}

function appendAccess(record) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(ACCESS_FILE, JSON.stringify(record) + "\n", "utf8");
}

function readAccessRecords() {
  if (!fs.existsSync(ACCESS_FILE)) return [];
  return fs.readFileSync(ACCESS_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function writeAccessRecords(records) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const body = records.map((item) => JSON.stringify(item)).join("\n");
  fs.writeFileSync(ACCESS_FILE, body ? body + "\n" : "", "utf8");
}

function pruneAccessRecords(config) {
  const records = readAccessRecords();
  const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  const kept = records
    .filter((item) => Date.parse(item.time || "") >= cutoff)
    .slice(-config.maxRecords);
  if (kept.length !== records.length) writeAccessRecords(kept);
  return kept;
}

function getBearer(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function isTokenValid(token) {
  const createdAt = TOKENS.get(token);
  if (!createdAt) return false;
  if (Date.now() - createdAt > TOKEN_TTL_MS) {
    TOKENS.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (!isTokenValid(getBearer(req))) return res.status(401).json({ ok: false, message: "unauthorized" });
  next();
}

function buildPage(config) {
  const safeTitle = escapeHtml(config.title);
  const safeUrl = escapeHtml(config.targetUrl);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root{color-scheme:dark;--panel:#111936;--text:#e8eefc;--muted:#9cb0d9;--line:#2a3764;--accent:#58f29a}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0a0f1d,#121a31);color:var(--text);font-family:Arial,sans-serif}
    .wrap{max-width:1400px;margin:0 auto;padding:24px}.panel{background:rgba(17,25,54,.94);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:16px;box-shadow:0 10px 35px rgba(0,0,0,.35)}
    .k{color:var(--muted);font-size:13px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em}.v{word-break:break-all;font-size:15px}.tip{color:var(--muted);line-height:1.6;font-size:13px}
    iframe{width:100%;height:calc(100vh - 245px);border:1px solid var(--line);border-radius:16px;background:#fff}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(88,242,154,.12);color:var(--accent);border:1px solid rgba(88,242,154,.28);font-size:12px;margin-bottom:8px}
  </style>
</head>
<body><div class="wrap"><div class="panel"><div class="badge">Owned Site Embed Host</div><h1 style="margin:0 0 12px">${safeTitle}</h1><div class="k">Target URL</div><div class="v">${safeUrl}</div><p class="tip">本页面会记录访问时间、IP 地址、User-Agent、来源页面及浏览器/系统摘要，用于运行维护和访问审计。</p></div><iframe src="${safeUrl}" referrerpolicy="strict-origin-when-cross-origin"></iframe></div></body>
</html>`;
}

async function main() {
  const config = await loadConfig();
  DATA_DIR = config.dataDir;
  ACCESS_FILE = path.join(DATA_DIR, "access.jsonl");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  pruneAccessRecords(config);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  app.get("/", (req, res) => {
    const ua = String(req.headers["user-agent"] || "");
    appendAccess({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      ip: clientIp(req, config.trustProxy),
      method: req.method,
      path: req.originalUrl,
      referrer: String(req.headers.referer || ""),
      language: String(req.headers["accept-language"] || ""),
      user_agent: ua,
      ...parseDevice(ua),
    });
    pruneAccessRecords(config);
    res.type("html").send(buildPage(config));
  });

  app.get("/healthz", (req, res) => {
    res.json({ ok: true, title: config.title, port: config.port });
  });

  app.get("/admin", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
  });

  app.post("/admin/api/login", (req, res) => {
    const username = String(req.body?.username || "");
    const password = String(req.body?.password || "");
    if (!safeEqual(username, config.adminUser) || !safeEqual(password, config.adminPassword)) {
      return res.status(401).json({ ok: false, message: "账号或密码错误" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    TOKENS.set(token, Date.now());
    res.json({ ok: true, token });
  });

  app.get("/admin/api/access", requireAdmin, (req, res) => {
    const limit = clampNumber(req.query.limit, 500, 1, 5000);
    const records = pruneAccessRecords(config).slice(-limit).reverse();
    const uniqueIps = new Set(records.map((item) => item.ip).filter(Boolean)).size;
    res.json({ ok: true, records, total: records.length, unique_ips: uniqueIps });
  });

  app.delete("/admin/api/access", requireAdmin, (req, res) => {
    if (String(req.body?.confirm || "") !== "CLEAR") {
      return res.status(400).json({ ok: false, message: "confirm must be CLEAR" });
    }
    writeAccessRecords([]);
    res.json({ ok: true });
  });

  app.use((req, res) => res.status(404).json({ ok: false, message: "not found" }));

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`\n已启动: http://127.0.0.1:${config.port}`);
    console.log(`目标站点: ${config.targetUrl}`);
    console.log(`管理后台: http://127.0.0.1:${config.port}/admin`);
    console.log(`配置文件: ${CONFIG_FILE}`);
    console.log(`数据目录: ${DATA_DIR}`);
    console.log(`反向代理 IP 信任: ${config.trustProxy ? "开启" : "关闭"}`);
  });
}

main().catch((error) => {
  console.error(`启动失败: ${error.message}`);
  process.exit(1);
});
