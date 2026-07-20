#!/usr/bin/env python3
"""Enhance iframe-host admin UI with visitor analytics"""

import paramiko
import sys

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/opt/iframe-host"

ANALYTICS_HTML = """
<!-- Visitor Analytics Dashboard -->
<div id="analytics-tab" style="display:none;">
  <h2>Visitor Analytics</h2>

  <!-- Summary Cards -->
  <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:15px; margin:20px 0;">
    <div style="background:#f8f9fa; padding:20px; border-radius:8px; border:1px solid #ddd;">
      <div style="color:#666; font-size:14px;">Total Visitors</div>
      <div style="font-size:28px; font-weight:bold;" id="stat-total">-</div>
    </div>
    <div style="background:#f8f9fa; padding:20px; border-radius:8px; border:1px solid #ddd;">
      <div style="color:#666; font-size:14px;">24h Active</div>
      <div style="font-size:28px; font-weight:bold;" id="stat-24h">-</div>
    </div>
    <div style="background:#f8f9fa; padding:20px; border-radius:8px; border:1px solid #ddd;">
      <div style="color:#666; font-size:14px;">7d Active</div>
      <div style="font-size:28px; font-weight:bold;" id="stat-7d">-</div>
    </div>
    <div style="background:#f8f9fa; padding:20px; border-radius:8px; border:1px solid #ddd;">
      <div style="color:#666; font-size:14px;">Avg Time</div>
      <div style="font-size:28px; font-weight:bold;" id="stat-time">-</div>
    </div>
  </div>

  <!-- Charts -->
  <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:20px; margin:20px 0;">
    <div style="background:#fff; padding:20px; border-radius:8px; border:1px solid #ddd;">
      <h3>Device Types</h3>
      <canvas id="device-chart"></canvas>
    </div>
    <div style="background:#fff; padding:20px; border-radius:8px; border:1px solid #ddd;">
      <h3>Browsers</h3>
      <canvas id="browser-chart"></canvas>
    </div>
    <div style="background:#fff; padding:20px; border-radius:8px; border:1px solid #ddd;">
      <h3>Value Distribution</h3>
      <canvas id="value-chart"></canvas>
    </div>
  </div>

  <!-- Visitors Table -->
  <div style="background:#fff; padding:20px; border-radius:8px; border:1px solid #ddd;">
    <div style="display:flex; justify-content:space-between; margin-bottom:15px;">
      <h3>Visitor List</h3>
      <button onclick="loadVisitors()">Refresh</button>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="background:#f8f9fa;">
          <th style="padding:10px; text-align:left;">ID</th>
          <th style="padding:10px; text-align:left;">Score</th>
          <th style="padding:10px; text-align:left;">Visits</th>
          <th style="padding:10px; text-align:left;">Last Visit</th>
          <th style="padding:10px; text-align:left;">Device</th>
          <th style="padding:10px; text-align:left;">IP</th>
        </tr>
      </thead>
      <tbody id="visitors-tbody"></tbody>
    </table>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>
<script>
let charts = {};

async function loadAnalytics() {
  try {
    const res = await fetch('/admin/api/analytics/summary', {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token') }
    });
    const data = await res.json();
    if (data.ok) {
      updateStats(data.data);
      updateCharts(data.data);
    }
  } catch (e) {
    console.error('Failed to load analytics:', e);
  }
}

function updateStats(data) {
  document.getElementById('stat-total').textContent = data.total_visitors;
  document.getElementById('stat-24h').textContent = data.unique_visitors_24h;
  document.getElementById('stat-7d').textContent = data.unique_visitors_7d;
  document.getElementById('stat-time').textContent = data.avg_time_per_visitor + 's';
}

function updateCharts(data) {
  if (charts.device) charts.device.destroy();
  const deviceCtx = document.getElementById('device-chart').getContext('2d');
  charts.device = new Chart(deviceCtx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(data.device_types),
      datasets: [{
        data: Object.values(data.device_types),
        backgroundColor: ['#36a2eb', '#ff6384', '#ffce56']
      }]
    }
  });

  if (charts.browser) charts.browser.destroy();
  const browserCtx = document.getElementById('browser-chart').getContext('2d');
  charts.browser = new Chart(browserCtx, {
    type: 'bar',
    data: {
      labels: Object.keys(data.browsers).slice(0, 5),
      datasets: [{
        data: Object.values(data.browsers).slice(0, 5),
        backgroundColor: '#36a2eb'
      }]
    }
  });

  if (charts.value) charts.value.destroy();
  const valueCtx = document.getElementById('value-chart').getContext('2d');
  charts.value = new Chart(valueCtx, {
    type: 'pie',
    data: {
      labels: ['High (70+)', 'Medium (40-69)', 'Low (<40)'],
      datasets: [{
        data: [
          data.value_distribution.high,
          data.value_distribution.medium,
          data.value_distribution.low
        ],
        backgroundColor: ['#28a745', '#ffc107', '#dc3545']
      }]
    }
  });
}

async function loadVisitors() {
  try {
    const res = await fetch('/admin/api/visitors?limit=20', {
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('token') }
    });
    const data = await res.json();
    if (data.ok) {
      displayVisitors(data.data);
    }
  } catch (e) {
    console.error('Failed to load visitors:', e);
  }
}

function displayVisitors(visitors) {
  const tbody = document.getElementById('visitors-tbody');
  tbody.innerHTML = visitors.map(v => `
    <tr>
      <td style="padding:10px;">${v.id}</td>
      <td style="padding:10px;">${v.value_score}</td>
      <td style="padding:10px;">${v.visit_count}</td>
      <td style="padding:10px;">${new Date(v.last_visit).toLocaleString()}</td>
      <td style="padding:10px;">${v.device_type}</td>
      <td style="padding:10px;">${v.ip}</td>
    </tr>
  `).join('');
}

function showAnalytics() {
  document.getElementById('analytics-tab').style.display = 'block';
  loadAnalytics();
  loadVisitors();
}
</script>
"""

def main():
    print('Enhancing iframe-host admin UI...\n')

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        print('[1/3] Reading admin.html...')
        sftp = client.open_sftp()
        with sftp.file(f'{REMOTE_DIR}/public/admin.html', 'r') as f:
            html = f.read().decode('utf-8')
        print(f'OK Read {len(html)} bytes')

        if 'analytics-tab' in html:
            print('NOTICE: Already enhanced')
            return

        print('\n[2/3] Adding analytics...')
        html = html.replace('</body>', ANALYTICS_HTML + '\n</body>')

        # Add nav button
        import re
        nav = re.search(r'(<nav[^>]*>)', html)
        if nav:
            pos = nav.end()
            html = html[:pos] + '<button onclick="showAnalytics()">Analytics</button>' + html[pos:]

        print('\n[3/3] Uploading...')
        with sftp.file(f'{REMOTE_DIR}/public/admin.html', 'w') as f:
            f.write(html.encode('utf-8'))
        sftp.close()

        print('OK Complete!')
        print('Access: http://50.114.113.121/internal-content-admin/')

    except Exception as e:
        print(f'ERROR: {e}')
        sys.exit(1)
    finally:
        client.close()

if __name__ == '__main__':
    main()
