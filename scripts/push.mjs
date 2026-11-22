// 成績登記簿 → 手機推播（ntfy）
// 由 GitHub Actions 每 10 分鐘執行一次，讀取網頁寫入的 pushplan，送出：
//   早上今日行程、約的時間前提醒、晚上未完成提醒
import admin from "firebase-admin";

const SA = process.env.FIREBASE_SA, TOPIC = process.env.NTFY_TOPIC;
const AM = process.env.PUSH_AM || "07:30", PM = process.env.PUSH_PM || "21:00", BEFORE = Number(process.env.PUSH_BEFORE || 10);
if (!SA || !TOPIC) { console.log("尚未設定 FIREBASE_SA 或 NTFY_TOPIC，略過。"); process.exit(0); }

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
const db = admin.firestore();

const tz = "Asia/Taipei";
const parts = d => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
const now = new Date(), P = parts(now), today = `${P.year}-${P.month}-${P.day}`, hm = `${P.hour === "24" ? "00" : P.hour}:${P.minute}`;
const toMin = t => { const [h, m] = String(t || "").split(":").map(Number); return isNaN(h) ? null : h * 60 + (m || 0); };
const nowMin = toMin(hm);
const WD = ["日", "一", "二", "三", "四", "五", "六"];
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const wd = d => WD[new Date(d + "T12:00:00+08:00").getUTCDay()];
const apptTs = a => new Date(`${a.d}T${a.t}:00+08:00`).getTime();
const line = a => `${a.t ? a.t + " " : ""}${a.n}（${a.c}）${a.w} ${a.x}`.trim();

async function send({ title, message, tags = [], priority = 3, at = null }) {
  const body = { topic: TOPIC, title, message, tags, priority };
  if (at && at > Date.now() + 15000) body.delay = String(Math.floor(at / 1000));
  const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("ntfy " + r.status);
}

// 測試
if (process.env.PUSH_TEST === "true") {
  await send({ title: "測試推播 ✅", message: "成績登記簿的推播設定成功！之後會收到每日行程和約時間提醒。", tags: ["bell"] });
  console.log("已送出測試推播"); process.exit(0);
}

// 找最新的 pushplan
const ts = await db.collection("teachers").get();
let plan = null;
ts.forEach(d => { const p = d.get("pushplan"); if (p && (!plan || (p.updatedAt || 0) > (plan.updatedAt || 0))) plan = p; });
if (!plan) { console.log("還沒有 pushplan（請先打開一次成績登記簿網頁）"); process.exit(0); }
const appts = plan.appts || [], todos = plan.todos || [];

const logRef = db.collection("pushlog").doc("state");
const log = (await logRef.get()).data() || { sent: {} };
const sent = log.sent || {};
const cutoff = Date.now() - 4 * 864e5;
for (const k of Object.keys(sent)) if (sent[k] < cutoff) delete sent[k];
let n = 0;
const mark = k => { sent[k] = Date.now(); n++; };

const todayA = appts.filter(a => a.d === today).sort((a, b) => (toMin(a.t) ?? 9999) - (toMin(b.t) ?? 9999));
const overdue = appts.filter(a => a.d < today);
const todayT = todos.filter(t => t.d === today), overT = todos.filter(t => t.d < today);

// 早上：今日行程
if (nowMin >= toMin(AM) && nowMin < 12 * 60 && !sent["am-" + today]) {
  const L = [];
  if (todayA.length) L.push(`📅 今天約了 ${todayA.length} 位`, ...todayA.map(a => "・" + line(a)));
  if (todayT.length) L.push((L.length ? "\n" : "") + `✅ 待辦 ${todayT.length} 項`, ...todayT.map(t => "・" + t.x));
  if (overdue.length) L.push((L.length ? "\n" : "") + `⚠️ 之前約了還沒處理：${overdue.length} 位`, ...overdue.slice(0, 5).map(a => `・${md(a.d)} ${line(a)}`));
  if (overT.length) L.push(`⚠️ 過期待辦 ${overT.length} 項`);
  await send({ title: `今日行程 ${md(today)}（${wd(today)}）`, message: L.length ? L.join("\n") : "今天沒有約，也沒有待辦 🎉", tags: ["sunrise"] });
  mark("am-" + today);
}

// 約的時間前提醒（排在約的時間前 BEFORE 分鐘送達）
for (const a of todayA) {
  const m = toMin(a.t); if (m == null) continue;
  const left = m - nowMin, key = `rm-${a.k}-${a.d}-${a.t}`;
  if (left <= 40 && left >= -5 && !sent[key]) {
    await send({ title: `⏰ ${a.t} ${a.n} 要來${a.w}`, message: `${a.n}（${a.c}）\n${a.w}：${a.x}`, tags: ["alarm_clock"], priority: 4, at: apptTs(a) - BEFORE * 60000 });
    mark(key);
  }
}

// 晚上：還沒完成
if (nowMin >= toMin(PM) && !sent["pm-" + today]) {
  const L = [];
  if (todayA.length) L.push(`📝 今天約的還沒登記：${todayA.length} 位`, ...todayA.map(a => "・" + line(a)));
  if (todayT.length) L.push((L.length ? "\n" : "") + `☐ 待辦還沒完成：${todayT.length} 項`, ...todayT.map(t => "・" + t.x));
  if (L.length) await send({ title: `今天還沒完成 ${md(today)}`, message: L.join("\n"), tags: ["crescent_moon"] });
  mark("pm-" + today);
}

await logRef.set({ sent, lastRun: Date.now() });
console.log(`完成，這次送出 ${n} 則。`);
