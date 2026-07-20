#!/usr/bin/env python3
"""
Add visitor tracking to iframe-host
Integrates visitor analytics with minimal changes to existing code
"""

import paramiko
import sys
import json

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/opt/iframe-host"

# Visitor tracking module code (compatible with Express)
TRACKING_MODULE = """
// ========== VISITOR TRACKING MODULE (ADDED) ==========
const UAParser = require('ua-parser-js');
const visitorTracking = (() => {
  let visitors = [];
  let events = [];
  const DATA_FILE = path.join(ROOT, 'visitors.json');

  // Load persisted data
  function loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        visitors = data.visitors || [];
        events = data.events || [];
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

  function trackVisitor(req, params = {}) {
    const deviceInfo = parseDeviceInfo(req);
    const ipInfo = getIpInfo(req);
    const fingerprint = generateFingerprint(req, params.fingerprint);
    const now = Date.now();

    let visitor = visitors.find(v => v.fingerprint === fingerprint);

    if (visitor) {
      visitor.visit_count++;
      visitor.last_visit = now;
      visitor.last_ip = ipInfo.ip;
      visitor.last_user_agent = deviceInfo.user_agent;
    } else {
      visitor = {
        id: visitors.length + 1,
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

  function trackEvent(visitorId, eventData) {
    const event = {
      id: events.length + 1,
      visitor_id: visitorId,
      timestamp: Date.now(),
      type: eventData.type,
      page: eventData.page || '/',
      data: eventData.data || {},
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

  function getAnalyticsSummary() {
    const now = Date.now(), day = 86400000;
    const last24h = visitors.filter(v => now - v.last_visit < day);
    const last7d = visitors.filter(v => now - v.last_visit < 7 * day);
    const deviceTypes = {}, browsers = {}, oses = {};

    visitors.forEach(v => {
      deviceTypes[v.device_type || 'desktop'] = (deviceTypes[v.device_type || 'desktop'] || 0) + 1;
      browsers[v.browser || 'Unknown'] = (browsers[v.browser || 'Unknown'] || 0) + 1;
      oses[v.os || 'Unknown'] = (oses[v.os || 'Unknown'] || 0) + 1;
    });

    return {
      total_visitors: visitors.length,
      unique_visitors_24h: last24h.length,
      unique_visitors_7d: last7d.length,
      total_events: events.length,
      device_types: deviceTypes,
      browsers: browsers,
      operating_systems: oses,
      value_distribution: {
        high: visitors.filter(v => v.value_score >= 70).length,
        medium: visitors.filter(v => v.value_score >= 40 && v.value_score < 70).length,
        low: visitors.filter(v => v.value_score < 40).length,
      },
      avg_time_per_visitor: visitors.length > 0
        ? Math.round(visitors.reduce((s, v) => s + v.total_time_spent, 0) / visitors.length / 1000)
        : 0,
      avg_page_views: visitors.length > 0
        ? Math.round(visitors.reduce((s, v) => s + v.page_views, 0) / visitors.length * 10) / 10
        : 0,
    };
  }

  function getVisitors(page = 1, limit = 50, sortBy = 'last_visit', order = 'desc') {
    const sorted = visitors.slice().sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });
    const start = (page - 1) * limit;
    return {
      data: sorted.slice(start, start + limit),
      total: visitors.length,
      page,
      limit,
    };
  }

  function getVisitor(id) {
    const visitor = visitors.find(v => v.id === id);
    if (!visitor) return null;
    const visitorEvents = events.filter(e => e.visitor_id === id).slice(-200);
    return { visitor, events: visitorEvents };
  }

  loadData();
  return { trackVisitor, trackEvent, getAnalyticsSummary, getVisitors, getVisitor };
})();
// ========== END VISITOR TRACKING MODULE ==========
"""

