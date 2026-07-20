#!/usr/bin/env python3
"""
Create enhanced admin interface for card_server with visitor analytics
Adds analytics dashboard, charts, visitor list, and detail pages
"""

import paramiko
import sys

HOST = "50.114.113.121"
PORT = 22
USERNAME = "root"
PASSWORD = "PaSdf5z8b3t2SaZdFdj2"
REMOTE_DIR = "/root/card_server"

# Visitor analytics dashboard HTML (to be injected into admin.html)
ANALYTICS_DASHBOARD_HTML = """
<!-- Visitor Analytics Dashboard -->
<div id="analytics-section" style="display:none;">
  <div style="margin-bottom: 20px;">
    <h2>📊 访客分析</h2>
  </div>

  <!-- Summary Cards -->
  <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px;">
    <div class="stat-card">
      <div class="stat-label">总访客数</div>
      <div class="stat-value" id="total-visitors">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">24小时活跃</div>
      <div class="stat-value" id="visitors-24h">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">7天活跃</div>
      <div class="stat-value" id="visitors-7d">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">平均停留时间</div>
      <div class="stat-value" id="avg-time">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">平均页面浏览</div>
      <div class="stat-value" id="avg-pageviews">-</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">高价值访客</div>
      <div class="stat-value" id="high-value-visitors">-</div>
    </div>
  </div>

  <!-- Charts Row -->
  <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px;">
    <div class="chart-container">
      <h3>设备类型分布</h3>
      <canvas id="device-chart"></canvas>
    </div>
    <div class="chart-container">
      <h3>浏览器分布</h3>
      <canvas id="browser-chart"></canvas>
    </div>
    <div class="chart-container">
      <h3>访客价值分布</h3>
      <canvas id="value-chart"></canvas>
    </div>
  </div>

  <!-- Visitors Table -->
  <div class="table-container">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
      <h3>访客列表</h3>
      <div>
        <select id="sort-by" style="padding: 5px 10px; margin-right: 10px;">
          <option value="last_visit">最后访问</option>
          <option value="value_score">价值评分</option>
          <option value="visit_count">访问次数</option>
          <option value="total_time_spent">停留时间</option>
          <option value="page_views">页面浏览</option>
        </select>
        <button onclick="loadVisitors()" style="padding: 5px 15px;">刷新</button>
      </div>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>指纹</th>
          <th>价值评分</th>
          <th>访问次数</th>
          <th>最后访问</th>
          <th>设备</th>
          <th>浏览器</th>
          <th>IP</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="visitors-tbody">
        <tr><td colspan="9" style="text-align:center; padding:20px;">加载中...</td></tr>
      </tbody>
    </table>
    <div id="pagination" style="margin-top: 15px; text-align: center;"></div>
  </div>
</div>

<!-- Visitor Detail Modal -->
<div id="visitor-modal" class="modal" style="display:none;">
  <div class="modal-content">
    <span class="close" onclick="closeVisitorModal()">&times;</span>
    <h2>访客详情</h2>
    <div id="visitor-detail-content"></div>
  </div>
</div>

<style>
.stat-card {
  background: #f8f9fa;
  padding: 20px;
  border-radius: 8px;
  border: 1px solid #e0e0e0;
}
.stat-label {
  color: #666;
  font-size: 14px;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 28px;
  font-weight: bold;
  color: #2c3e50;
}
.chart-container {
  background: white;
  padding: 20px;
  border-radius: 8px;
  border: 1px solid #e0e0e0;
}
.table-container {
  background: white;
  padding: 20px;
  border-radius: 8px;
  border: 1px solid #e0e0e0;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
}
.data-table th, .data-table td {
  padding: 12px;
  text-align: left;
  border-bottom: 1px solid #e0e0e0;
}
.data-table th {
  background: #f8f9fa;
  font-weight: 600;
}
.data-table tr:hover {
  background: #f8f9fa;
}
.value-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: bold;
}
.value-high { background: #d4edda; color: #155724; }
.value-medium { background: #fff3cd; color: #856404; }
.value-low { background: #f8d7da; color: #721c24; }
.modal {
  position: fixed;
  z-index: 1000;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.5);
}
.modal-content {
  background: white;
  margin: 5% auto;
  padding: 30px;
  width: 80%;
  max-width: 900px;
  border-radius: 8px;
  max-height: 80vh;
  overflow-y: auto;
}
.close {
  float: right;
  font-size: 28px;
  font-weight: bold;
  cursor: pointer;
}
.close:hover {
  color: #f00;
}
</style>

<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>
<script>
let analyticsData = null;
let currentPage = 1;
let charts = {};

// Load analytics summary
async function loadAnalytics() {
  try {
    const res = await fetch('/admin/api/analytics/summary', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.ok) {
      analyticsData = data.data;
      updateDashboard();
    }
  } catch (e) {
    console.error('Failed to load analytics:', e);
  }
}

// Update dashboard with data
function updateDashboard() {
  if (!analyticsData) return;

  document.getElementById('total-visitors').textContent = analyticsData.total_visitors.toLocaleString();
  document.getElementById('visitors-24h').textContent = analyticsData.unique_visitors_24h.toLocaleString();
  document.getElementById('visitors-7d').textContent = analyticsData.unique_visitors_7d.toLocaleString();
  document.getElementById('avg-time').textContent = analyticsData.avg_time_per_visitor + 's';
  document.getElementById('avg-pageviews').textContent = analyticsData.avg_page_views.toFixed(1);
  document.getElementById('high-value-visitors').textContent = analyticsData.value_distribution.high.toLocaleString();

  // Update charts
  updateCharts();
}

// Update all charts
function updateCharts() {
  if (!analyticsData) return;

  // Device type chart
  if (charts.device) charts.device.destroy();
  const deviceCtx = document.getElementById('device-chart').getContext('2d');
  charts.device = new Chart(deviceCtx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(analyticsData.device_types),
      datasets: [{
        data: Object.values(analyticsData.device_types),
        backgroundColor: ['#36a2eb', '#ff6384', '#ffce56', '#4bc0c0']
      }]
    },
    options: { responsive: true, maintainAspectRatio: true }
  });

  // Browser chart
  if (charts.browser) charts.browser.destroy();
  const browserCtx = document.getElementById('browser-chart').getContext('2d');
  charts.browser = new Chart(browserCtx, {
    type: 'bar',
    data: {
      labels: Object.keys(analyticsData.browsers).slice(0, 6),
      datasets: [{
        label: '访客数',
        data: Object.values(analyticsData.browsers).slice(0, 6),
        backgroundColor: '#36a2eb'
      }]
    },
    options: { responsive: true, maintainAspectRatio: true, scales: { y: { beginAtZero: true } } }
  });

  // Value distribution chart
  if (charts.value) charts.value.destroy();
  const valueCtx = document.getElementById('value-chart').getContext('2d');
  charts.value = new Chart(valueCtx, {
    type: 'pie',
    data: {
      labels: ['高价值 (70+)', '中等 (40-69)', '低价值 (<40)'],
      datasets: [{
        data: [
          analyticsData.value_distribution.high,
          analyticsData.value_distribution.medium,
          analyticsData.value_distribution.low
        ],
        backgroundColor: ['#28a745', '#ffc107', '#dc3545']
      }]
    },
    options: { responsive: true, maintainAspectRatio: true }
  });
}

// Load visitors list
async function loadVisitors(page = 1) {
  currentPage = page;
  const sortBy = document.getElementById('sort-by').value;
  try {
    const res = await fetch(`/admin/api/visitors?page=${page}&limit=20&sort=${sortBy}&order=desc`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.ok) {
      displayVisitors(data.data);
      displayPagination(data.page, Math.ceil(data.total / data.limit));
    }
  } catch (e) {
    console.error('Failed to load visitors:', e);
  }
}

// Display visitors in table
function displayVisitors(visitors) {
  const tbody = document.getElementById('visitors-tbody');
  if (visitors.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px;">暂无访客数据</td></tr>';
    return;
  }

  tbody.innerHTML = visitors.map(v => {
    const valueBadge = v.value_score >= 70 ? 'value-high' : v.value_score >= 40 ? 'value-medium' : 'value-low';
    const lastVisit = new Date(v.last_visit).toLocaleString('zh-CN');
    return `
      <tr>
        <td>${v.id}</td>
        <td><code>${v.fingerprint.substring(0, 8)}...</code></td>
        <td><span class="value-badge ${valueBadge}">${v.value_score}</span></td>
        <td>${v.visit_count}</td>
        <td>${lastVisit}</td>
        <td>${v.device_type} ${v.is_mobile ? '📱' : '💻'}</td>
        <td>${v.browser} ${v.browser_version}</td>
        <td>${v.ip || '-'}</td>
        <td><button onclick="viewVisitor(${v.id})" style="padding:4px 8px; font-size:12px;">详情</button></td>
      </tr>
    `;
  }).join('');
}

// Display pagination
function displayPagination(current, total) {
  const container = document.getElementById('pagination');
  let html = '';
  if (current > 1) {
    html += `<button onclick="loadVisitors(${current - 1})">上一页</button> `;
  }
  html += `第 ${current} / ${total} 页 `;
  if (current < total) {
    html += `<button onclick="loadVisitors(${current + 1})">下一页</button>`;
  }
  container.innerHTML = html;
}

// View visitor details
async function viewVisitor(id) {
  try {
    const res = await fetch(`/admin/api/visitors/${id}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.ok) {
      displayVisitorDetail(data.data);
    }
  } catch (e) {
    console.error('Failed to load visitor detail:', e);
  }
}

// Display visitor detail modal
function displayVisitorDetail(data) {
  const v = data.visitor;
  const events = data.events;

  const html = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <div>
        <h3>基本信息</h3>
        <table style="width:100%;">
          <tr><td><strong>ID:</strong></td><td>${v.id}</td></tr>
          <tr><td><strong>指纹:</strong></td><td><code>${v.fingerprint}</code></td></tr>
          <tr><td><strong>价值评分:</strong></td><td>${v.value_score}</td></tr>
          <tr><td><strong>访问次数:</strong></td><td>${v.visit_count}</td></tr>
          <tr><td><strong>首次访问:</strong></td><td>${new Date(v.first_visit).toLocaleString('zh-CN')}</td></tr>
          <tr><td><strong>最后访问:</strong></td><td>${new Date(v.last_visit).toLocaleString('zh-CN')}</td></tr>
        </table>
      </div>
      <div>
        <h3>设备信息</h3>
        <table style="width:100%;">
          <tr><td><strong>浏览器:</strong></td><td>${v.browser} ${v.browser_version}</td></tr>
          <tr><td><strong>操作系统:</strong></td><td>${v.os} ${v.os_version}</td></tr>
          <tr><td><strong>设备类型:</strong></td><td>${v.device_type}</td></tr>
          <tr><td><strong>IP:</strong></td><td>${v.ip}</td></tr>
          <tr><td><strong>语言:</strong></td><td>${v.language || '-'}</td></tr>
          <tr><td><strong>时区:</strong></td><td>${v.timezone || '-'}</td></tr>
        </table>
      </div>
    </div>
    <div style="margin-top: 20px;">
      <h3>行为统计</h3>
      <p>停留时间: ${Math.round(v.total_time_spent / 1000)}秒 | 页面浏览: ${v.page_views} | 交互次数: ${v.interactions}</p>
    </div>
    <div style="margin-top: 20px;">
      <h3>最近事件 (最多200条)</h3>
      <div style="max-height: 300px; overflow-y: auto; background: #f8f9fa; padding: 10px; border-radius: 4px;">
        ${events.length === 0 ? '<p>暂无事件记录</p>' : events.map(e => `
          <div style="margin-bottom: 10px; padding: 8px; background: white; border-radius: 4px;">
            <strong>${e.type}</strong> - ${new Date(e.timestamp).toLocaleString('zh-CN')}
            <br><small>${e.page}</small>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  document.getElementById('visitor-detail-content').innerHTML = html;
  document.getElementById('visitor-modal').style.display = 'block';
}

// Close visitor modal
function closeVisitorModal() {
  document.getElementById('visitor-modal').style.display = 'none';
}

// Show analytics section
function showAnalytics() {
  document.getElementById('analytics-section').style.display = 'block';
  loadAnalytics();
  loadVisitors();
}

// Auto-refresh every 60 seconds
setInterval(() => {
  if (document.getElementById('analytics-section').style.display !== 'none') {
    loadAnalytics();
  }
}, 60000);
</script>
"""

