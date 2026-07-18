#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

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

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return port;
}

function loadConfig(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const config = JSON.parse(raw);
  const targetUrl = parseHttpsUrl(config.target_url, "target_url");

  if (!Array.isArray(config.allowed_origins) || config.allowed_origins.length === 0) {
    throw new Error("allowed_origins must contain at least one HTTPS origin");
  }

  const allowedOrigins = [...new Set(
    config.allowed_origins.map((item) => parseHttpsUrl(item, "allowed_origins item").origin),
  )];

  if (!allowedOrigins.includes(targetUrl.origin)) {
    throw new Error("target_url origin must be listed in allowed_origins");
  }

  const bindHost = config.bind_host || "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(bindHost)) {
    throw new Error("bind_host must be 127.0.0.1, ::1, or 0.0.0.0");
  }

  parsePort(config.port || 3030);

  return {
    allowedOrigins,
    bindHost,
    targetUrl: targetUrl.toString(),
  };
}

function main() {
  const input = process.argv[2] || "config.json";
  const configPath = path.resolve(process.cwd(), input);

  if (!fs.existsSync(configPath)) {
    throw new Error(`configuration file not found: ${configPath}`);
  }

  const result = loadConfig(configPath);
  console.log(`Config OK: ${configPath}`);
  console.log(`Target: ${result.targetUrl}`);
  console.log(`Allowed origins: ${result.allowedOrigins.join(", ")}`);
  console.log(`Bind host: ${result.bindHost}`);
}

try {
  main();
} catch (error) {
  console.error(`Config check failed: ${error.message}`);
  process.exit(1);
}
