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

function parseTargetUrl(value, label) {
  let target;
  try { target = new URL(String(value || "")); }
  catch { throw new Error(`${label}: must be a valid URL`); }
  if (target.protocol !== "https:") throw new Error(`${label}: must use https:`);
  return target.toString().replace(/\/$/, "");
}

function parseSite(site, index) {
  if (!site || typeof site !== "object") throw new Error(`sites[${index}]: must be an object`);
  const id = String(site.id || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error(`sites[${index}].id: 1-64 chars [A-Za-z0-9_-], starting alphanumeric`);
  }
  return {
    id,
    prefix: parseProxyPrefix(site.proxy_prefix),
    targetUrl: parseTargetUrl(site.target_url, `sites[${index}].target_url`),
    enabled: site.enabled !== false,
  };
}

function loadConfig(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const port = parseInt(String(raw.port || 3030), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port: 1-65535");

  const sites = Array.isArray(raw.sites) && raw.sites.length
    ? raw.sites.map(parseSite)
    : [{
        id: "default",
        prefix: parseProxyPrefix(raw.proxy_prefix),
        targetUrl: parseTargetUrl(raw.target_url, "target_url"),
        enabled: true,
      }];
  const ids = new Set();
  const prefixes = new Set();
  for (const site of sites) {
    if (ids.has(site.id)) throw new Error(`duplicate site id: ${site.id}`);
    if (prefixes.has(site.prefix)) throw new Error(`duplicate proxy_prefix: ${site.prefix || "/"}`);
    ids.add(site.id);
    prefixes.add(site.prefix);
  }
  if (!sites.some(site => site.enabled)) throw new Error("at least one site must be enabled");

  return {
    adminPath: parseAdminPath(raw.admin_path),
    adminUsername: parseAdminUsername(raw.admin_username || "admin"),
    adminPassword: parseAdminPassword(raw.admin_password),
    bindHost: raw.bind_host || "0.0.0.0",
    port,
    sites,
  };
}

function main() {
  const input = process.argv[2] || "config.json";
  const configPath = path.resolve(process.cwd(), input);
  if (!fs.existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);

  const result = loadConfig(configPath);
  console.log(`Config OK: ${configPath}`);
  console.log(`Sites: ${result.sites.length}`);
  for (const site of result.sites) {
    console.log(`- ${site.id}: ${site.targetUrl} via ${site.prefix || "(root)"}${site.enabled ? "" : " (disabled)"}`);
  }
  console.log(`Bind host: ${result.bindHost}`);
  console.log(`Admin path: ${result.adminPath}`);
  console.log(`Admin username: ${result.adminUsername}`);
}

try { main(); }
catch (e) { console.error(`Config check failed: ${e.message}`); process.exit(1); }
