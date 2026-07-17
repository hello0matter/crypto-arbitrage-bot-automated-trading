#!/usr/bin/env node

const express = require("express");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const CONFIG_FILE = path.resolve(ROOT, process.env.CONFIG_FILE || "config.json");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return port;
}

function parseHttpsUrl(value, fieldName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid HTTPS URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${fieldName} must use HTTPS`);
  }

  return url;
}

function parseAllowedOrigins(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("allowed_origins must contain at least one HTTPS origin");
  }

  const origins = value.map((item) => parseHttpsUrl(item, "allowed_origins item").origin);
  return [...new Set(origins)];
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`configuration file not found: ${CONFIG_FILE}. Copy config.example.json to config.json and edit it.`);
  }

  let fileConfig;
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    throw new Error(`could not read configuration: ${error.message}`);
  }

  const targetUrl = parseHttpsUrl(fileConfig.target_url, "target_url");
  const allowedOrigins = parseAllowedOrigins(fileConfig.allowed_origins);
  if (!allowedOrigins.includes(targetUrl.origin)) {
    throw new Error("target_url origin must be listed in allowed_origins");
  }

  const bindHost = process.env.BIND_HOST || fileConfig.bind_host || "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(bindHost)) {
    throw new Error("bind_host must be 127.0.0.1, ::1, or 0.0.0.0");
  }

  return {
    allowedOrigins,
    bindHost,
    port: parsePort(process.env.PORT || fileConfig.port || 3030),
    targetUrl: targetUrl.toString(),
    title: String(fileConfig.title || "Embedded content").slice(0, 120),
  };
}

function buildPage(config) {
  const safeTitle = escapeHtml(config.title);
  const safeUrl = escapeHtml(config.targetUrl);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; }
    body { margin: 0; background: #f5f7fa; color: #172033; }
    header { padding: 16px 24px; background: #fff; border-bottom: 1px solid #dfe5ef; }
    h1 { margin: 0; font-size: 18px; }
    p { margin: 6px 0 0; color: #53627a; font-size: 13px; }
    main { height: calc(100vh - 86px); padding: 16px; box-sizing: border-box; }
    iframe { width: 100%; height: 100%; border: 1px solid #dfe5ef; border-radius: 10px; background: #fff; }
  </style>
</head>
<body>
  <header>
    <h1>${safeTitle}</h1>
    <p>This page embeds pre-approved internal HTTPS content. It does not collect visitor analytics.</p>
  </header>
  <main>
    <iframe
      src="${safeUrl}"
      title="${safeTitle}"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"></iframe>
  </main>
</body>
</html>`;
}

function main() {
  const config = loadConfig();
  const app = express();

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; frame-src ${config.allowedOrigins.join(" ")}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
    );
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.get("/", (req, res) => {
    res.type("html").send(buildPage(config));
  });

  app.get("/healthz", (req, res) => {
    res.json({ ok: true, target_origin: new URL(config.targetUrl).origin });
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, message: "not found" });
  });

  app.listen(config.port, config.bindHost, () => {
    console.log(`Iframe host listening on http://${config.bindHost}:${config.port}`);
    console.log(`Approved target: ${config.targetUrl}`);
    console.log(`Configuration: ${CONFIG_FILE}`);
  });
}

try {
  main();
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
}
