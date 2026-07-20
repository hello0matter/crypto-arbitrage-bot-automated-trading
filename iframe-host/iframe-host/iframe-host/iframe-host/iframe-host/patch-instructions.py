#!/usr/bin/env python3
"""
Integration patch for card_server visitor tracking

This script adds visitor tracking capabilities to the existing card_server.js
"""

TRACKING_MODULE_CODE = '''
// ========== VISITOR TRACKING MODULE (ADDED) ==========
const visitorTracking = (() => {
  const UAParser = require('ua-parser-js');

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
      is_bot: /bot|crawl|spider|scrape|slurp|mediapartners|facebookexternalhit|google|bing|yahoo|baidu/i.test(ua),
    };
  }

  function getIpInfo(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = xff || String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    return { ip, ip_forwarded: xff || null };
  }

  function generateFingerprint(req, clientFingerprint) {
    if (clientFingerprint) return clientFingerprint;
    const ua = req.headers['user-agent'] || '';
    const ip = getIpInfo(req).ip;
    const lang = req.headers['accept-language'] || '';
    const data = `${ip}|${ua}|${lang}`;
    return require('crypto').createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  function trackVisitor(req, db, params = {}) {
    const deviceInfo = parseDeviceInfo(req);
    const ipInfo = getIpInfo(req);
    const fingerprint = generateFingerprint(req, params.fingerprint);
    const now = Date.now();

    let visitor = db.visitors.find(v => v.fingerprint === fingerprint);

    if (visitor) {
      visitor.visit_count++;
      visitor.last_visit = now;
      visitor.last_ip = ipInfo.ip;
      visitor.last_user_agent = deviceInfo.user_agent;
    } else {
      visitor = {
        id: db.visitors.length + 1,
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
        webgl_vendor: params.webgl_vendor || null,
        webgl_renderer: params.webgl_renderer || null,
        total_time_spent: 0,
        page_views: 0,
        interactions: 0,
        value_score: 0,
        tags: [],
        notes: '',
      };
      db.visitors.push(visitor);
    }

    return visitor;
  }

  function trackEvent(db, visitorId, eventData) {
    const event = {
      id: db.events.length + 1,
      visitor_id: visitorId,
      timestamp: Date.now(),
      type: eventData.type,
      page: eventData.page || '/',
      data: eventData.data || {},
    };

    db.events.push(event);

    const visitor = db.visitors.find(v => v.id === visitorId);
    if (visitor) {
      if (eventData.type === 'pageview') visitor.page_views++;
      if (eventData.type === 'time_spent') visitor.total_time_spent += (eventData.data.duration || 0);
      if (['click', 'scroll', 'interact'].includes(eventData.type)) visitor.interactions++;
      visitor.value_score = calculateValueScore(visitor);
    }

    if (db.events.length > 10000) db.events = db.events.slice(-10000);
    return event;
  }

  function calculateValueScore(visitor) {
    let score = 0;
    const hoursSinceVisit = (Date.now() - visitor.last_visit) / (1000 * 60 * 60);
    if (hoursSinceVisit < 24) score += 20;
    else if (hoursSinceVisit < 168) score += 10;
    else score += 5;

    if (visitor.visit_count >= 10) score += 20;
    else if (visitor.visit_count >= 5) score += 15;
    else if (visitor.visit_count >= 2) score += 10;
    else score += 5;

    const minutesSpent = visitor.total_time_spent / (1000 * 60);
    if (minutesSpent >= 30) score += 20;
    else if (minutesSpent >= 10) score += 15;
    else if (minutesSpent >= 3) score += 10;
    else score += 5;

    if (visitor.interactions >= 50) score += 20;
    else if (visitor.interactions >= 20) score += 15;
    else if (visitor.interactions >= 5) score += 10;
    else score += 5;

    if (visitor.page_views >= 20) score += 20;
    else if (visitor.page_views >= 10) score += 15;
    else if (visitor.page_views >= 3) score += 10;
    else score += 5;

    if (visitor.is_bot) score = Math.floor(score * 0.1);
    return Math.min(100, score);
  }

  function getAnalyticsSummary(db) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const last24h = db.visitors.filter(v => now - v.last_visit < day);
    const last7d = db.visitors.filter(v => now - v.last_visit < 7 * day);

    const deviceTypes = {};
    const browsers = {};
    const oses = {};

    db.visitors.forEach(v => {
      const type = v.device_type || 'desktop';
      deviceTypes[type] = (deviceTypes[type] || 0) + 1;
      const browser = v.browser || 'Unknown';
      browsers[browser] = (browsers[browser] || 0) + 1;
      const os = v.os || 'Unknown';
      oses[os] = (oses[os] || 0) + 1;
    });

    const highValue = db.visitors.filter(v => v.value_score >= 70).length;
    const mediumValue = db.visitors.filter(v => v.value_score >= 40 && v.value_score < 70).length;
    const lowValue = db.visitors.filter(v => v.value_score < 40).length;

    return {
      total_visitors: db.visitors.length,
      unique_visitors_24h: last24h.length,
      unique_visitors_7d: last7d.length,
      total_events: db.events.length,
      device_types: deviceTypes,
      browsers: browsers,
      operating_systems: oses,
      value_distribution: { high: highValue, medium: mediumValue, low: lowValue },
      avg_time_per_visitor: db.visitors.length > 0
        ? Math.round(db.visitors.reduce((sum, v) => sum + v.total_time_spent, 0) / db.visitors.length / 1000)
        : 0,
      avg_page_views: db.visitors.length > 0
        ? Math.round(db.visitors.reduce((sum, v) => sum + v.page_views, 0) / db.visitors.length * 10) / 10
        : 0,
    };
  }

  return { trackVisitor, trackEvent, getAnalyticsSummary };
})();
// ========== END VISITOR TRACKING MODULE ==========
'''

