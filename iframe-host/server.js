#!/usr/bin/env node

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const zlib = require("zlib");
const net = require("net");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const GEOIP_CITY_DB = process.env.GEOIP_CITY_DB || "";
const geoCache = new Map();
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isPublicIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    return normalized !== "::1" && !normalized.startsWith("fe80:") &&
      !normalized.startsWith("fc") && !normalized.startsWith("fd");
  }
  return false;
}

function readMmdbValue(ip, pathParts) {
  const result = spawnSync("mmdblookup", ["--file", GEOIP_CITY_DB, "--ip", ip, ...pathParts], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 16 * 1024,
  });
  if (result.error || result.status !== 0) return "";
  const match = result.stdout.match(/^\s*("(?:[^"\\]|\\.)*")\s+</m);
  if (!match) return "";
  try { return JSON.parse(match[1]); } catch { return ""; }
}

function getLocalGeoLocation(ip) {
  if (!GEOIP_CITY_DB || !fs.existsSync(GEOIP_CITY_DB) || !isPublicIp(ip)) return null;
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL_MS) return cached.data;

  try {
    const country = readMmdbValue(ip, ["country", "names", "en"]);
    const region = readMmdbValue(ip, ["subdivisions", "0", "names", "en"]);
    const city = readMmdbValue(ip, ["city", "names", "en"]);
    const timezone = readMmdbValue(ip, ["location", "time_zone"]);
    const data = country ? {
      source: "ip_approximate",
      precision: city ? "city_or_region" : "country_or_region",
      country,
      region: region || "",
      city: city || "",
      timezone: timezone || "",
      collected_at: Date.now(),
    } : null;
    geoCache.set(ip, { data, ts: Date.now() });
    return data;
  } catch (e) {
    console.warn("Local GeoLite2 lookup failed:", e.message);
    return null;
  }
}


