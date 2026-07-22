#!/usr/bin/env node

const assert = require("assert");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const SERVER_SOURCE = path.join(ROOT, "server_fixed.js");
const ADMIN_SOURCE = path.join(ROOT, "admin_live.html");
const HOST_DIR = path.join(ROOT, "iframe-host");
const dependencies = path.join(HOST_DIR, "node_modules");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iframe-host-multisite-"));
const tlsDir = path.join(tmp, "tls");
const tlsKeyPath = path.join(tlsDir, "key.pem");
const tlsCertPath = path.join(tlsDir, "cert.pem");
const adminPath = path.join(tmp, "public");
const configPath = path.join(tmp, "config.json");
const visitorPath = path.join(tmp, "visitors.json");
const auditPath = path.join(tmp, "audit-logs");
const proxyPort = 18480 + Math.floor(Math.random() * 1000);
const upstreamOnePort = proxyPort + 1;
const upstreamTwoPort = proxyPort + 2;
const password = "test-password-123";
let proxy;
let upstreamOne;
let upstreamTwo;

function listen(server, port) {
  return new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
}

function createTlsUpstream(port, handler) {
  const server = https.createServer({ key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) }, (req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const result = handler({ method: req.method, url: req.url, body: Buffer.concat(chunks) });
      const responseBody = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body || "");
      res.writeHead(result.status || 200, { "content-type": result.contentType || "text/plain", "content-length": responseBody.length });
      res.end(responseBody);
    });
  });
  return { server, port };
}

function close(server) {
  return new Promise(resolve => server ? server.close(resolve) : resolve());
}

function stopProcess(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.killed) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