API_ROUTES = """
  // Visitor tracking API endpoints
  app.post(`${adminBase}/api/track`, json, (req, res) => {
    try {
      const visitor = visitorTracking.trackVisitor(req, req.body.data || {});
      if (req.body.type) {
        visitorTracking.trackEvent(visitor.id, {
          type: req.body.type,
          page: req.body.page || '/',
          data: req.body.data || {},
        });
      }
      res.json({ ok: true, visitor_id: visitor.id });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.get(`${adminBase}/api/analytics/summary`, ensureAuth, (req, res) => {
    try {
      const summary = visitorTracking.getAnalyticsSummary();
      res.json({ ok: true, data: summary });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.get(`${adminBase}/api/visitors`, ensureAuth, (req, res) => {
    try {
      const page = parseInt(req.query.page || '1');
      const limit = Math.min(parseInt(req.query.limit || '50'), 200);
      const sortBy = req.query.sort || 'last_visit';
      const order = req.query.order || 'desc';
      const result = visitorTracking.getVisitors(page, limit, sortBy, order);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.get(`${adminBase}/api/visitors/:id`, ensureAuth, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = visitorTracking.getVisitor(id);
      if (!result) return res.status(404).json({ ok: false, message: 'visitor not found' });
      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });
"""

def main():
    print('=' * 60)
    print('iframe-host Visitor Tracking Enhancement')
    print('=' * 60)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        # Step 1: Install ua-parser-js
        print('\n[1/5] Installing ua-parser-js...')
        stdin, stdout, stderr = client.exec_command(f'cd {REMOTE_DIR} && npm install ua-parser-js', timeout=60)
        output = stdout.read().decode('utf-8', errors='ignore')
        print('OK Installed')

        # Step 2: Backup
        print('\n[2/5] Creating backup...')
        client.exec_command(f'cp {REMOTE_DIR}/server.js {REMOTE_DIR}/server.js.bak-tracking-$(date +%Y%m%d-%H%M%S)')
        print('OK Backup created')

        # Step 3: Read current server.js
        print('\n[3/5] Reading and patching server.js...')
        sftp = client.open_sftp()
        with sftp.file(f'{REMOTE_DIR}/server.js', 'r') as f:
            server_js = f.read().decode('utf-8')

        if 'visitorTracking' in server_js:
            print('NOTICE: Already patched')
            return

        # Insert tracking module after requires
        server_js = server_js.replace(
            'const ROOT = __dirname;',
            'const ROOT = __dirname;\n' + TRACKING_MODULE
        )

        # Find where admin routes are defined and add tracking routes
        # Look for the admin base route definition
        import re
        admin_route_match = re.search(r'(app\.post\(`\$\{adminBase\}/api/login`.*?\}\);)', server_js, re.DOTALL)
        if admin_route_match:
            insert_pos = admin_route_match.end()
            server_js = server_js[:insert_pos] + '\n' + API_ROUTES + server_js[insert_pos:]
            print('  - Tracking module added')
            print('  - API routes added')
        else:
            print('ERROR: Could not find admin route insertion point')
            return

        # Step 4: Upload
        print('\n[4/5] Uploading patched server.js...')
        with sftp.file(f'{REMOTE_DIR}/server.js', 'w') as f:
            f.write(server_js.encode('utf-8'))
        sftp.close()
        print(f'OK Uploaded {len(server_js)} bytes')

        # Step 5: Restart
        print('\n[5/5] Restarting iframe-host...')
        stdin, stdout, stderr = client.exec_command('systemctl restart iframe-host')
        stdout.read()

        # Wait and check status
        import time
        time.sleep(2)
        stdin, stdout, stderr = client.exec_command('systemctl is-active iframe-host')
        status = stdout.read().decode().strip()

        if status == 'active':
            print('OK Service restarted successfully')
        else:
            print(f'WARNING: Service status: {status}')

        print('\n' + '=' * 60)
        print('Deployment Complete!')
        print('=' * 60)
        print('\nNew API endpoints added:')
        print('  POST /{admin_path}/api/track - Track visitor events')
        print('  GET /{admin_path}/api/analytics/summary - Analytics summary')
        print('  GET /{admin_path}/api/visitors - List visitors')
        print('  GET /{admin_path}/api/visitors/:id - Visitor details')
        print('\nData stored in: /opt/iframe-host/visitors.json')

    except Exception as e:
        print(f'\nERROR: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        client.close()

if __name__ == '__main__':
    main()