// ========== VISITOR TRACKING MODULE (ADDED) ==========
const UAParser = require('ua-parser-js');
const visitorTracking = (() => {
  let visitors = [];
  let events = [];
  const DATA_FILE = path.resolve(process.env.VISITOR_DATA_FILE || path.join(ROOT, 'visitors.json'));

  // Load persisted data
  function loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        visitors = (data.visitors || []).map(v => ({ ...v, site_id: v.site_id || 'default' }));
        events = (data.events || []).map(e => ({ ...e, site_id: e.site_id || 'default' }));
        console.log(`Loaded ${visitors.length} visitors, ${events.length} events`);
      }
    } catch (e) {
      console.error('Error loading visitor data:', e.message);
    }
  }

  // Save data
  function saveData() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ visitors, events }, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving visitor data:', e.message);
    }
  }

  function parseDeviceInfo(req) {
    const ua = req.headers['user-agent'] || '';
    const parser = new UAParser(ua);
    const result = parser.getResult();
    return {
      browser: result.browser.name || 'Unknown',
      browser_version: result.browser.version || '',
      os: result.os.name || 'Unknown',
      os_version: result.os.version || '',
      device_type: result.device.type || 'desktop',
      device_vendor: result.device.vendor || '',
      device_model: result.device.model || '',
      user_agent: ua,
      accept_language: req.headers['accept-language'] || '',
      platform: result.os.name || '',
      is_mobile: result.device.type === 'mobile' || result.device.type === 'tablet',
      is_bot: /bot|crawl|spider|scrape|slurp|mediapartners|google|bing|yahoo|baidu/i.test(ua),
    };
  }

  function getIpInfo(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = xff || String(req.ip || req.connection?.remoteAddress || '').replace(/^::ffff:/, '');
    return { ip, ip_forwarded: xff || null };
  }

  function generateFingerprint(req, clientFingerprint) {
    if (clientFingerprint) return clientFingerprint;
    const ua = req.headers['user-agent'] || '';
    const ipInfo = getIpInfo(req);
    const lang = req.headers['accept-language'] || '';
    return crypto.createHash('sha256').update(ipInfo.ip + '|' + ua + '|' + lang).digest('hex').substring(0, 16);
  }

  function clampNumber(value, min, max, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
  }

  function cleanText(value, maxLength = 120) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function normalizeProfile(params = {}) {
    const profile = params.profile && typeof params.profile === 'object' ? params.profile : {};
    return {
      anonymous_id: cleanText(params.anonymous_id || profile.anonymous_id, 80),
      viewport_width: clampNumber(profile.viewport_width, 1, 10000),
      viewport_height: clampNumber(profile.viewport_height, 1, 10000),
      device_pixel_ratio: clampNumber(profile.device_pixel_ratio, 0.5, 10),
      max_touch_points: clampNumber(profile.max_touch_points, 0, 50),
      connection_type: cleanText(profile.connection_type, 30),
      connection_downlink: clampNumber(profile.connection_downlink, 0, 10000),
      referrer_origin: cleanText(profile.referrer_origin, 300),
      page_title: cleanText(profile.page_title, 200),
    };
  }

  function normalizeConsent(params = {}) {
    const consent = params.consent && typeof params.consent === 'object' ? params.consent : {};
    return {
      optional_tracking: consent.optional_tracking === true,
      precise_location: consent.precise_location === true,
      location_status: ['granted', 'denied', 'unavailable', 'not_requested'].includes(consent.location_status)
        ? consent.location_status : 'not_requested',
      updated_at: Date.now(),
    };
  }

  function normalizeBrowserLocation(params = {}) {
    const location = params.location && typeof params.location === 'object' ? params.location : null;
    if (!location || location.source !== 'browser_consent') return null;
    const latitude = clampNumber(location.latitude, -90, 90);
    const longitude = clampNumber(location.longitude, -180, 180);
    if (latitude === null || longitude === null) return null;
    return {
      source: 'browser_consent',
      precision: 'rounded_1km',
      latitude: Math.round(latitude * 100) / 100,
      longitude: Math.round(longitude * 100) / 100,
      accuracy_m: clampNumber(location.accuracy_m, 0, 100000),
      collected_at: Date.now(),
    };
  }

  function trackVisitor(req, params = {}, siteId = 'default') {
    const deviceInfo = parseDeviceInfo(req);
    const ipInfo = getIpInfo(req);
    const fingerprint = generateFingerprint(req, params.fingerprint);
    const profile = normalizeProfile(params);
    const consent = normalizeConsent(params);
    const browserLocation = normalizeBrowserLocation(params);
    const ipLocation = getLocalGeoLocation(ipInfo.ip);
    const now = Date.now();

    let visitor = visitors.find(v => v.site_id === siteId && v.fingerprint === fingerprint);

    if (visitor) {
      visitor.visit_count++;
      visitor.last_visit = now;
      visitor.last_ip = ipInfo.ip;
      visitor.last_user_agent = deviceInfo.user_agent;
      visitor.profile = { ...(visitor.profile || {}), ...profile };
      visitor.consent = { ...(visitor.consent || {}), ...consent };
      if (browserLocation) visitor.geo = browserLocation;
      else if (ipLocation && visitor.geo?.source !== 'browser_consent') visitor.geo = ipLocation;
    } else {
      visitor = {
        id: visitors.length + 1,
        site_id: siteId,
        fingerprint,
        first_visit: now,
        last_visit: now,
        visit_count: 1,
        ...deviceInfo,
        ...ipInfo,
        last_ip: ipInfo.ip,
        screen_width: params.screen_width || null,
        screen_height: params.screen_height || null,
        screen_color_depth: params.screen_color_depth || null,
        timezone: params.timezone || null,
        timezone_offset: params.timezone_offset || null,
        language: params.language || null,
        canvas_fingerprint: params.canvas_fingerprint || null,
        profile,
        consent,
        geo: browserLocation || ipLocation,
        total_time_spent: 0,
        page_views: 0,
        interactions: 0,
        value_score: 0,
        tags: [],
        notes: '',
      };
      visitors.push(visitor);
    }

    saveData();
    return visitor;
  }

  function trackEvent(visitorId, eventData, siteId = 'default') {
    const type = cleanText(eventData.type, 40);
    const allowedTypes = new Set(['pageview', 'time_spent', 'click', 'scroll', 'interact', 'visibility', 'location_consent']);
    if (!allowedTypes.has(type)) return null;
    const event = {
      id: events.length + 1,
      visitor_id: visitorId,
      site_id: siteId,
      timestamp: Date.now(),
      type,
      page: cleanText(eventData.page || '/', 500) || '/',
      data: eventData.data && typeof eventData.data === 'object' ? eventData.data : {},
    };

    events.push(event);

    const visitor = visitors.find(v => v.id === visitorId);
    if (visitor) {
      if (eventData.type === 'pageview') visitor.page_views++;
      if (eventData.type === 'time_spent') visitor.total_time_spent += (eventData.data.duration || 0);
      if (['click', 'scroll', 'interact'].includes(eventData.type)) visitor.interactions++;
      visitor.value_score = calculateValueScore(visitor);
    }

    if (events.length > 10000) events = events.slice(-10000);
    saveData();
    return event;
  }

  function calculateValueScore(visitor) {
    let score = 0;
    const hoursSinceVisit = (Date.now() - visitor.last_visit) / 3600000;
    score += hoursSinceVisit < 24 ? 20 : hoursSinceVisit < 168 ? 10 : 5;
    score += visitor.visit_count >= 10 ? 20 : visitor.visit_count >= 5 ? 15 : visitor.visit_count >= 2 ? 10 : 5;
    const minutesSpent = visitor.total_time_spent / 60000;
    score += minutesSpent >= 30 ? 20 : minutesSpent >= 10 ? 15 : minutesSpent >= 3 ? 10 : 5;
    score += visitor.interactions >= 50 ? 20 : visitor.interactions >= 20 ? 15 : visitor.interactions >= 5 ? 10 : 5;
    score += visitor.page_views >= 20 ? 20 : visitor.page_views >= 10 ? 15 : visitor.page_views >= 3 ? 10 : 5;
    if (visitor.is_bot) score = Math.floor(score * 0.1);
    return Math.min(100, score);
  }

  function getAnalyticsSummary(siteId = 'default') {
    const scopedVisitors = visitors.filter(v => (v.site_id || 'default') === siteId);
    const scopedEvents = events.filter(e => (e.site_id || 'default') === siteId);
    const now = Date.now(), day = 86400000;
    const last24h = scopedVisitors.filter(v => now - v.last_visit < day);
    const last7d = scopedVisitors.filter(v => now - v.last_visit < 7 * day);
    const deviceTypes = {}, browsers = {}, oses = {}, countries = {}, consent = { optional_tracking: 0, precise_location: 0, browser_location: 0 };

    scopedVisitors.forEach(v => {
      deviceTypes[v.device_type || 'desktop'] = (deviceTypes[v.device_type || 'desktop'] || 0) + 1;
      browsers[v.browser || 'Unknown'] = (browsers[v.browser || 'Unknown'] || 0) + 1;
      oses[v.os || 'Unknown'] = (oses[v.os || 'Unknown'] || 0) + 1;
      const country = v.geo?.country || (v.geo?.source === 'browser_consent' ? 'Browser-approved location' : 'Unknown');
      countries[country] = (countries[country] || 0) + 1;
      if (v.consent?.optional_tracking) consent.optional_tracking++;
      if (v.consent?.precise_location) consent.precise_location++;
      if (v.geo?.source === 'browser_consent') consent.browser_location++;
    });

    return {
      total_visitors: scopedVisitors.length,
      unique_visitors_24h: last24h.length,
      unique_visitors_7d: last7d.length,
      total_events: scopedEvents.length,
      device_types: deviceTypes,
      browsers: browsers,
      operating_systems: oses,
      countries,
      consent,
      value_distribution: {
        high: scopedVisitors.filter(v => v.value_score >= 70).length,
        medium: scopedVisitors.filter(v => v.value_score >= 40 && v.value_score < 70).length,
        low: scopedVisitors.filter(v => v.value_score < 40).length,
      },
      avg_time_per_visitor: scopedVisitors.length > 0
        ? Math.round(scopedVisitors.reduce((s, v) => s + v.total_time_spent, 0) / scopedVisitors.length / 1000)
        : 0,
      avg_page_views: scopedVisitors.length > 0
        ? Math.round(scopedVisitors.reduce((s, v) => s + v.page_views, 0) / scopedVisitors.length * 10) / 10
        : 0,
    };
  }

  function getVisitors(siteId = 'default', page = 1, limit = 50, sortBy = 'last_visit', order = 'desc') {
    const sorted = visitors.filter(v => (v.site_id || 'default') === siteId).sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });
    const start = (page - 1) * limit;
    return {
      data: sorted.slice(start, start + limit),
      total: sorted.length,
      page,
      limit,
    };
  }

  function getVisitor(siteId = 'default', id) {
    const visitor = visitors.find(v => v.id === id && (v.site_id || 'default') === siteId);
    if (!visitor) return null;
    const visitorEvents = events.filter(e => e.visitor_id === id && (e.site_id || 'default') === siteId).slice(-200);
    return { visitor, events: visitorEvents };
  }

  loadData();
  return { trackVisitor, trackEvent, getAnalyticsSummary, getVisitors, getVisitor };
})();
// ========== END VISITOR TRACKING MODULE ==========

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

