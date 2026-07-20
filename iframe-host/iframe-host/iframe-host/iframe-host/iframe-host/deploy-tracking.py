#!/usr/bin/env python3
"""
Automated deployment script for visitor tracking enhancement
Integrates tracking module into card_server
"""

import paramiko
import sys
import re

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/root/card_server"

def exec_cmd(client, cmd):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
    return stdout.read().decode('utf-8', errors='ignore'), stderr.read().decode('utf-8', errors='ignore')

def main():
    print("=" * 60)
    print("Card Server Visitor Tracking Enhancement Deployment")
    print("=" * 60)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        # Step 1: Install ua-parser-js
        print("\n[1/6] Installing ua-parser-js...")
        out, err = exec_cmd(client, f"cd {REMOTE_DIR} && npm install ua-parser-js")
        if "added" in out or "up to date" in out:
            print("OK ua-parser-js installed")
        else:
            print(f"Output: {out}")

        # Step 2: Backup current files
        print("\n[2/6] Backing up current files...")
        exec_cmd(client, f"cp {REMOTE_DIR}/server.js {REMOTE_DIR}/server.js.backup-$(date +%Y%m%d-%H%M%S)")
        exec_cmd(client, f"cp {REMOTE_DIR}/public/admin.html {REMOTE_DIR}/public/admin.html.backup-$(date +%Y%m%d-%H%M%S)")
        print("OK Backups created")

        # Step 3: Upload tracking module
        print("\n[3/6] Uploading visitor tracking module...")
        sftp = client.open_sftp()

        # Upload client tracking script
        try:
            sftp.put('visitor-tracking-client.js', f'{REMOTE_DIR}/public/visitor-tracking-client.js')
            print("OK Client tracking script uploaded")
        except FileNotFoundError:
            print("ERROR: visitor-tracking-client.js not found locally")
            return

        sftp.close()

        # Step 4: Read current server.js
        print("\n[4/6] Reading current server.js...")
        sftp = client.open_sftp()
        with sftp.file(f'{REMOTE_DIR}/server.js', 'r') as f:
            server_js = f.read().decode('utf-8')
        sftp.close()
        print(f"OK Read {len(server_js)} bytes")

        # Step 5: Inject tracking code
        print("\n[5/6] Injecting tracking code...")

        # Check if already patched
        if 'visitorTracking' in server_js:
            print("NOTICE: Server already patched with visitor tracking")
            print("Skipping injection...")
        else:
            # Find insertion points
            # Insert tracking module after const { URL } = require('url');
            tracking_module = open('visitor-tracking.js').read()

            # Extract just the module content (skip module.exports)
            tracking_code = '''
// ========== VISITOR TRACKING MODULE ==========
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
    } else {
      visitor = {
        id: db.visitors.length + 1, fingerprint, first_visit: now, last_visit: now, visit_count: 1,
        ...deviceInfo, ...ipInfo, last_ip: ipInfo.ip,
        screen_width: params.screen_width || null, screen_height: params.screen_height || null,
        screen_color_depth: params.screen_color_depth || null, timezone: params.timezone || null,
        timezone_offset: params.timezone_offset || null, language: params.language || null,
        canvas_fingerprint: params.canvas_fingerprint || null,
        total_time_spent: 0, page_views: 0, interactions: 0, value_score: 0, tags: [], notes: '',
      };
      db.visitors.push(visitor);
    }
    return visitor;
  }

  function trackEvent(db, visitorId, eventData) {
    const event = { id: db.events.length + 1, visitor_id: visitorId, timestamp: Date.now(),
      type: eventData.type, page: eventData.page || '/', data: eventData.data || {} };
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

  function getAnalyticsSummary(db) {
    const now = Date.now(), day = 86400000;
    const last24h = db.visitors.filter(v => now - v.last_visit < day);
    const last7d = db.visitors.filter(v => now - v.last_visit < 7 * day);
    const deviceTypes = {}, browsers = {}, oses = {};
    db.visitors.forEach(v => {
      deviceTypes[v.device_type || 'desktop'] = (deviceTypes[v.device_type || 'desktop'] || 0) + 1;
      browsers[v.browser || 'Unknown'] = (browsers[v.browser || 'Unknown'] || 0) + 1;
      oses[v.os || 'Unknown'] = (oses[v.os || 'Unknown'] || 0) + 1;
    });
    return {
      total_visitors: db.visitors.length, unique_visitors_24h: last24h.length, unique_visitors_7d: last7d.length,
      total_events: db.events.length, device_types: deviceTypes, browsers, operating_systems: oses,
      value_distribution: { high: db.visitors.filter(v => v.value_score >= 70).length,
        medium: db.visitors.filter(v => v.value_score >= 40 && v.value_score < 70).length,
        low: db.visitors.filter(v => v.value_score < 40).length },
      avg_time_per_visitor: db.visitors.length > 0 ? Math.round(db.visitors.reduce((s,v) => s + v.total_time_spent, 0) / db.visitors.length / 1000) : 0,
      avg_page_views: db.visitors.length > 0 ? Math.round(db.visitors.reduce((s,v) => s + v.page_views, 0) / db.visitors.length * 10) / 10 : 0,
    };
  }

  return { trackVisitor, trackEvent, getAnalyticsSummary };
})();
// ========== END VISITOR TRACKING MODULE ==========
'''

            # Insert after URL require
            server_js = server_js.replace(
                "const { URL } = require('url');",
                "const { URL } = require('url');\n" + tracking_code
            )

            # Insert DB initialization in loadDb
            db_init = '''
  // Initialize visitor tracking (added)
  if (!db.visitors) db.visitors = [];
  if (!db.events) db.events = [];
'''
            # Find loadDb function and add initialization
            if 'function loadDb()' in server_js:
                server_js = server_js.replace(
                    'function loadDb() {',
                    'function loadDb() {' + db_init
                )

            # Insert API routes before 404 handler
            api_routes = '''
  // Visitor tracking API (added)
  if (req.method === 'POST' && url.pathname === '/api/track') {
    const body = await readBody(req);
    const params = parseBody(req, body);
    const visitor = visitorTracking.trackVisitor(req, db, params.data || {});
    if (params.type) visitorTracking.trackEvent(db, visitor.id, { type: params.type, page: params.page || '/', data: params.data || {} });
    saveDb();
    return sendJson(res, 200, { ok: true, visitor_id: visitor.id });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/analytics/summary') {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });
    return sendJson(res, 200, { ok: true, data: visitorTracking.getAnalyticsSummary(db) });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/visitors') {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });
    const page = parseInt(url.searchParams.get('page') || '1'), limit = parseInt(url.searchParams.get('limit') || '50');
    const sortBy = url.searchParams.get('sort') || 'last_visit', order = url.searchParams.get('order') || 'desc';
    let visitors = db.visitors.slice().sort((a,b) => order === 'desc' ? (b[sortBy] || 0) - (a[sortBy] || 0) : (a[sortBy] || 0) - (b[sortBy] || 0));
    const total = visitors.length, start = (page - 1) * limit;
    visitors = visitors.slice(start, start + limit);
    return sendJson(res, 200, { ok: true, data: visitors, total, page, limit });
  }

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
            server_js = server_js.replace(
                "return sendJson(res, 404, { ok: false, message: 'not found' });",
                api_routes + "\n  return sendJson(res, 404, { ok: false, message: 'not found' });"
            )

            # Upload modified server.js
            print("Uploading patched server.js...")
            sftp = client.open_sftp()
            with sftp.file(f'{REMOTE_DIR}/server.js', 'w') as f:
                f.write(server_js.encode('utf-8'))
            sftp.close()
            print("OK server.js patched and uploaded")

        # Step 6: Restart服务
        print("\n[6/6] Restarting card_server...")
        out, err = exec_cmd(client, "pm2 restart card_server")
        if "restarted" in out.lower() or "online" in out.lower():
            print("OK card_server restarted")
        else:
            print(f"Output: {out}")

        print("\n" + "=" * 60)
        print("Deployment Complete!")
        print("=" * 60)
        print("\nVisitor tracking features added:")
        print("  - Device fingerprinting (browser, OS, screen, canvas)")
        print("  - Behavior tracking (clicks, scrolls, time spent)")
        print("  - Visitor value scoring (0-100)")
        print("  - Analytics API endpoints")
        print("\nAPI Endpoints:")
        print("  POST /api/track - Track visitor events")
        print("  GET /admin/api/analytics/summary - Get analytics summary")
        print("  GET /admin/api/visitors - List all visitors")
        print("  GET /admin/api/visitors/:id - Get visitor details")
        print("\nNext: Update admin.html to display visitor analytics")

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        client.close()

if __name__ == "__main__":
    main()
