#!/usr/bin/env python3
"""
Add advanced analytics features to both systems:
1. IP Geolocation (using free IP-API.com)
2. Data export (CSV/JSON)
3. Visitor tagging system
4. Advanced filtering
5. Real-time online visitors
6. Retention analysis
"""

import paramiko
import sys

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"

# Enhanced tracking module with geolocation
GEOLOCATION_FEATURE = """
// ========== IP GEOLOCATION FEATURE ==========
const https = require('https');

// Cache for IP geolocation results
const geoCache = new Map();
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get geolocation for IP address
 * Uses ip-api.com free tier (45 requests/minute)
 */
async function getGeoLocation(ip) {
  // Check cache first
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.timestamp < GEO_CACHE_TTL) {
    return cached.data;
  }

  // Skip private/local IPs
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return null;
  }

  try {
    const url = `http://ip-api.com/json/${ip}?fields=status,country,countryCode,region,regionName,city,timezone,isp`;

    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const geo = JSON.parse(data);
            if (geo.status === 'success') {
              const result = {
                country: geo.country,
                country_code: geo.countryCode,
                region: geo.regionName,
                city: geo.city,
                timezone: geo.timezone,
                isp: geo.isp,
              };
              // Cache the result
              geoCache.set(ip, { data: result, timestamp: Date.now() });
              resolve(result);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(null);
      });
    });
  } catch (e) {
    return null;
  }
}

// Update trackVisitor to include geolocation
const originalTrackVisitor = visitorTracking.trackVisitor;
visitorTracking.trackVisitor = async function(req, db, params = {}) {
  const visitor = originalTrackVisitor(req, db, params);

  // Fetch geolocation asynchronously (don't block)
  if (visitor.ip && !visitor.geo_country) {
    getGeoLocation(visitor.ip).then(geo => {
      if (geo) {
        visitor.geo_country = geo.country;
        visitor.geo_country_code = geo.country_code;
        visitor.geo_region = geo.region;
        visitor.geo_city = geo.city;
        visitor.geo_timezone = geo.timezone;
        visitor.geo_isp = geo.isp;
        // Save updated visitor data
        if (typeof saveDb === 'function') saveDb();
      }
    }).catch(() => {});
  }

  return visitor;
};
// ========== END GEOLOCATION FEATURE ==========
"""

# Data export API endpoints
EXPORT_APIS = """
  // Export visitors to CSV
  app.get(`${adminBase}/api/export/visitors.csv`, ensureAuth, (req, res) => {
    try {
      const visitors = visitorTracking ? (db.visitors || []) : [];

      // CSV header
      let csv = 'ID,Fingerprint,Value Score,Visit Count,First Visit,Last Visit,Device Type,Browser,OS,Country,City,IP,Total Time (s),Page Views,Interactions\\n';

      // CSV rows
      visitors.forEach(v => {
        const row = [
          v.id,
          v.fingerprint,
          v.value_score || 0,
          v.visit_count || 0,
          new Date(v.first_visit).toISOString(),
          new Date(v.last_visit).toISOString(),
          v.device_type || '',
          v.browser || '',
          v.os || '',
          v.geo_country || '',
          v.geo_city || '',
          v.ip || '',
          Math.round((v.total_time_spent || 0) / 1000),
          v.page_views || 0,
          v.interactions || 0,
        ].map(field => {
          const str = String(field).replace(/"/g, '""');
          return `"${str}"`;
        });
        csv += row.join(',') + '\\n';
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="visitors-${Date.now()}.csv"`);
      res.send(csv);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Export analytics summary to JSON
  app.get(`${adminBase}/api/export/analytics.json`, ensureAuth, (req, res) => {
    try {
      const summary = visitorTracking ? visitorTracking.getAnalyticsSummary() : {};
      const data = {
        exported_at: new Date().toISOString(),
        summary: summary,
        visitors: db.visitors || [],
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="analytics-${Date.now()}.json"`);
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Tag management APIs
  app.post(`${adminBase}/api/visitors/:id/tag`, ensureAuth, json, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const visitor = db.visitors.find(v => v.id === id);
      if (!visitor) return res.status(404).json({ ok: false, message: 'visitor not found' });

      const tag = req.body.tag;
      if (!tag || typeof tag !== 'string') {
        return res.status(400).json({ ok: false, message: 'tag required' });
      }

      if (!visitor.tags) visitor.tags = [];
      if (!visitor.tags.includes(tag)) {
        visitor.tags.push(tag);
        saveDb();
      }

      res.json({ ok: true, tags: visitor.tags });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  app.delete(`${adminBase}/api/visitors/:id/tag`, ensureAuth, json, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const visitor = db.visitors.find(v => v.id === id);
      if (!visitor) return res.status(404).json({ ok: false, message: 'visitor not found' });

      const tag = req.body.tag;
      if (visitor.tags && visitor.tags.includes(tag)) {
        visitor.tags = visitor.tags.filter(t => t !== tag);
        saveDb();
      }

      res.json({ ok: true, tags: visitor.tags });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Real-time online visitors (active in last 5 minutes)
  app.get(`${adminBase}/api/visitors/online`, ensureAuth, (req, res) => {
    try {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      const online = (db.visitors || []).filter(v => v.last_visit > fiveMinutesAgo);
      res.json({ ok: true, count: online.length, visitors: online });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Geographic distribution
  app.get(`${adminBase}/api/analytics/geo`, ensureAuth, (req, res) => {
    try {
      const countries = {};
      const cities = {};

      (db.visitors || []).forEach(v => {
        if (v.geo_country) {
          countries[v.geo_country] = (countries[v.geo_country] || 0) + 1;
        }
        if (v.geo_city) {
          const key = `${v.geo_city}, ${v.geo_country || ''}`;
          cities[key] = (cities[key] || 0) + 1;
        }
      });

      res.json({
        ok: true,
        countries: countries,
        cities: cities,
        top_countries: Object.entries(countries)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([country, count]) => ({ country, count })),
        top_cities: Object.entries(cities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([city, count]) => ({ city, count })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Retention analysis (returning visitors)
  app.get(`${adminBase}/api/analytics/retention`, ensureAuth, (req, res) => {
    try {
      const visitors = db.visitors || [];
      const total = visitors.length;
      const returning = visitors.filter(v => v.visit_count > 1).length;
      const oneTime = total - returning;

      // Group by visit count
      const visitGroups = {
        '1': 0,
        '2-5': 0,
        '6-10': 0,
        '11-20': 0,
        '20+': 0,
      };

      visitors.forEach(v => {
        const count = v.visit_count || 1;
        if (count === 1) visitGroups['1']++;
        else if (count <= 5) visitGroups['2-5']++;
        else if (count <= 10) visitGroups['6-10']++;
        else if (count <= 20) visitGroups['11-20']++;
        else visitGroups['20+']++;
      });

      res.json({
        ok: true,
        total_visitors: total,
        returning_visitors: returning,
        one_time_visitors: oneTime,
        retention_rate: total > 0 ? (returning / total * 100).toFixed(2) + '%' : '0%',
        visit_distribution: visitGroups,
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });
"""