function parseSiteId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error("site id: 1-64 chars [A-Za-z0-9_-]");
  return id;
}

function parseSiteName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 120) throw new Error("site name: 1-120 characters");
  return name;
}

function parseAuditProbe(value) {
  const probe = value && typeof value === "object" ? value : {};
  return { enabled: probe.enabled === true };
}

function normalizeSite(raw, index = 0) {
  const source = raw && typeof raw === "object" ? raw : {};
  const tu = parseTargetUrl(source.target_url);
  const prefix = parseProxyPrefix(source.proxy_prefix);
  const oauthBypassPaths = Array.isArray(source.oauth_bypass_paths)
    ? source.oauth_bypass_paths.filter(p => typeof p === "string" && p.startsWith("/")) : [];
  return {
    id: parseSiteId(source.id || `site-${index + 1}`),
    name: parseSiteName(source.name || source.target_url || `Site ${index + 1}`),
    enabled: source.enabled !== false,
    targetBase: tu.toString().replace(/\/$/, ""),
    targetOrigin: tu.origin,
    proxyPrefix: prefix,
    replaceRules: parseReplaceRules(source.replace_rules),
    oauthBypassPaths,
    rewriteRequestHeaders: source.rewrite_request_headers !== false,
    auditProbe: parseAuditProbe(source.audit_probe),
  };
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const port = parseInt(String(source.port || 3030), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port: 1-65535");
  const adminPath = parseAdminPath(process.env.ADMIN_PATH || source.admin_path);
  const rawSites = Array.isArray(source.sites) && source.sites.length ? source.sites : [{
    id: "default",
    name: source.site_name || "Default site",
    enabled: true,
    target_url: source.target_url,
    proxy_prefix: process.env.PROXY_PREFIX !== undefined ? process.env.PROXY_PREFIX : source.proxy_prefix,
    replace_rules: source.replace_rules,
    oauth_bypass_paths: source.oauth_bypass_paths,
    rewrite_request_headers: source.rewrite_request_headers,
    audit_probe: source.audit_probe,
  }];
  const sites = rawSites.map(normalizeSite);
  const ids = new Set(), prefixes = new Set();
  for (const site of sites) {
    if (ids.has(site.id)) throw new Error("site ids must be unique");
    ids.add(site.id);
    if (site.proxyPrefix === `/${adminPath}` || site.proxyPrefix.startsWith(`/${adminPath}/`)) {
      throw new Error("site proxy_prefix conflicts with admin path");
    }
    if (prefixes.has(site.proxyPrefix)) throw new Error("site proxy_prefix values must be unique");
    prefixes.add(site.proxyPrefix);
  }
  if (!sites.some(site => site.enabled)) throw new Error("at least one site must be enabled");
  return {
    version: 2,
    adminPassword: parseAdminPassword(process.env.ADMIN_PASSWORD || source.admin_password),
    adminPath,
    adminUsername: parseAdminUsername(process.env.ADMIN_USERNAME || source.admin_username || "admin"),
    bindHost: process.env.BIND_HOST || source.bind_host || "0.0.0.0",
    port: parseInt(process.env.PORT || port, 10),
    sites,
    auditMaxBodyBytes: Math.max(1024, Math.min(Number(source.audit_max_body_bytes) || 1024 * 1024, 10 * 1024 * 1024)),
  };
}

function loadConfig() { return normalizeConfig(readConfigFile()); }

function serializeSite(site) {
  return {
    id: site.id, name: site.name, enabled: site.enabled,
    target_url: site.targetBase, proxy_prefix: site.proxyPrefix,
    replace_rules: site.replaceRules, oauth_bypass_paths: site.oauthBypassPaths || [],
    rewrite_request_headers: site.rewriteRequestHeaders !== false,
    audit_probe: { enabled: site.auditProbe?.enabled === true },
  };
}

function serializeConfig(c) {
  return {
    version: 2, port: c.port, bind_host: c.bindHost, admin_path: c.adminPath,
    admin_username: c.adminUsername, admin_password: c.adminPassword,
    audit_max_body_bytes: c.auditMaxBodyBytes,
    sites: c.sites.map(serializeSite),
  };
}

function writeConfig(c) {
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializeConfig(c), null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

function persistLegacyConfigMigration() {
  const raw = readConfigFile();
  if (Array.isArray(raw.sites) && raw.sites.length) return;

  // Validate the legacy input before making any persistent migration changes.
  const migrated = normalizeConfig(raw);
  const backup = `${CONFIG_FILE}.legacy-${Date.now()}.bak`;
  fs.copyFileSync(CONFIG_FILE, backup, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backup, 0o600); } catch {}
  writeConfig(migrated);
  console.log(`Migrated legacy configuration to version 2; backup: ${backup}`);
}

function loadAndMigrateConfig() {
  persistLegacyConfigMigration();
  return loadConfig();
}

function toPublicSite(site) { return serializeSite(site); }
function toPublicConfig(c) {
  return {
    version: c.version, admin_path: c.adminPath, admin_username: c.adminUsername,
    audit_max_body_bytes: c.auditMaxBodyBytes, sites: c.sites.map(toPublicSite),
  };
}

function findSiteByPrefix(config, pathname) {
  return config.sites.filter(site => site.enabled && (site.proxyPrefix === "" || pathname === site.proxyPrefix || pathname.startsWith(site.proxyPrefix + "/")))
    .sort((a, b) => b.proxyPrefix.length - a.proxyPrefix.length)[0] || null;
}

function getSite(config, siteId) {
  const id = parseSiteId(siteId);
  const site = config.sites.find(candidate => candidate.id === id);
  if (!site) throw new Error("site not found");
  return site;
}

function buildConfigWithSite(config, siteId, source) {
  const raw = serializeConfig(config);
  const index = raw.sites.findIndex(site => site.id === siteId);
  if (index < 0) throw new Error("site not found");
  raw.sites[index] = { ...raw.sites[index], ...source, id: siteId };
  return normalizeConfig(raw);
}

function siteFromRequest(config, req, res) {
  const siteId = String(req.params.siteId || "");
  try { return getSite(config, siteId); }
  catch (e) { res.status(404).json({ ok: false, message: e.message }); return null; }
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

function ensureAuth(req, res, next) {
  const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
  if (!t || !TOKENS.has(t)) return res.status(401).json({ ok: false, message: "unauthorized" });
  TOKENS.set(t, Date.now());
  res.setHeader("Cache-Control", "no-store");
  next();
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

function rewriteHtml(html, origin, prefix, rules, adminPath, siteId) {
  const trackingBase = adminPath === "admin" && prefix ? `${prefix}-admin` : `/${adminPath}`;
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

  // Inject a transparent first-party tracking script before </body> (or at end if no </body>)
  const trackScript = `<script>(function(){
    var endpoint="${trackingBase}/api/track", siteId=${JSON.stringify(siteId)}, started=Date.now(), scrollMarks={}, optionalKey="proxyOptionalTracking", locationKey="proxyLocationConsent";
    function storageGet(key){try{return localStorage.getItem(key)||'';}catch(e){return '';}}
    function storageSet(key,value){try{localStorage.setItem(key,value);}catch(e){}}
    var anonymousId=storageGet('proxyVisitorId');
    if(!anonymousId){anonymousId='v-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);storageSet('proxyVisitorId',anonymousId);}
    var optional=storageGet(optionalKey)==='yes', locationStatus=storageGet(locationKey)||'not_requested';
    function profile(){var c=navigator.connection||navigator.mozConnection||navigator.webkitConnection||{};return {anonymous_id:anonymousId,viewport_width:window.innerWidth||0,viewport_height:window.innerHeight||0,device_pixel_ratio:window.devicePixelRatio||1,max_touch_points:navigator.maxTouchPoints||0,connection_type:c.effectiveType||'',connection_downlink:c.downlink||0,referrer_origin:(function(){try{return document.referrer?new URL(document.referrer).origin:'';}catch(e){return '';}})(),page_title:document.title||''};}
    function send(type,data){data=data||{};data.fingerprint=anonymousId;data.screen_width=screen.width||0;data.screen_height=screen.height||0;data.screen_color_depth=screen.colorDepth||0;data.timezone=(Intl.DateTimeFormat().resolvedOptions().timeZone)||'';data.timezone_offset=new Date().getTimezoneOffset();data.language=navigator.language||'';data.profile=profile();data.consent={optional_tracking:optional,precise_location:locationStatus==='granted',location_status:locationStatus};fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify({site_id:siteId,type:type,page:location.href,data:data})}).catch(function(){});}
    send('pageview');
    function optionalEvent(type,data){if(optional)send(type,data);}
    window.addEventListener('scroll',function(){var max=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)-window.innerHeight;if(max<=0)return;var percent=Math.min(100,Math.floor(window.scrollY/max*100));[25,50,75,100].forEach(function(mark){if(percent>=mark&&!scrollMarks[mark]){scrollMarks[mark]=true;optionalEvent('scroll',{depth:mark});}});},{passive:true});
    document.addEventListener('visibilitychange',function(){optionalEvent('visibility',{state:document.visibilityState});});
    window.addEventListener('pagehide',function(){optionalEvent('time_spent',{duration:Math.max(0,Date.now()-started)});});
    function addNotice(){if(document.getElementById('proxy-location-notice'))return;var box=document.createElement('div');box.id='proxy-location-notice';box.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:290px;padding:12px;background:#111;color:#fff;border-radius:8px;font:13px/1.45 sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.28)';box.innerHTML='<div style="margin-bottom:8px">This site uses anonymous visit analytics. Optional location is rounded to about 1 km and only shared after approval.</div><button type="button" data-proxy-location style="margin-right:8px">Share approximate location</button><button type="button" data-proxy-optional>Allow optional analytics</button><button type="button" data-proxy-close style="float:right">×</button>';box.querySelector('[data-proxy-close]').onclick=function(){box.remove();};box.querySelector('[data-proxy-optional]').onclick=function(){optional=true;storageSet(optionalKey,'yes');send('location_consent',{choice:'optional_tracking'});box.remove();};box.querySelector('[data-proxy-location]').onclick=function(){if(!navigator.geolocation){locationStatus='unavailable';storageSet(locationKey,locationStatus);send('location_consent',{choice:locationStatus});return;}navigator.geolocation.getCurrentPosition(function(pos){locationStatus='granted';storageSet(locationKey,locationStatus);send('location_consent',{choice:locationStatus,location:{source:'browser_consent',latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy_m:pos.coords.accuracy}});box.remove();},function(){locationStatus='denied';storageSet(locationKey,locationStatus);send('location_consent',{choice:locationStatus});},{enableHighAccuracy:false,timeout:10000,maximumAge:3600000});};document.body.appendChild(box);}
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addNotice);else addNotice();
  })();</script>`;
  if (html.includes("</body>")) {
    html = html.replace(/<\/body>/i, trackScript + "</body>");
  } else {
    html += trackScript;
  }

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
  const originUrl = new URL(origin);
  const originHost = originUrl.host;
  const originHostname = originUrl.hostname;

  // Apply custom replace_rules first
  js = applyRules(js, rules);

  // Rewrite hardcoded domain checks in JS (common patterns)
  // 1. window.location.hostname === 'example.com'
  const hostPattern = new RegExp(
    `(window\\.location\\.hostname\\s*[!=]==?\\s*)(['"\`])${escapeRe(originHostname)}\\2`,
    "gi"
  );
  js = js.replace(hostPattern, `$1$2${originHostname}$2`); // Keep original for now, can be proxy domain

  // 2. window.location.host === 'example.com:443'
  const hostPortPattern = new RegExp(
    `(window\\.location\\.host\\s*[!=]==?\\s*)(['"\`])${escapeRe(originHost)}\\2`,
    "gi"
  );
  js = js.replace(hostPortPattern, `$1$2${originHost}$2`);

  // 3. Rewrite full origin URLs in string literals (but NOT in comments)
  const eo = escapeRe(origin);
  js = js.replace(new RegExp(`(['"\`])${eo}(/[^'"\\s\`]*)\\1`, "g"), `$1${prefix}$2$1`);

  // 4. Protocol-relative URLs
  const eh = escapeRe(originHost);
  js = js.replace(new RegExp(`(['"\`])//${eh}(/[^'"\\s\`]*)\\1`, "g"), `$1${prefix}$2$1`);

  return js;
}

function rewriteLocation(loc, origin, prefix) {
  if (loc.startsWith(origin)) return (prefix + loc.slice(origin.length)) || "/";
  const h = new URL(origin).host;
  const sr = "//" + h;
  if (loc.startsWith(sr + "/") || loc === sr) return (prefix + loc.slice(sr.length)) || "/";
  return loc;
}

function bufferAndRewrite(proxyRes, res, outHeaders, rewriteFn, onComplete) {
  delete outHeaders["content-length"];
  delete outHeaders["content-encoding"];
  const enc = (proxyRes.headers["content-encoding"] || "").toLowerCase();
  let body = proxyRes;
  if (enc === "gzip") body = proxyRes.pipe(zlib.createGunzip());
  else if (enc === "br") body = proxyRes.pipe(zlib.createBrotliDecompress());
  else if (enc === "deflate") body = proxyRes.pipe(zlib.createInflate());

  const chunks = [];
  body.on("data", chunk => chunks.push(chunk));
  body.on("end", () => {
    try {
      const result = Buffer.from(rewriteFn(Buffer.concat(chunks).toString("utf8")), "utf8");
      if (onComplete) onComplete(result, "rewritten_client_body");
      res.writeHead(proxyRes.statusCode, outHeaders);
      res.end(result);
    } catch {
      if (!res.headersSent) res.writeHead(502).end();
    }
  });
  body.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); });
}

