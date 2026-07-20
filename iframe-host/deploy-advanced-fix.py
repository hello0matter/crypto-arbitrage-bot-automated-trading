#!/usr/bin/env python3
"""Add advanced analytics features to both systems"""

import paramiko
import sys

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"

# Geolocation feature code
GEO_CODE = """
// ========== IP GEOLOCATION ==========
const http = require('http');
const geoCache = new Map();

async function getGeoLocation(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) return null;
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < 86400000) return cached.data;

  try {
    const url = `http://ip-api.com/json/${ip}?fields=country,countryCode,regionName,city,timezone,isp`;
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const geo = JSON.parse(data);
            if (geo.country) {
              const result = { country: geo.country, country_code: geo.countryCode, region: geo.regionName, city: geo.city, timezone: geo.timezone, isp: geo.isp };
              geoCache.set(ip, { data: result, ts: Date.now() });
              resolve(result);
            } else resolve(null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
  } catch { return null; }
}
// ========== END GEOLOCATION ==========
"""

def deploy_card_server():
    print('\n[card_server] Deploying...')
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        sftp = client.open_sftp()
        with sftp.file('/root/card_server/server.js', 'r') as f:
            code = f.read().decode('utf-8')

        if 'getGeoLocation' in code:
            print('  Already has geolocation')
            return

        # Add geolocation
        code = code.replace(
            'const visitorTracking = (() => {',
            GEO_CODE + '\nconst visitorTracking = (() => {'
        )

        # Add export CSV endpoint
        csv_endpoint = """
  if (req.method === 'GET' && url.pathname === '/admin/api/export/visitors.csv') {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });
    let csv = 'ID,Score,Visits,Device,Browser,Country,City,IP\\n';
    (db.visitors || []).forEach(v => {
      csv += `${v.id},${v.value_score},${v.visit_count},${v.device_type},${v.browser},${v.geo_country||''},${v.geo_city||''},${v.ip}\\n`;
    });
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="visitors.csv"' });
    return end(res, 200, csv);
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/analytics/geo') {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });
    const countries = {}, cities = {};
    (db.visitors || []).forEach(v => {
      if (v.geo_country) countries[v.geo_country] = (countries[v.geo_country] || 0) + 1;
      if (v.geo_city) cities[v.geo_city] = (cities[v.geo_city] || 0) + 1;
    });
    return sendJson(res, 200, { ok: true, countries, cities });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/visitors/online') {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });
    const online = (db.visitors || []).filter(v => Date.now() - v.last_visit < 300000);
    return sendJson(res, 200, { ok: true, count: online.length, visitors: online });
  }
"""

        # Find 404 handler and insert before it
        import re
        match = re.search(r"(return sendJson\(res, 404,.*?\);)", code)
        if match:
            pos = match.start()
            code = code[:pos] + csv_endpoint + '\n  ' + code[pos:]

        # Update trackVisitor to fetch geo async
        geo_update = """
      if (visitor.ip && !visitor.geo_country) {
        getGeoLocation(visitor.ip).then(geo => {
          if (geo) {
            visitor.geo_country = geo.country;
            visitor.geo_city = geo.city;
            visitor.geo_timezone = geo.timezone;
            saveDb();
          }
        }).catch(() => {});
      }
"""
        code = code.replace('    return visitor;\n  }', geo_update + '    return visitor;\n  }')

        with sftp.file('/root/card_server/server.js', 'w') as f:
            f.write(code.encode('utf-8'))

        client.exec_command('pm2 restart card_server')
        print('  OK Updated')
        sftp.close()
    finally:
        client.close()

def deploy_iframe_host():
    print('\n[iframe-host] Deploying...')
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        sftp = client.open_sftp()
        with sftp.file('/opt/iframe-host/server.js', 'r') as f:
            code = f.read().decode('utf-8')

        if 'getGeoLocation' in code:
            print('  Already has geolocation')
            return

        # Add geolocation
        code = code.replace(
            'const visitorTracking = (() => {',
            GEO_CODE + '\nconst visitorTracking = (() => {'
        )

        # Add export endpoints for Express
        express_endpoints = """
  app.get(`${adminBase}/api/export/visitors.csv`, ensureAuth, (req, res) => {
    let csv = 'ID,Score,Visits,Device,Browser,Country,City,IP\\n';
    (visitors || []).forEach(v => {
      csv += `${v.id},${v.value_score},${v.visit_count},${v.device_type},${v.browser},${v.geo_country||''},${v.geo_city||''},${v.ip}\\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="visitors.csv"');
    res.send(csv);
  });

  app.get(`${adminBase}/api/analytics/geo`, ensureAuth, (req, res) => {
    const countries = {}, cities = {};
    (visitors || []).forEach(v => {
      if (v.geo_country) countries[v.geo_country] = (countries[v.geo_country] || 0) + 1;
      if (v.geo_city) cities[v.geo_city] = (cities[v.geo_city] || 0) + 1;
    });
    res.json({ ok: true, countries, cities });
  });

  app.get(`${adminBase}/api/visitors/online`, ensureAuth, (req, res) => {
    const online = (visitors || []).filter(v => Date.now() - v.last_visit < 300000);
    res.json({ ok: true, count: online.length, visitors: online });
  });
"""

        # Find last admin route
        match = re.search(r"(app\.get\(`\$\{adminBase\}/api/visitors/:\w+`.*?\}\);)", code, re.DOTALL)
        if match:
            pos = match.end()
            code = code[:pos] + '\n' + express_endpoints + code[pos:]

        # Update trackVisitor
        geo_update_expr = """
      if (visitor.ip && !visitor.geo_country) {
        getGeoLocation(visitor.ip).then(geo => {
          if (geo) {
            visitor.geo_country = geo.country;
            visitor.geo_city = geo.city;
            saveData();
          }
        }).catch(() => {});
      }
"""
        code = code.replace('    saveData();\n    return visitor;', geo_update_expr + '    saveData();\n    return visitor;')

        with sftp.file('/opt/iframe-host/server.js', 'w') as f:
            f.write(code.encode('utf-8'))

        client.exec_command('systemctl restart iframe-host')
        print('  OK Updated')
        sftp.close()
    finally:
        client.close()

def main():
    print('='*60)
    print('Adding Advanced Analytics Features')
    print('='*60)
    print('\nFeatures:')
    print('  - IP Geolocation')
    print('  - CSV Export')
    print('  - Geographic Distribution')
    print('  - Real-time Online Visitors')

    try:
        deploy_card_server()
        deploy_iframe_host()
        print('\n' + '='*60)
        print('Complete!')
        print('='*60)
        print('\nNew endpoints:')
        print('  GET /admin/api/export/visitors.csv')
        print('  GET /admin/api/analytics/geo')
        print('  GET /admin/api/visitors/online')
    except Exception as e:
        print(f'\nERROR: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