async function waitForServer(url, getOutput = () => "") {
  let lastError;
  for (let i = 0; i < 40; i++) {
    try {
      const result = await request(url);
      if (result.response.status < 500) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const detail = getOutput().trim();
  throw new Error(`${lastError?.message || "proxy did not start"}${detail ? `\nProxy output:\n${detail}` : ""}`);
}

function apiUrl(pathname) {
  return `http://127.0.0.1:${proxyPort}/admin${pathname}`;
}

async function api(pathname, token, options = {}) {
  const result = await request(apiUrl(pathname), {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  assert.ok(result.response.ok, `${options.method || "GET"} ${pathname}: ${result.response.status} ${result.text}`);
  return result.json;
}

async function main() {
  fs.mkdirSync(adminPath, { recursive: true });
  fs.mkdirSync(tlsDir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tlsKeyPath, "-out", tlsCertPath, "-subj", "/CN=127.0.0.1", "-days", "1"], { stdio: "ignore" });
  fs.copyFileSync(SERVER_SOURCE, path.join(tmp, "server.js"));
  fs.copyFileSync(ADMIN_SOURCE, path.join(adminPath, "admin.html"));
  fs.cpSync(dependencies, path.join(tmp, "node_modules"), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    target_url: `https://127.0.0.1:${upstreamOnePort}/`,
    proxy_prefix: "/one",
    port: proxyPort,
    bind_host: "127.0.0.1",
    admin_path: "admin",
    admin_username: "admin",
    admin_password: password,
    replace_rules: [],
    oauth_bypass_paths: [],
    rewrite_request_headers: true,
  }, null, 2));

  upstreamOne = createTlsUpstream(upstreamOnePort, request => {
    if (request.url === "/binary") {
      return { contentType: "application/octet-stream", body: Buffer.alloc(8192, 7) };
    }
    if (request.url === "/large") {
      return { contentType: "text/plain", body: "x".repeat(1024 * 1024 + 1) };
    }
    if (request.url === "/submit" && request.method === "POST") {
      return { status: 201, contentType: "application/json", body: JSON.stringify({ from: "one", body: request.body.toString("utf8") }) };
    }
    return { contentType: "text/plain", body: "one:" + request.url };
  });
  upstreamTwo = createTlsUpstream(upstreamTwoPort, request => ({ contentType: "text/plain", body: "two:" + request.url }));

  await listen(upstreamOne.server, upstreamOne.port);
  await listen(upstreamTwo.server, upstreamTwo.port);
  proxy = spawn(process.execPath, ["server.js"], {
    cwd: tmp,
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0", CONFIG_FILE: configPath, VISITOR_DATA_FILE: visitorPath, AUDIT_LOG_DIR: auditPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  proxy.stdout.on("data", chunk => { serverOutput += chunk; });
  proxy.stderr.on("data", chunk => { serverOutput += chunk; });

  await waitForServer(apiUrl("/"), () => serverOutput);
  const migrationBackups = fs.readdirSync(tmp).filter(name => /^config\.json\.legacy-\d+\.bak$/.test(name));
  assert.strictEqual(migrationBackups.length, 1, "legacy configuration backup was not created");
  const migrated = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.strictEqual(migrated.version, 2);
  assert.strictEqual(migrated.sites.length, 1);
  assert.strictEqual(migrated.sites[0].id, "default");

  const login = await request(apiUrl("/api/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  assert.strictEqual(login.response.status, 200, login.text);
  const token = login.json.token;
  assert.ok(token);

  const added = await api("/api/sites", token, { method: "POST", body: JSON.stringify({
    id: "two", name: "Second site", enabled: true, target_url: `https://127.0.0.1:${upstreamTwoPort}/`, proxy_prefix: "/two",
    replace_rules: [], oauth_bypass_paths: [], rewrite_request_headers: true, audit_probe: { enabled: false },
  }) });
  assert.strictEqual(added.site.id, "two");
  const duplicate = await request(apiUrl("/api/sites"), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "conflict", name: "Conflict", target_url: `https://127.0.0.1:${upstreamTwoPort}/`, proxy_prefix: "/two" }) });
  assert.strictEqual(duplicate.response.status, 400);

  const routeOne = await request(`http://127.0.0.1:${proxyPort}/one/hello?x=1`);
  const routeTwo = await request(`http://127.0.0.1:${proxyPort}/two/hello?x=1`);
  assert.strictEqual(routeOne.text, "one:/hello?x=1");
  assert.strictEqual(routeTwo.text, "two:/hello?x=1");

  const beforeAudit = await api("/api/sites/default/audit-logs", token);
  assert.strictEqual(beforeAudit.total, 0);
  await api("/api/sites/default", token, { method: "PUT", body: JSON.stringify({ audit_probe: { enabled: true } }) });
  const submitted = await request(`http://127.0.0.1:${proxyPort}/one/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "audit-body" }) });
  assert.strictEqual(submitted.response.status, 201);
  assert.strictEqual(submitted.json.body, '{"secret":"audit-body"}');
  await request(`http://127.0.0.1:${proxyPort}/one/large`);
  await request(`http://127.0.0.1:${proxyPort}/one/binary`);

  const auditList = await api("/api/sites/default/audit-logs?limit=20", token);
  assert.strictEqual(auditList.total, 3);
  assert.ok(auditList.data.every(row => row.request.body === undefined && row.response.body === undefined));
  const submitAudit = auditList.data.find(row => row.request.path === "/submit");
  const largeAudit = auditList.data.find(row => row.request.path === "/large");
  const binaryAudit = auditList.data.find(row => row.request.path === "/binary");
  assert.ok(submitAudit && largeAudit && binaryAudit);
  const detail = await api(`/api/sites/default/audit-logs/${submitAudit.id}`, token);
  assert.strictEqual(detail.data.request.body, '{"secret":"audit-body"}');
  assert.ok(detail.data.response.body.includes("audit-body"));
  const largeDetail = await api(`/api/sites/default/audit-logs/${largeAudit.id}`, token);
  assert.strictEqual(largeDetail.data.response.truncated, true);
  const binaryDetail = await api(`/api/sites/default/audit-logs/${binaryAudit.id}`, token);
  assert.strictEqual(binaryDetail.data.response.truncated, true);
  assert.ok(binaryDetail.data.response.sample_base64);

  const tracked = await request(apiUrl("/api/track"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ site_id: "two", type: "pageview", page: "/welcome", data: { fingerprint: "site-two-visitor" } }) });
  assert.strictEqual(tracked.response.status, 200, tracked.text);
  const analyticsOne = await api("/api/sites/default/analytics/summary", token);
  const analyticsTwo = await api("/api/sites/two/analytics/summary", token);
  assert.strictEqual(analyticsOne.data.total_visitors, 0);
  assert.strictEqual(analyticsTwo.data.total_visitors, 1);

  const badClear = await request(apiUrl("/api/sites/default/audit-logs"), { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "CLEAR no" }) });
  assert.strictEqual(badClear.response.status, 400);
  const cleared = await api("/api/sites/default/audit-logs", token, { method: "DELETE", body: JSON.stringify({ confirm: "CLEAR default" }) });
  assert.strictEqual(cleared.removed, 3);
  assert.strictEqual((await api("/api/sites/default/audit-logs", token)).total, 0);

  const disabled = await api("/api/sites/two", token, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  assert.strictEqual(disabled.site.enabled, false);
  const disabledRoute = await request(`http://127.0.0.1:${proxyPort}/two/hello`);
  assert.strictEqual(disabledRoute.response.status, 404);

  console.log("PASS: legacy migration, site CRUD, route isolation, analytics isolation, audit capture boundaries, and clear confirmation.");
  if (serverOutput.includes("Audit log write failed")) throw new Error(serverOutput);
}

main().catch(error => {
  console.error("FAIL:", error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  await stopProcess(proxy);
  await close(upstreamOne?.server);
  await close(upstreamTwo?.server);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