function isTextContentType(contentType) {
  return /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))/.test(String(contentType || "").toLowerCase());
}

function safeAuditHeaders(headers) {
  const allowed = new Set(["accept", "content-type", "content-length", "origin", "referer", "user-agent", "x-requested-with"]);
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function createBodyCapture(contentType, maxBytes) {
  const text = isTextContentType(contentType);
  const captureLimit = text ? maxBytes : Math.min(maxBytes, 4096);
  const chunks = [];
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let captured = 0;
  return {
    write(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(data);
      bytes += data.length;
      if (captured < captureLimit) {
        const part = data.subarray(0, Math.min(data.length, captureLimit - captured));
        chunks.push(part);
        captured += part.length;
      }
    },
    finish() {
      const truncated = bytes > captureLimit;
      const result = { bytes, sha256: hash.digest("hex"), truncated, content_type: String(contentType || "") };
      if (text) result.body = Buffer.concat(chunks).toString("utf8");
      else result.sample_base64 = Buffer.concat(chunks).toString("base64");
      return result;
    },
  };
}

function createAuditStore() {
  const root = path.resolve(process.env.AUDIT_LOG_DIR || "/etc/iframe-host/audit-logs");
  function siteDir(siteId) { return path.join(root, parseSiteId(siteId)); }
  function recordFile(siteId, id) { return path.join(siteDir(siteId), `${parseAuditRecordId(id)}.json`); }
  function ensureDir(siteId) {
    const dir = siteDir(siteId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  function write(siteId, record) {
    try {
      ensureDir(siteId);
      const file = recordFile(siteId, record.id);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, file);
    } catch (e) { console.warn("Audit log write failed:", e.message); }
  }
  function readAll(siteId) {
    ensureDir(siteId);
    return fs.readdirSync(siteDir(siteId)).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)).flatMap(name => {
      try { return [JSON.parse(fs.readFileSync(path.join(siteDir(siteId), name), "utf8"))]; } catch { return []; }
    });
  }
  function list(siteId, options = {}) {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
    const status = String(options.status || "").trim();
    const method = String(options.method || "").trim().toUpperCase();
    const pathText = String(options.path || "").trim().toLowerCase();
    const rows = readAll(siteId).filter(row =>
      (!status || String(row.response?.status || "") === status) &&
      (!method || row.request?.method === method) &&
      (!pathText || String(row.request?.path || "").toLowerCase().includes(pathText))
    ).sort((a, b) => b.timestamp - a.timestamp);
    const start = (page - 1) * limit;
    return {
      data: rows.slice(start, start + limit).map(({ request, response, ...row }) => ({
        ...row,
        request: { ...request, body: undefined, sample_base64: undefined },
        response: { ...response, body: undefined, sample_base64: undefined },
      })),
      total: rows.length, page, limit, storage_bytes: storageUsage(siteId),
    };
  }
  function get(siteId, id) {
    try { return JSON.parse(fs.readFileSync(recordFile(siteId, id), "utf8")); } catch { return null; }
  }
  function remove(siteId, id) {
    try { fs.unlinkSync(recordFile(siteId, id)); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  }
  function clear(siteId) {
    let removed = 0;
    for (const name of fs.readdirSync(siteDir(siteId))) {
      if (/^[a-f0-9-]{36}\.json$/i.test(name)) { fs.unlinkSync(path.join(siteDir(siteId), name)); removed++; }
    }
    return removed;
  }
  function storageUsage(siteId) {
    try { return fs.readdirSync(siteDir(siteId)).reduce((total, name) => total + (fs.statSync(path.join(siteDir(siteId), name)).size || 0), 0); } catch { return 0; }
  }
  return { write, list, get, remove, clear, storageUsage };
}

function parseAuditRecordId(value) {
  const id = String(value || "");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("invalid audit record id");
  return id;
}

const auditStore = createAuditStore();

// ── Proxy handler ─────────────────────────────────────────────────────────────

function proxyRequest(site, req, res, upstreamPath, auditMaxBodyBytes, adminPath) {
  const config = site;
  let parsed;
  try { parsed = new URL(upstreamPath, "http://proxy.local"); }
  catch { return res.status(400).end(); }

  if (config.oauthBypassPaths && config.oauthBypassPaths.some(bypassPath => parsed.pathname === bypassPath || parsed.pathname.startsWith(bypassPath + "/"))) {
    return res.writeHead(302, { Location: config.targetBase + parsed.pathname + parsed.search }).end();
  }

  const fwdHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP.has(lowerKey) && lowerKey !== "host") fwdHeaders[key] = value;
  }
  fwdHeaders.host = new URL(config.targetOrigin).host;
  if (config.rewriteRequestHeaders) {
    if (fwdHeaders.referer && fwdHeaders.referer.includes(req.headers.host)) {
      try {
        const refUrl = new URL(fwdHeaders.referer);
        const refPath = refUrl.pathname + refUrl.search + refUrl.hash;
        const cleanPath = config.proxyPrefix && refPath.startsWith(config.proxyPrefix) ? refPath.slice(config.proxyPrefix.length) || "/" : refPath;
        fwdHeaders.referer = config.targetBase + cleanPath;
      } catch {}
    }
    if (fwdHeaders.origin && fwdHeaders.origin.includes(req.headers.host)) fwdHeaders.origin = config.targetOrigin;
  }

  const requestCapture = config.auditProbe.enabled ? createBodyCapture(req.headers["content-type"], auditMaxBodyBytes) : null;
  const startedAt = Date.now();
  const upstreamUrl = config.targetBase + parsed.pathname + parsed.search;
  let up;
  try { up = new URL(upstreamUrl); } catch { return res.status(400).end(); }
  const transport = up.protocol === "https:" ? https : http;

  const proxyReq = transport.request({ hostname: up.hostname, port: up.port || (up.protocol === "https:" ? 443 : 80), path: up.pathname + up.search, method: req.method, headers: fwdHeaders }, proxyRes => {
    const outHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      const lowerKey = key.toLowerCase();
      if (STRIP_RESPONSE.has(lowerKey)) continue;
      if (lowerKey === "location") { outHeaders[key] = rewriteLocation(value, config.targetOrigin, config.proxyPrefix); continue; }
      if (lowerKey === "set-cookie") {
        outHeaders[key] = (Array.isArray(value) ? value : [value]).map(cookie => cookie.replace(/;\s*domain=[^;]+/gi, "").replace(/;\s*samesite=[^;]+/gi, "; SameSite=Lax").replace(/;\s*\bsecure\b/gi, ""));
        continue;
      }
      outHeaders[key] = value;
    }
    outHeaders["access-control-allow-origin"] = "*";
    outHeaders["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    outHeaders["access-control-allow-headers"] = "*";
    outHeaders["access-control-expose-headers"] = "*";

    const responseContentType = proxyRes.headers["content-type"] || "";
    const finishAudit = (body, representation) => {
      if (!requestCapture) return;
      const responseCapture = createBodyCapture(responseContentType, auditMaxBodyBytes);
      responseCapture.write(body);
      auditStore.write(config.id, {
        id: crypto.randomUUID(), timestamp: Date.now(), site_id: config.id, duration_ms: Date.now() - startedAt,
        request: { method: req.method, path: parsed.pathname, query: parsed.search, headers: safeAuditHeaders(req.headers), ...requestCapture.finish() },
        response: { status: proxyRes.statusCode, headers: safeAuditHeaders(proxyRes.headers), representation, ...responseCapture.finish() },
      });
    };
    const { targetOrigin: origin, proxyPrefix: prefix, replaceRules: rules } = config;
    if (responseContentType.toLowerCase().includes("text/html")) {
      outHeaders["cache-control"] = "no-store";
      return bufferAndRewrite(proxyRes, res, outHeaders, text => rewriteHtml(text, origin, prefix, rules, adminPath, config.id), finishAudit);
    }
    if (responseContentType.toLowerCase().includes("text/css")) return bufferAndRewrite(proxyRes, res, outHeaders, text => rewriteCss(text, origin, prefix, rules), finishAudit);
    if (responseContentType.toLowerCase().includes("javascript") && rules.length > 0) return bufferAndRewrite(proxyRes, res, outHeaders, text => rewriteJs(text, origin, prefix, rules), finishAudit);

    const responseCapture = requestCapture ? createBodyCapture(responseContentType, auditMaxBodyBytes) : null;
    if (responseCapture) proxyRes.on("data", chunk => responseCapture.write(chunk));
    proxyRes.on("end", () => {
      if (!requestCapture) return;
      auditStore.write(config.id, {
        id: crypto.randomUUID(), timestamp: Date.now(), site_id: config.id, duration_ms: Date.now() - startedAt,
        request: { method: req.method, path: parsed.pathname, query: parsed.search, headers: safeAuditHeaders(req.headers), ...requestCapture.finish() },
        response: { status: proxyRes.statusCode, headers: safeAuditHeaders(proxyRes.headers), representation: "upstream_stream", ...responseCapture.finish() },
      });
    });
    res.writeHead(proxyRes.statusCode, outHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(30000, () => { proxyReq.destroy(); if (!res.headersSent) res.writeHead(504).end("timeout"); });
  proxyReq.on("error", () => { if (!res.headersSent) res.writeHead(502).end("error"); });
  if (!["GET", "HEAD"].includes(req.method)) {
    if (requestCapture) req.on("data", chunk => requestCapture.write(chunk));
    req.pipe(proxyReq);
  } else proxyReq.end();
}

// ── App setup ────────────────────────────────────────────────────────────────

function main() {
  let config = loadAndMigrateConfig();
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

  app.post(`${adminBase}/api/track`, json, (req, res) => {
    try {
      const siteId = parseSiteId(req.body?.site_id || "default");
      getSite(config, siteId);
      const visitor = visitorTracking.trackVisitor(req, req.body.data || {}, siteId);
      if (req.body.type) {
        visitorTracking.trackEvent(visitor.id, {
          type: req.body.type,
          page: req.body.page || '/',
          data: req.body.data || {},
        }, siteId);
      }
      res.json({ ok: true, visitor_id: visitor.id });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.get(`${adminBase}/api/sites/:siteId/analytics/summary`, ensureAuth, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (!site) return;
    try { res.json({ ok: true, data: visitorTracking.getAnalyticsSummary(site.id) }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get(`${adminBase}/api/sites/:siteId/visitors`, ensureAuth, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (!site) return;
    try {
      const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
      const sortBy = ['last_visit', 'first_visit', 'visit_count', 'page_views', 'value_score'].includes(req.query.sort) ? req.query.sort : 'last_visit';
      const order = req.query.order === 'asc' ? 'asc' : 'desc';
      res.json({ ok: true, ...visitorTracking.getVisitors(site.id, page, limit, sortBy, order) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get(`${adminBase}/api/sites/:siteId/visitors/:id`, ensureAuth, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (!site) return;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, message: 'invalid visitor id' });
      const result = visitorTracking.getVisitor(site.id, id);
      if (!result) return res.status(404).json({ ok: false, message: 'visitor not found' });
      res.json({ ok: true, data: result });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // Compatibility routes retain existing clients while scoping legacy analytics to default.
  app.get(`${adminBase}/api/analytics/summary`, ensureAuth, (req, res) => res.json({ ok: true, data: visitorTracking.getAnalyticsSummary('default') }));
  app.get(`${adminBase}/api/visitors`, ensureAuth, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
    res.json({ ok: true, ...visitorTracking.getVisitors('default', page, limit, req.query.sort || 'last_visit', req.query.order === 'asc' ? 'asc' : 'desc') });
  });
  app.get(`${adminBase}/api/visitors/:id`, ensureAuth, (req, res) => {
    const result = visitorTracking.getVisitor('default', parseInt(req.params.id, 10));
    if (!result) return res.status(404).json({ ok: false, message: 'visitor not found' });
    res.json({ ok: true, data: result });
  });

  app.use(`${adminBase}/api`, (req, res, next) => {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!t || !TOKENS.has(t)) return res.status(401).json({ ok: false, message: "unauthorized" });
    TOKENS.set(t, Date.now());
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get(`${adminBase}/api/config`, ensureAuth, (req, res) =>
    res.json({ ok: true, config: toPublicConfig(config) }));

  // Compatibility endpoint for older single-site administration pages.
  app.put(`${adminBase}/api/config`, ensureAuth, json, (req, res) => {
    try {
      const legacy = config.sites.find(site => site.id === "default") || config.sites[0];
      const body = req.body || {};
      const next = buildConfigWithSite(config, legacy.id, {
        target_url: body.target_url,
        proxy_prefix: body.proxy_prefix,
        replace_rules: body.replace_rules,
        oauth_bypass_paths: body.oauth_bypass_paths,
        rewrite_request_headers: body.rewrite_request_headers,
      });
      writeConfig(next);
      config = next;
      res.json({ ok: true, config: toPublicConfig(config) });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get(`${adminBase}/api/sites`, ensureAuth, (req, res) =>
    res.json({ ok: true, sites: config.sites.map(toPublicSite) }));

  app.post(`${adminBase}/api/sites`, ensureAuth, json, (req, res) => {
    try {
      const raw = serializeConfig(config);
      const source = req.body || {};
      const id = parseSiteId(source.id || `site-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`);
      if (raw.sites.some(site => site.id === id)) throw new Error("site id already exists");
      raw.sites.push({ ...source, id });
      const next = normalizeConfig(raw);
      writeConfig(next);
      config = next;
      res.status(201).json({ ok: true, site: toPublicSite(getSite(config, id)) });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get(`${adminBase}/api/sites/:siteId`, ensureAuth, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (site) res.json({ ok: true, site: toPublicSite(site) });
  });

  app.put(`${adminBase}/api/sites/:siteId`, ensureAuth, json, (req, res) => {
    try {
      const id = parseSiteId(req.params.siteId);
      const next = buildConfigWithSite(config, id, req.body || {});
      writeConfig(next);
      config = next;
      res.json({ ok: true, site: toPublicSite(getSite(config, id)) });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.delete(`${adminBase}/api/sites/:siteId`, ensureAuth, (req, res) => {
    try {
      const id = parseSiteId(req.params.siteId);
      const raw = serializeConfig(config);
      if (!raw.sites.some(site => site.id === id)) throw new Error("site not found");
      if (raw.sites.length === 1) throw new Error("cannot delete the last site");
      raw.sites = raw.sites.filter(site => site.id !== id);
      const next = normalizeConfig(raw);
      writeConfig(next);
      config = next;
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get(`${adminBase}/api/global-settings`, ensureAuth, (req, res) => res.json({ ok: true, settings: {
    admin_username: config.adminUsername, admin_path: config.adminPath, audit_max_body_bytes: config.auditMaxBodyBytes,
  } }));

  app.put(`${adminBase}/api/global-settings`, ensureAuth, json, (req, res) => {
    try {
      const body = req.body || {};
      const raw = serializeConfig(config);
      raw.admin_username = body.admin_username === undefined ? config.adminUsername : body.admin_username;
      raw.audit_max_body_bytes = body.audit_max_body_bytes === undefined ? config.auditMaxBodyBytes : body.audit_max_body_bytes;
      if (String(body.admin_password || "").trim()) raw.admin_password = body.admin_password;
      const next = normalizeConfig(raw);
      writeConfig(next);
      config = next;
      res.json({ ok: true, settings: { admin_username: config.adminUsername, admin_path: config.adminPath, audit_max_body_bytes: config.auditMaxBodyBytes } });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.get(`${adminBase}/api/sites/:siteId/audit-logs`, ensureAuth, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (!site) return;
    try { res.json({ ok: true, ...auditStore.list(site.id, req.query) }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get(`${adminBase}/api/sites/:siteId/audit-logs/:recordId`, ensureAuth, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (!site) return;
    try {
      const record = auditStore.get(site.id, req.params.recordId);
      if (!record) return res.status(404).json({ ok: false, message: "audit record not found" });
      res.json({ ok: true, data: record });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.delete(`${adminBase}/api/sites/:siteId/audit-logs/:recordId`, ensureAuth, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (!site) return;
    try {
      if (!auditStore.remove(site.id, req.params.recordId)) return res.status(404).json({ ok: false, message: "audit record not found" });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
  });

  app.delete(`${adminBase}/api/sites/:siteId/audit-logs`, ensureAuth, json, (req, res) => {
    const site = siteFromRequest(config, req, res);
    if (!site) return;
    if (req.body?.confirm !== `CLEAR ${site.id}`) return res.status(400).json({ ok: false, message: `confirmation must be CLEAR ${site.id}` });
    try { res.json({ ok: true, removed: auditStore.clear(site.id) }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // External CDN proxy: serves CSS @import and font resources on behalf of the browser.
  // The selected site's prefix is carried in the URL so nested resources remain site-scoped.
  app.get("*/--ext-cdn/", (req, res) => {
    const host = String(req.query.h || "").slice(0, 253);
    const rawPath = String(req.query.p || "/");
    const pathname = new URL(req.url, "http://proxy.local").pathname;
    const prefix = pathname.slice(0, -"/--ext-cdn/".length);
    const site = config.sites.find(candidate => candidate.enabled && candidate.proxyPrefix === prefix);
    if (!site || !host || !/^[a-z0-9.-]+$/i.test(host)) return res.status(400).end();
    let up;
    try { up = new URL("https://" + host + rawPath); } catch { return res.status(400).end(); }
    const extReq = https.request({ hostname: up.hostname, port: 443, path: up.pathname + up.search, method: "GET", headers: { "user-agent": "Mozilla/5.0", "accept": "*/*" } }, extRes => {
      const ct = (extRes.headers["content-type"] || "").toLowerCase();
      if (!ct.includes("css") && !ct.includes("font") && !ct.includes("woff") && !ct.includes("opentype")) return res.status(403).end();
      const outHeaders = { "content-type": ct, "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" };
      if (!ct.includes("css")) { res.writeHead(extRes.statusCode, outHeaders); return extRes.pipe(res); }
      const chunks = [];
      extRes.on("data", chunk => chunks.push(chunk));
      extRes.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").replace(/url\((['"]?)(https?:\/\/[^'")]+)\1\)/gi, (match, quote, value) => {
          try { const url = new URL(value); return `url(${quote}${site.proxyPrefix}/--ext-cdn/?h=${encodeURIComponent(url.host)}&p=${encodeURIComponent(url.pathname + url.search)}${quote})`; }
          catch { return match; }
        });
        res.writeHead(extRes.statusCode, outHeaders);
        res.end(text, "utf8");
      });
      extRes.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); });
    });
    extReq.setTimeout(15000, () => extReq.destroy());
    extReq.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); });
    extReq.end();
  });

  app.use((req, res) => {
    let parsed;
    try { parsed = new URL(req.url, "http://proxy.local"); }
    catch { return res.status(400).end(); }
    const site = findSiteByPrefix(config, parsed.pathname);
    if (!site) return res.status(404).end("site not found");
    const upstreamPath = site.proxyPrefix && (parsed.pathname === site.proxyPrefix || parsed.pathname.startsWith(site.proxyPrefix + "/"))
      ? (parsed.pathname.slice(site.proxyPrefix.length) || "/") + parsed.search
      : parsed.pathname + parsed.search;
    return proxyRequest(site, req, res, upstreamPath, config.auditMaxBodyBytes, config.adminPath);
  });

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`Listening ${config.bindHost}:${config.port}  sites: ${config.sites.map(site => `${site.name} (${site.proxyPrefix || "/"})`).join(", ")}  admin: ${adminBase}`);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

try { main(); } catch (e) { console.error(e.message); process.exit(1); }