API_ROUTES_CODE = '''
  // Visitor tracking API endpoint
  if (req.method === 'POST' && url.pathname === '/api/track') {
    const body = await readBody(req);
    const params = parseBody(req, body);

    // Track visitor
    const visitor = visitorTracking.trackVisitor(req, db, params.data || {});

    // Track event
    if (params.type) {
      visitorTracking.trackEvent(db, visitor.id, {
        type: params.type,
        page: params.page || '/',
        data: params.data || {},
      });
    }

    saveDb();
    return sendJson(res, 200, { ok: true, visitor_id: visitor.id });
  }

  // Admin API: Get analytics summary
  if (req.method === 'GET' && url.pathname === '/admin/api/analytics/summary') {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });

    const summary = visitorTracking.getAnalyticsSummary(db);
    return sendJson(res, 200, { ok: true, data: summary });
  }

  // Admin API: Get visitors list
  if (req.method === 'GET' && url.pathname === '/admin/api/visitors') {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });

    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const sortBy = url.searchParams.get('sort') || 'last_visit';
    const order = url.searchParams.get('order') || 'desc';

    let visitors = db.visitors.slice().sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });

    const total = visitors.length;
    const start = (page - 1) * limit;
    visitors = visitors.slice(start, start + limit);

    return sendJson(res, 200, { ok: true, data: visitors, total, page, limit });
  }

  // Admin API: Get visitor details
  if (req.method === 'GET' && url.pathname.startsWith('/admin/api/visitors/')) {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });

    const visitorId = parseInt(url.pathname.split('/').pop());
    const visitor = db.visitors.find(v => v.id === visitorId);
    if (!visitor) return sendJson(res, 404, { ok: false, message: 'visitor not found' });

    const events = db.events.filter(e => e.visitor_id === visitorId).slice(-200);

    return sendJson(res, 200, { ok: true, data: { visitor, events } });
  }
'''

DB_INIT_CODE = '''
  // Initialize visitor tracking tables if not exist
  if (!db.visitors) db.visitors = [];
  if (!db.events) db.events = [];
'''

print("Integration code generated.")
print("\nTo apply this patch:")
print("1. Install ua-parser-js: npm install ua-parser-js")
print("2. Add TRACKING_MODULE_CODE after the existing requires")
print("3. Add DB_INIT_CODE in loadDb() function")
print("4. Add API_ROUTES_CODE in route() function before the 404 handler")
print("5. Add visitor-tracking-client.js to admin.html <head>")
