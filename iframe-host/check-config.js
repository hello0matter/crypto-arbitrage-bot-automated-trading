#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

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

function parseProxyPrefix(v) {
  if (!v) return "";
  const s = String(v).replace(/\/+$/, "");
  if (s && !/^(\/[A-Za-z0-9._~-]+)+$/.test(s)) {
    throw new Error("proxy_prefix: must be empty or a path like /internal-content");
  }
  return s;
}

function loadConfig(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));

  let tu;
  try { tu = new URL(String(raw.target_url || "")); }
  catch { throw new Error("target_url: must be a valid URL"); }
  if (tu.protocol !== "https:") throw new Error("target_url: must use https:");

  const port = parseInt(String(raw.port || 3030), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port: 1-65535");

  return {
    adminPath: parseAdminPath(raw.admin_path),
    adminUsername: parseAdminUsername(raw.admin_username || "admin"),
    adminPassword: parseAdminPassword(raw.admin_password),
    bindHost: raw.bind_host || "0.0.0.0",
    port,
    proxyPrefix: parseProxyPrefix(raw.proxy_prefix),
    targetUrl: tu.toString().replace(/\/$/, ""),
    targetOrigin: tu.origin,
  };
}

function main() {
  const input = process.argv[2] || "config.json";
  const configPath = path.resolve(process.cwd(), input);
  if (!fs.existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);

  const result = loadConfig(configPath);
  console.log(`Config OK: ${configPath}`);
  console.log(`Target: ${result.targetUrl}`);
  console.log(`Proxy prefix: ${result.proxyPrefix || "(root)"}`);
  console.log(`Bind host: ${result.bindHost}`);
  console.log(`Admin path: ${result.adminPath}`);
  console.log(`Admin username: ${result.adminUsername}`);
}

try { main(); }
catch (e) { console.error(`Config check failed: ${e.message}`); process.exit(1); }
