/**
 * Visitor Tracking Enhancement Module for card_server
 *
 * Features:
 * 1. Device fingerprinting and detailed device info
 * 2. Behavior tracking (page events, time on page, interactions)
 * 3. IP geolocation lookup
 * 4. Visitor value scoring algorithm
 * 5. Enhanced analytics API
 */

const crypto = require('crypto');
const UAParser = require('ua-parser-js'); // npm install ua-parser-js

// ========== Visitor Tracking Storage ==========
// Add to db structure: db.visitors = [], db.events = []

/**
 * Parse and extract detailed device information
 */
function parseDeviceInfo(req) {
  const ua = req.headers['user-agent'] || '';
  const parser = new UAParser(ua);
  const result = parser.getResult();

  return {
    // Basic UA info
    browser: result.browser.name || 'Unknown',
    browser_version: result.browser.version || '',
    os: result.os.name || 'Unknown',
    os_version: result.os.version || '',
    device_type: result.device.type || 'desktop',
    device_vendor: result.device.vendor || '',
    device_model: result.device.model || '',

    // Request headers
    user_agent: ua,
    accept_language: req.headers['accept-language'] || '',
    accept_encoding: req.headers['accept-encoding'] || '',

    // Additional info from headers
    platform: result.os.name || '',
    is_mobile: result.device.type === 'mobile' || result.device.type === 'tablet',
    is_bot: detectBot(ua),
  };
}

/**
 * Detect if user agent is a bot
 */
function detectBot(ua) {
  const botPatterns = [
    /bot|crawl|spider|scrape|slurp|mediapartners|facebookexternalhit/i,
    /google|bing|yahoo|baidu|yandex|duckduck/i
  ];
  return botPatterns.some(pattern => pattern.test(ua));
}

/**
 * Get IP information
 */
function getIpInfo(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');

  return {
    ip,
    ip_forwarded: xff ? xff : null,
    // Note: For geo lookup, integrate ip2region or MaxMind GeoIP2
    // geo: lookupGeo(ip), // Implement separately
  };
}

/**
 * Generate visitor fingerprint
 * Combines IP, UA, and Accept headers for basic fingerprinting
 */
