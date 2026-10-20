// 成績與錄音登記簿 — Railway 伺服器（不需要安裝任何套件）
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || "";
const DATA_DIR = VOLUME || process.env.DATA_DIR || path.join(__dirname, "data");
const PERSISTENT = !!VOLUME || !!process.env.DATA_DIR;
const DB_FILE = path.join(DATA_DIR, "db.json");
const BK_DIR = path.join(DATA_DIR, "backups");
const KEEP_BACKUPS = 30;
const COLLECTIONS = ["students", "items"];

fs.mkdirSync(BK_DIR, { recursive: true });

// ---------- 老師帳號：環境變數 TEACHERS="Maggie:密碼1,Lyn:密碼2" ----------
function teachers() {
  const out = {};
  String(process.env.TEACHERS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(pair => {
    const i = pair.indexOf(":");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}
const SECRET_FILE = path.join(DATA_DIR, ".secret");
const SECRET = process.env.SESSION_SECRET || (() => {
  try { return fs.readFileSync(SECRET_FILE, "utf8"); } catch (_) {
    const s = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(SECRET_FILE, s); return s;
  }
})();
const sign = name => { const n = Buffer.from(name).toString("base64url"); return n + "." + crypto.createHmac("sha256", SECRET).update(n).digest("base64url"); };
function whoIs(req) {
  const m = /(?:^|;\s*)gb_session=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const [n, sig] = m[1].split(".");
  if (!n || !sig) return null;
  const good = crypto.createHmac("sha256", SECRET).update(n).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const name = Buffer.from(n, "base64url").toString();
  return name in teachers() ? name : null;
}

// ---------- 資料：存在 db.json，每次寫入都先寫暫存檔再改名，避免寫到一半壞掉 ----------
let db = { students: {}, items: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (_) {}
COLLECTIONS.forEach(c => db[c] = db[c] || {});
let rev = Date.now();
function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
  rev = Date.now();
  dailyBackup();
  clients.forEach(res => res.write(`data: ${rev}\n\n`));
}
function setPath(obj, keyPath, val) {
  const ks = keyPath.split(".");
  let o = obj;
  ks.slice(0, -1).forEach(k => { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; });
  o[ks[ks.length - 1]] = val;
}

// ---------- 每日自動備份：一天一份，保留 30 天 ----------
function today() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); } // 台灣時間
function listBackups() { return fs.readdirSync(BK_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse(); }
function dailyBackup(force) {
  const f = path.join(BK_DIR, today() + ".json");
  if (!force && fs.existsSync(f)) return;
  if (!Object.keys(db.students).length && !Object.keys(db.items).length) return;
  fs.writeFileSync(f, JSON.stringify(db));
  listBackups().slice(KEEP_BACKUPS).forEach(old => fs.unlinkSync(path.join(BK_DIR, old)));
}
dailyBackup();

// ---------- 即時同步（Server-Sent Events） ----------
const clients = new Set();
setInterval(() => clients.forEach(res => res.write(": ping\n\n")), 25000);

// ---------- HTTP ----------
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, bad) => { let s = ""; req.on("data", d => { s += d; if (s.length > 20e6) req.destroy(); }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });
const asList = c => Object.entries(db[c]).map(([id, d]) => ({ id, ...d }));

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
    }
    if (p === "/api/health") return send(res, 200, { ok: true, persistent: PERSISTENT });
    if (p === "/api/login" && req.method === "POST") {
      const { name, password } = await body(req);
      const t = teachers();
      if (!name || !(name in t) || t[name] !== password) return send(res, 401, { error: "名字或密碼不對" });
      return send(res, 200, { name }, { "Set-Cookie": `gb_session=${sign(name)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 86400}` });
    }
    if (p === "/api/logout") return send(res, 200, { ok: true }, { "Set-Cookie": "gb_session=; Path=/; Max-Age=0" });

    const me = whoIs(req);
    if (p.startsWith("/api/") && !me) return send(res, 401, { error: "請先登入" });

    if (p === "/api/me") return send(res, 200, { name: me, persistent: PERSISTENT, teachers: Object.keys(teachers()) });
    if (p === "/api/data") return send(res, 200, { rev, students: asList("students"), items: asList("items") });
    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`data: ${rev}\n\n`);
      clients.add(res); req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/write" && req.method === "POST") {
      const { op, c, id, data } = await body(req);
      if (!COLLECTIONS.includes(c) || !id || !/^[\w.~:@+-]{1,200}$/.test(id)) return send(res, 400, { error: "資料格式不正確" });
      if (op === "set") db[c][id] = data || {};
      else if (op === "update") { if (!db[c][id]) return send(res, 404, { error: "找不到資料" }); Object.entries(data || {}).forEach(([k, v]) => setPath(db[c][id], k, v)); }
      else if (op === "del") delete db[c][id];
      else return send(res, 400, { error: "不支援的動作" });
      save();
      return send(res, 200, { ok: true, rev });
    }
    if (p === "/api/import" && req.method === "POST") {
      const data = await body(req);
      dailyBackup(true);
      COLLECTIONS.forEach(c => (data[c] || []).forEach(x => { if (x && x.id) { const { id, ...rest } = x; db[c][id] = rest; } }));
      save();
      return send(res, 200, { ok: true });
    }
    if (p === "/api/backups") {
      return send(res, 200, listBackups().map(f => {
        let nS = 0, nI = 0; try { const d = JSON.parse(fs.readFileSync(path.join(BK_DIR, f), "utf8")); nS = Object.values(d.students || {}).filter(x => !x.deleted).length; nI = Object.values(d.items || {}).filter(x => !x.deleted).length; } catch (_) {}
        return { date: f.slice(0, 10), students: nS, items: nI };
      }));
    }
    const bm = /^\/api\/backups\/(\d{4}-\d{2}-\d{2})(\/restore)?$/.exec(p);
    if (bm) {
      const f = path.join(BK_DIR, bm[1] + ".json");
      if (!fs.existsSync(f)) return send(res, 404, { error: "找不到這份備份" });
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!bm[2]) return send(res, 200, { students: Object.entries(d.students || {}).map(([id, x]) => ({ id, ...x })), items: Object.entries(d.items || {}).map(([id, x]) => ({ id, ...x })) });
      if (req.method !== "POST") return send(res, 405, {});
      fs.writeFileSync(path.join(BK_DIR, "before-restore-" + Date.now() + ".json"), JSON.stringify(db));
      COLLECTIONS.forEach(c => Object.entries(d[c] || {}).forEach(([id, x]) => db[c][id] = x));
      save();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "伺服器錯誤" });
  }
}).listen(PORT, () => console.log(`登記簿已啟動 port ${PORT}，資料位置 ${DATA_DIR}，永久儲存：${PERSISTENT ? "是" : "否（請加 Volume）"}`));