def deploy_to_card_server():
    print('\\n' + '='*60)
    print('Deploying to card_server...')
    print('='*60)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        REMOTE_DIR = '/root/card_server'

        print('[1/3] Reading server.js...')
        sftp = client.open_sftp()
        with sftp.file(f'{REMOTE_DIR}/server.js', 'r') as f:
            server_js = f.read().decode('utf-8')

        if 'getGeoLocation' in server_js:
            print('Already has geolocation')
        else:
            print('[2/3] Adding features...')
            # Insert geolocation after tracking module
            server_js = server_js.replace(
                '// ========== END VISITOR TRACKING MODULE ==========',
                '// ========== END VISITOR TRACKING MODULE ==========\\n' + GEOLOCATION_FEATURE
            )

            # Add export APIs before 404 handler
            server_js = server_js.replace(
                '  return sendJson(res, 404, { ok: false, message: \\'not found\\' });',
                EXPORT_APIS + '\\n  return sendJson(res, 404, { ok: false, message: \\'not found\\' });'
            )

            print('[3/3] Uploading...')
            with sftp.file(f'{REMOTE_DIR}/server.js', 'w') as f:
                f.write(server_js.encode('utf-8'))

            # Restart
            client.exec_command('pm2 restart card_server')
            print('OK card_server updated')

        sftp.close()
    finally:
        client.close()

def deploy_to_iframe_host():
    print('\\n' + '='*60)
    print('Deploying to iframe-host...')
    print('='*60)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        REMOTE_DIR = '/opt/iframe-host'

        print('[1/3] Reading server.js...')
        sftp = client.open_sftp()
        with sftp.file(f'{REMOTE_DIR}/server.js', 'r') as f:
            server_js = f.read().decode('utf-8')

        if 'getGeoLocation' in server_js:
            print('Already has geolocation')
        else:
            print('[2/3] Adding features...')
            # Insert after tracking module
            server_js = server_js.replace(
                '// ========== END VISITOR TRACKING MODULE ==========',
                '// ========== END VISITOR TRACKING MODULE ==========\\n' + GEOLOCATION_FEATURE
            )

            # Add export APIs (adapt to Express)
            export_apis_express = EXPORT_APIS.replace('ensureAuth', 'requireAuth').replace('json', 'express.json()')

            # Find where admin routes end
            import re
            match = re.search(r'(app\\.get\\(`\\$\\{adminBase\\}/api/visitors/:\\d+`.*?\\}\\);)', server_js, re.DOTALL)
            if match:
                pos = match.end()
                server_js = server_js[:pos] + '\\n' + export_apis_express + server_js[pos:]

            print('[3/3] Uploading...')
            with sftp.file(f'{REMOTE_DIR}/server.js', 'w') as f:
                f.write(server_js.encode('utf-8'))

            # Restart
            client.exec_command('systemctl restart iframe-host')
            print('OK iframe-host updated')

        sftp.close()
    finally:
        client.close()

def main():
    print('='*60)
    print('Adding Advanced Analytics Features')
    print('='*60)
    print('\\nFeatures:')
    print('  - IP Geolocation (country, city, ISP)')
    print('  - CSV/JSON data export')
    print('  - Visitor tagging system')
    print('  - Real-time online visitors')
    print('  - Geographic distribution')
    print('  - Retention analysis')

    try:
        deploy_to_card_server()
        deploy_to_iframe_host()

        print('\\n' + '='*60)
        print('Deployment Complete!')
        print('='*60)
        print('\\nNew API endpoints:')
        print('  GET /admin/api/export/visitors.csv')
        print('  GET /admin/api/export/analytics.json')
        print('  POST /admin/api/visitors/:id/tag')
        print('  DELETE /admin/api/visitors/:id/tag')
        print('  GET /admin/api/visitors/online')
        print('  GET /admin/api/analytics/geo')
        print('  GET /admin/api/analytics/retention')

    except Exception as e:
        print(f'\\nERROR: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