function generateFingerprint(req, clientFingerprint = null) {
  if (clientFingerprint) {
    // Client provided Canvas/WebGL fingerprint
    return clientFingerprint;
  }

  // Server-side fingerprint fallback
  const ua = req.headers['user-agent'] || '';
  const ip = getIpInfo(req).ip;
  const lang = req.headers['accept-language'] || '';
  const encoding = req.headers['accept-encoding'] || '';

  const data = `${ip}|${ua}|${lang}|${encoding}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

/**
 * Create or update visitor record
 */
function trackVisitor(req, db, params = {}) {
  const deviceInfo = parseDeviceInfo(req);
  const ipInfo = getIpInfo(req);
  const fingerprint = generateFingerprint(req, params.fingerprint);

  const now = Date.now();

  // Find existing visitor
  let visitor = db.visitors.find(v => v.fingerprint === fingerprint);

  if (visitor) {
    // Update existing visitor
    visitor.visit_count++;
    visitor.last_visit = now;
    visitor.last_ip = ipInfo.ip;
    visitor.last_user_agent = deviceInfo.user_agent;

    // Update device info if changed
    if (deviceInfo.browser !== visitor.browser) {
      visitor.browser = deviceInfo.browser;
      visitor.browser_version = deviceInfo.browser_version;
    }
  } else {
    // Create new visitor
    visitor = {
      id: db.visitors.length + 1,
      fingerprint,
      first_visit: now,
      last_visit: now,
      visit_count: 1,

      // Device info
      ...deviceInfo,

      // IP info
      ...ipInfo,
      last_ip: ipInfo.ip,

      // Client-provided info (from params)
      screen_width: params.screen_width || null,
      screen_height: params.screen_height || null,
      screen_color_depth: params.screen_color_depth || null,
      timezone: params.timezone || null,
      timezone_offset: params.timezone_offset || null,
      language: params.language || null,

      // Tracking
      total_time_spent: 0, // milliseconds
      page_views: 0,
      interactions: 0,
      value_score: 0,

      // Tags
      tags: [],
      notes: '',
    };

    db.visitors.push(visitor);
  }

  return visitor;
}

/**
 * Track behavior event
 */
function trackEvent(db, visitorId, eventData) {
  const event = {
    id: db.events.length + 1,
    visitor_id: visitorId,
    timestamp: Date.now(),
    type: eventData.type, // 'pageview', 'click', 'scroll', 'focus', 'blur', 'interact'
    page: eventData.page || '/',
    data: eventData.data || {},
  };

  db.events.push(event);

  // Update visitor stats
  const visitor = db.visitors.find(v => v.id === visitorId);
  if (visitor) {
    if (eventData.type === 'pageview') {
      visitor.page_views++;
    }
    if (eventData.type === 'time_spent') {
      visitor.total_time_spent += (eventData.data.duration || 0);
    }
    if (['click', 'scroll', 'interact'].includes(eventData.type)) {
      visitor.interactions++;
    }

    // Recalculate value score
    visitor.value_score = calculateValueScore(visitor, db.events.filter(e => e.visitor_id === visitorId));
  }

  // Limit events to 10000 most recent
  if (db.events.length > 10000) {
    db.events = db.events.slice(-10000);
  }

  return event;
}

/**
 * Calculate visitor value score (0-100)
 * Higher score = more valuable visitor
 */
function calculateValueScore(visitor, events) {
  let score = 0;

  // Recency: visited in last 24h = +20, last week = +10, older = +5
  const hoursSinceVisit = (Date.now() - visitor.last_visit) / (1000 * 60 * 60);
  if (hoursSinceVisit < 24) score += 20;
  else if (hoursSinceVisit < 168) score += 10;
  else score += 5;

  // Frequency: visit_count
  if (visitor.visit_count >= 10) score += 20;
  else if (visitor.visit_count >= 5) score += 15;
  else if (visitor.visit_count >= 2) score += 10;
  else score += 5;

  // Engagement: time spent (minutes)
  const minutesSpent = visitor.total_time_spent / (1000 * 60);
  if (minutesSpent >= 30) score += 20;
  else if (minutesSpent >= 10) score += 15;
  else if (minutesSpent >= 3) score += 10;
  else score += 5;

  // Interactions: clicks, scrolls, etc
  if (visitor.interactions >= 50) score += 20;
  else if (visitor.interactions >= 20) score += 15;
  else if (visitor.interactions >= 5) score += 10;
  else score += 5;

  // Page views
  if (visitor.page_views >= 20) score += 20;
  else if (visitor.page_views >= 10) score += 15;
  else if (visitor.page_views >= 3) score += 10;
  else score += 5;

  // Bot penalty
  if (visitor.is_bot) score = Math.floor(score * 0.1);

  return Math.min(100, score);
}

/**
 * Get visitor analytics summary
 */
function getAnalyticsSummary(db) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // Time periods
  const last24h = db.visitors.filter(v => now - v.last_visit < day);
  const last7d = db.visitors.filter(v => now - v.last_visit < 7 * day);
  const last30d = db.visitors.filter(v => now - v.last_visit < 30 * day);

  // Device breakdown
  const deviceTypes = {};
  db.visitors.forEach(v => {
    const type = v.device_type || 'desktop';
    deviceTypes[type] = (deviceTypes[type] || 0) + 1;
  });

  // Browser breakdown
  const browsers = {};
  db.visitors.forEach(v => {
    const browser = v.browser || 'Unknown';
    browsers[browser] = (browsers[browser] || 0) + 1;
  });

  // OS breakdown
  const oses = {};
  db.visitors.forEach(v => {
    const os = v.os || 'Unknown';
    oses[os] = (oses[os] || 0) + 1;
  });

  // Value score distribution
  const highValue = db.visitors.filter(v => v.value_score >= 70).length;
  const mediumValue = db.visitors.filter(v => v.value_score >= 40 && v.value_score < 70).length;
  const lowValue = db.visitors.filter(v => v.value_score < 40).length;

  return {
    total_visitors: db.visitors.length,
    unique_visitors_24h: last24h.length,
    unique_visitors_7d: last7d.length,
    unique_visitors_30d: last30d.length,
    total_events: db.events.length,

    device_types: deviceTypes,
    browsers: browsers,
    operating_systems: oses,

    value_distribution: {
      high: highValue,
      medium: mediumValue,
      low: lowValue,
    },

    avg_time_per_visitor: db.visitors.length > 0
      ? Math.round(db.visitors.reduce((sum, v) => sum + v.total_time_spent, 0) / db.visitors.length / 1000)
      : 0,

    avg_page_views: db.visitors.length > 0
      ? Math.round(db.visitors.reduce((sum, v) => sum + v.page_views, 0) / db.visitors.length * 10) / 10
      : 0,
  };
}

module.exports = {
  parseDeviceInfo,
  getIpInfo,
  generateFingerprint,
  trackVisitor,
  trackEvent,
  calculateValueScore,
  getAnalyticsSummary,
};