def main():
    print('=' * 60)
    print('card_server Admin UI Enhancement')
    print('=' * 60)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=30)

    try:
        print('\n[1/3] Reading current admin.html...')
        sftp = client.open_sftp()
        with sftp.file(f'{REMOTE_DIR}/public/admin.html', 'r') as f:
            admin_html = f.read().decode('utf-8')
        print(f'OK Read {len(admin_html)} bytes')

        if 'analytics-section' in admin_html:
            print('NOTICE: Admin UI already enhanced')
            return

        print('\n[2/3] Adding analytics dashboard...')

        # Add analytics section before closing body tag
        admin_html = admin_html.replace('</body>', ANALYTICS_DASHBOARD_HTML + '\n</body>')

        # Add navigation button (find existing nav and add button)
        # This is a simple approach - insert after first button or link
        import re
        nav_match = re.search(r'(<button[^>]*>)', admin_html)
        if nav_match:
            insert_pos = nav_match.end()
            analytics_button = '<button onclick="showAnalytics()" style="margin-left:10px;">📊 访客分析</button>'
            admin_html = admin_html[:insert_pos] + analytics_button + admin_html[insert_pos:]
            print('  - Dashboard added')
            print('  - Navigation button added')
        else:
            print('  WARNING: Could not find navigation area')

        print('\n[3/3] Uploading enhanced admin.html...')
        with sftp.file(f'{REMOTE_DIR}/public/admin.html', 'w') as f:
            f.write(admin_html.encode('utf-8'))
        sftp.close()
        print(f'OK Uploaded {len(admin_html)} bytes')

        print('\n' + '=' * 60)
        print('Enhancement Complete!')
        print('=' * 60)
        print('\nAccess: http://50.114.113.121/admin')
        print('Click "📊 访客分析" button to view analytics dashboard')

    except Exception as e:
        print(f'\nERROR: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        client.close()

if __name__ == '__main__':
    main()
