import express from "express";
import pg from "pg";
import geoip from "geoip-lite";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const { BOT_TOKEN, WEBHOOK_SECRET, BASE_URL, DATABASE_URL } = process.env;
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
const APP = readFileSync(new URL("./app.html", import.meta.url), "utf8");
const app = express();
app.set("trust proxy", true);
app.use(express.json());

// Боты, превью-сканеры и скрипты: такие переходы не считаются кликами
const BOT_RE = /bot|crawl|spider|preview|facebookexternalhit|telegrambot|whatsapp|slackbot|discord|linkedin|curl|wget|python-requests|headless/i;
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };

// Проверка подписи Telegram initData: так мини-апп доказывает, кто пользователь
function verify(initData = "") {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  p.delete("hash");
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  if (crypto.createHmac("sha256", secret).update(str).digest("hex") !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  try { return JSON.parse(p.get("user")).id; } catch { return null; }
}

const tg = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

const ALPHA = "abcdefghijkmnpqrstuvwxyz23456789";
const newCode = () => [...crypto.randomBytes(6)].map((x) => ALPHA[x % ALPHA.length]).join("");

async function createLink(owner, target, name = null) {
  const u = new URL(target);
  if (!/^https?:$/.test(u.protocol)) throw new Error("bad url");
  const p = await plan(owner);
  if (p.used >= p.limit) throw Object.assign(new Error("limit"), { limit: p.limit });
  const code = newCode();
  await pool.query("insert into links (code,url,owner,created,name) values ($1,$2,$3,$4,$5)", [code, u.toString(), owner, Date.now(), name]);
  onActivate(owner).catch(console.error);
  return code;
}

const FREE_LIMIT = Number(process.env.FREE_LIMIT || 10);
const PRO_PRICE = Number(process.env.PRO_PRICE || 150); // в Stars
const PRO_DAYS = 30, PRO_LIMIT = 1000;
const REF_DAYS = Number(process.env.REF_DAYS || 3); // бонусные дни Pro за приглашение
const REF_MAX = Number(process.env.REF_MAX || 10);  // максимум наград одному пригласившему

async function grantDays(uid, days) {
  const add = days * 864e5, now = Date.now();
  const { rows } = await pool.query(
    `insert into users (id,pro_until) values ($1,$2)
     on conflict (id) do update set pro_until = greatest(users.pro_until,$3) + $4 returning pro_until`, [uid, now + add, now, add]);
  return Number(rows[0].pro_until);
}

let _bn;
async function botName() {
  if (!_bn) _bn = (await (await tg("getMe", {})).json()).result?.username;
  return _bn;
}

// Приглашённый записывается при /start, но награда только после его первой созданной ссылки
async function registerRef(inv, ref) {
  if (inv === ref) return;
  if ((await pool.query("select 1 from links where owner=$1 limit 1", [inv])).rows[0]) return;
  const ok = await pool.query("select 1 from users where id=$1 union select 1 from links where owner=$1 limit 1", [ref]);
  if (!ok.rows[0]) return;
  await pool.query("insert into referrals (invitee,referrer,ts,rewarded) values ($1,$2,$3,false) on conflict do nothing", [inv, ref, Date.now()]);
}

async function onActivate(uid) {
  const r = await pool.query("update referrals set rewarded=true where invitee=$1 and not rewarded returning referrer", [uid]);
  if (!r.rowCount) return;
  const ref = r.rows[0].referrer;
  await grantDays(uid, REF_DAYS);
  await tg("sendMessage", { chat_id: uid, text: `Бонус за приглашение: +${REF_DAYS} дн. Pro.` });
  const n = (await pool.query("select count(*)::int as n from referrals where referrer=$1 and rewarded", [ref])).rows[0].n;
  if (n <= REF_MAX) {
    await grantDays(ref, REF_DAYS);
    await tg("sendMessage", { chat_id: ref, text: `Друг начал пользоваться трекером: +${REF_DAYS} дн. Pro.` });
  }
}

async function plan(uid) {
  const u = await pool.query("select pro_until from users where id=$1", [uid]);
  const until = Number(u.rows[0]?.pro_until || 0), pro = until > Date.now();
  const used = (await pool.query("select count(*)::int as n from links where owner=$1", [uid])).rows[0].n;
  return { pro, until: pro ? until : null, limit: pro ? PRO_LIMIT : FREE_LIMIT, used };
}

// Уведомление владельцу: первый клик и отметки 100, 1000, 10000 (боты не считаются)
async function notify(code, row) {
  const n = (await pool.query("select count(*)::int as n from clicks where code=$1 and not is_bot", [code])).rows[0].n;
  if (![1, 100, 1000, 10000].includes(n)) return;
  const u = await pool.query("select mute from users where id=$1", [row.owner]);
  if (u.rows[0]?.mute) return;
  let title = row.name; if (!title) { try { title = new URL(row.url).host; } catch { title = code; } }
  await tg("sendMessage", { chat_id: row.owner, text: n === 1 ? `Первый клик по «${title}»` : `«${title}»: уже ${n.toLocaleString("ru")} кликов` });
}

async function preCheckout(q) {
  const ok = q.currency === "XTR" && q.invoice_payload === `pro:${q.from.id}` && q.total_amount === PRO_PRICE;
  await tg("answerPreCheckoutQuery", { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message: "Счёт устарел. Откройте приложение и повторите." }) });
}

async function paid(m) {
  const p = m.successful_payment, uid = m.from.id;
  const ins = await pool.query("insert into payments (charge_id,user_id,stars,ts) values ($1,$2,$3,$4) on conflict do nothing",
    [p.telegram_payment_charge_id, uid, p.total_amount, Date.now()]);
  if (!ins.rowCount) return; // повтор уведомления: не начисляем второй раз
  const add = PRO_DAYS * 864e5, now = Date.now();
  const { rows } = await pool.query(
    `insert into users (id,pro_until) values ($1,$2)
     on conflict (id) do update set pro_until = greatest(users.pro_until,$3) + $4 returning pro_until`,
    [uid, now + add, now, add]);
  const d = new Date(Number(rows[0].pro_until)).toLocaleDateString("ru-RU");
  await tg("sendMessage", { chat_id: m.chat.id, text: `Pro активен до ${d}. Спасибо!` });
}

app.get("/", (_, res) => res.send("ok")); // для проверки живости (health check)
app.get("/app", (_, res) => res.type("html").send(APP));

app.get("/s/:code", async (req, res) => {
  try {
    const { rows } = await pool.query("select url, owner, name from links where code=$1", [req.params.code]);
    if (!rows[0]) return res.status(404).send("Ссылка не найдена");
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim();
    const country = geoip.lookup(ip)?.country || "??";
    const ua = req.headers["user-agent"] || "";
    const isBot = !ua || BOT_RE.test(ua);
    const device = /mobile|android|iphone/i.test(ua) ? "mobile" : "desktop";
    const vid = crypto.createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 16);
    const cid = crypto.randomBytes(6).toString("hex");
    // {click_id} в ссылке оффера заменяется на id этого клика
    const target = rows[0].url.replace(/\{click_id\}|%7Bclick_id%7D/gi, cid);
    res.redirect(302, target); // сначала отвечаем, потом пишем клик
    const now = Date.now();
    pool.query(
      `insert into clicks (code,ts,country,device,src,is_bot,vid,is_unique,cid)
       select $1::text,$2::bigint,$3::text,$4::text,$5::text,$6::boolean,$7::text,
         (not $6::boolean and not exists (select 1 from clicks where code=$1::text and vid=$7::text and ts>$8::bigint and not is_bot)),
         $9::text`,
      [req.params.code, now, country, device, req.query.src || "", isBot, vid, now - 864e5, cid]
    ).then(() => (isBot ? null : notify(req.params.code, rows[0]))).catch(console.error);
  } catch (e) { console.error(e); res.status(500).send("Ошибка сервера"); }
});

// Постбэк от партнёрки: /postback?key=...&click_id=...&payout=...&status=...
app.get("/postback", async (req, res) => {
  try {
    const key = process.env.POSTBACK_KEY;
    if (!key || req.query.key !== key) return res.sendStatus(403);
    const cid = String(req.query.click_id || "");
    const status = String(req.query.status || "lead").slice(0, 20);
    const payout = Number(req.query.payout) || 0;
    const c = await pool.query("select c.code, l.owner, l.name, l.url from clicks c join links l on l.code=c.code where c.cid=$1", [cid]);
    if (!c.rows[0]) return res.status(404).send("click not found");
    const row = c.rows[0];
    const ins = await pool.query(
      "insert into conversions (code,cid,status,payout,ts) values ($1,$2,$3,$4,$5) on conflict do nothing",
      [row.code, cid, status, payout, Date.now()]);
    res.send("ok");
    if (!ins.rowCount) return;
    const u = await pool.query("select mute from users where id=$1", [row.owner]);
    if (u.rows[0]?.mute) return;
    await tg("sendMessage", { chat_id: row.owner, text: `Конверсия по «${row.name || host(row.url)}»: ${status}, ${payout}` });
  } catch (e) { console.error(e); res.status(500).send("error"); }
});

// Ежедневный дайджест: дёргается внешним cron: /cron/digest?key=CRON_KEY
app.get("/cron/digest", async (req, res) => {
  if (!process.env.CRON_KEY || req.query.key !== process.env.CRON_KEY) return res.sendStatus(403);
  res.send("ok");
  try {
    const since = Date.now() - 864e5;
    const { rows } = await pool.query(
      `select l.owner, l.code, l.name, l.url,
         count(c.id) filter (where not c.is_bot)::int as clicks,
         count(c.id) filter (where c.is_unique)::int as uniq,
         (select count(*)::int from conversions v where v.code=l.code and v.ts>$1) as leads,
         (select coalesce(sum(v.payout),0)::float from conversions v where v.code=l.code and v.ts>$1) as revenue
       from links l
       left join users u on u.id=l.owner
       left join clicks c on c.code=l.code and c.ts>$1
       where coalesce(u.digest,true)
       group by l.owner, l.code, l.name, l.url`, [since]);
    const by = {};
    rows.forEach((r) => (by[r.owner] ||= []).push(r));
    for (const [owner, ls] of Object.entries(by)) {
      const sum = (k) => ls.reduce((s, x) => s + x[k], 0);
      if (!sum("clicks") && !sum("leads")) continue;
      const top = [...ls].sort((a, b) => b.clicks - a.clicks).slice(0, 5)
        .map((x, i) => `${i + 1}. ${x.name || host(x.url)}: ${x.clicks} кл., ${x.leads} конв.`).join("\n");
      const text = `Итоги за 24 ч\nКлики: ${sum("clicks")} (уник. ${sum("uniq")})\nКонверсии: ${sum("leads")}\nДоход: ${Math.round(sum("revenue") * 100) / 100}\n\nТоп:\n${top}\n\nОтключить дайджест: /digest`;
      await tg("sendMessage", { chat_id: Number(owner), text }).catch(console.error);
    }
  } catch (e) { console.error(e); }
});

app.post("/webhook", (req, res) => {
  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.send("ok");
  const u = req.body;
  if (u.pre_checkout_query) preCheckout(u.pre_checkout_query).catch(console.error);
  else if (u.message?.successful_payment) paid(u.message).catch(console.error);
  else if (u.message?.text) onMessage(u.message).catch(console.error);
});

async function onMessage(m) {
  const chat_id = m.chat.id, text = m.text.trim();
  const mm = text.match(/^\/start ref_(\d+)/);
  if (mm) await registerRef(m.from.id, Number(mm[1])).catch(console.error);
  if (text.startsWith("/mute")) {
    const r = await pool.query("insert into users (id,mute) values ($1,true) on conflict (id) do update set mute = not users.mute returning mute", [m.from.id]);
    return tg("sendMessage", { chat_id, text: r.rows[0].mute ? "Уведомления о кликах выключены. Отправьте /mute, чтобы включить снова." : "Уведомления о кликах включены." });
  }
  if (text.startsWith("/digest")) {
    const r = await pool.query("insert into users (id,digest) values ($1,false) on conflict (id) do update set digest = not users.digest returning digest", [m.from.id]);
    return tg("sendMessage", { chat_id, text: r.rows[0].digest ? "Дайджест включён." : "Дайджест выключен. Отправьте /digest, чтобы включить." });
  }
  if (text.startsWith("/paysupport")) return tg("sendMessage", { chat_id, text: `Вопросы по оплате: ${process.env.SUPPORT || "напишите владельцу бота"}. Мы поможем или вернём Stars.` });
  if (text.startsWith("/terms")) return tg("sendMessage", { chat_id, text: `Pro даёт до ${PRO_LIMIT} ссылок на ${PRO_DAYS} дней за ${PRO_PRICE} Stars. Автопродления нет.` });
  if (text.startsWith("/new")) {
    try {
      const code = await createLink(m.from.id, text.slice(4).trim());
      return tg("sendMessage", { chat_id, text: `Готово: ${BASE_URL}/s/${code}\nДобавьте ?src=название, чтобы отслеживать источник.` });
    } catch (x) {
      if (x.message === "limit") return tg("sendMessage", { chat_id, text: `Лимит бесплатного плана: ${x.limit} ссылок. Откройте приложение и подключите Pro.`,
        reply_markup: { inline_keyboard: [[{ text: "Открыть приложение", web_app: { url: `${BASE_URL}/app` } }]] } });
      return tg("sendMessage", { chat_id, text: "Отправьте ссылку так: /new https://example.com" });
    }
  }
  return tg("sendMessage", {
    chat_id,
    text: "Короткие ссылки со статистикой кликов. Создайте ссылку командой /new или в приложении.",
    reply_markup: { inline_keyboard: [[{ text: "Открыть статистику", web_app: { url: `${BASE_URL}/app` } }]] },
  });
}

// API мини-аппа
app.use("/api", async (req, res, next) => {
  const uid = verify((req.headers.authorization || "").replace(/^tma /, ""));
  if (!uid) return res.status(401).json({ error: "unauthorized" });
  req.uid = uid; next();
});

app.post("/api/links", async (req, res) => {
  try { res.json({ code: await createLink(req.uid, req.body.url, String(req.body.name || "").trim().slice(0, 60) || null) }); }
  catch (x) {
    if (x.message === "limit") return res.status(402).json({ limit: true, error: `Лимит бесплатного плана: ${x.limit} ссылок. Подключите Pro, чтобы снять ограничение.` });
    res.status(400).json({ error: "Некорректная ссылка" });
  }
});

app.get("/api/links", async (req, res) => {
  const { rows } = await pool.query(
    `select l.code, l.name, l.url, l.created,
       (select count(*)::int from clicks c where c.code=l.code and not c.is_bot) as clicks,
       (select count(*)::int from clicks c where c.code=l.code and c.is_unique) as uniq,
       (select count(*)::int from conversions v where v.code=l.code) as leads,
       (select coalesce(sum(v.payout),0)::float from conversions v where v.code=l.code) as revenue
     from links l where l.owner=$1 order by l.created desc limit 50`, [req.uid]);
  const since = Date.now() - 7 * 864e5;
  const sp = await pool.query(
    `select c.code, to_char(to_timestamp(c.ts/1000.0) at time zone 'UTC','YYYY-MM-DD') as d, count(*)::int as n
     from clicks c join links l on l.code=c.code where l.owner=$1 and c.ts>$2 and not c.is_bot group by c.code, d`, [req.uid, since]);
  const by = {};
  sp.rows.forEach((r) => ((by[r.code] ||= {})[r.d] = r.n));
  const days = [...Array(7)].map((_, i) => new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10));
  res.json(rows.map((r) => ({ ...r, spark: days.map((d) => by[r.code]?.[d] || 0) })));
});

app.get("/api/links/:code", async (req, res) => {
  const { code } = req.params;
  const own = await pool.query("select 1 from links where code=$1 and owner=$2", [code, req.uid]);
  if (!own.rows[0]) return res.status(404).json({ error: "not found" });
  const nd = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const since = Date.now() - nd * 864e5;
  const top = (col) => pool.query(
    `select ${col} as k, count(*)::int as n from clicks where code=$1 and ts>$2 and not is_bot group by k order by n desc limit 5`, [code, since]);
  const [days, countries, sources] = await Promise.all([
    pool.query(`select to_char(to_timestamp(ts/1000.0) at time zone 'UTC','YYYY-MM-DD') as k, count(*)::int as n
                from clicks where code=$1 and ts>$2 and not is_bot group by k`, [code, since]),
    top("country"), top("nullif(src,'')"),
  ]);
  res.json({ days: days.rows, countries: countries.rows, sources: sources.rows });
});

app.post("/api/links/:code/export", async (req, res) => {
  const own = await pool.query("select 1 from links where code=$1 and owner=$2", [req.params.code, req.uid]);
  if (!own.rows[0]) return res.status(404).json({ error: "not found" });
  const { rows } = await pool.query("select ts,country,device,src,is_unique,is_bot from clicks where code=$1 order by ts desc limit 50000", [req.params.code]);
  // src задаёт любой посетитель, поэтому защищаем от формул в Excel
  const esc = (v) => { let t = String(v ?? ""); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const csv = "\ufeffdate_utc,country,device,source,unique,bot\n" +
    rows.map((r) => [new Date(Number(r.ts)).toISOString(), r.country, r.device, r.src, r.is_unique, r.is_bot].map(esc).join(",")).join("\n");
  const fd = new FormData();
  fd.append("chat_id", String(req.uid)); fd.append("caption", `Клики по /s/${req.params.code}: ${rows.length}`);
  fd.append("document", new Blob([csv], { type: "text/csv" }), `clicks-${req.params.code}.csv`);
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  r.ok ? res.json({ ok: true }) : res.status(502).json({ error: "Не удалось отправить файл. Напишите боту /start и повторите." });
});

app.get("/api/me", async (req, res) => {
  const [p, rc, bn] = await Promise.all([
    plan(req.uid), pool.query("select count(*)::int as n from referrals where referrer=$1 and rewarded", [req.uid]), botName().catch(() => null)]);
  res.json({ ...p, price: PRO_PRICE, days: PRO_DAYS, proLimit: PRO_LIMIT,
    refLink: bn ? `https://t.me/${bn}?start=ref_${req.uid}` : null, refCount: rc.rows[0].n, refDays: REF_DAYS, refMax: REF_MAX });
});

app.post("/api/invoice", async (req, res) => {
  const r = await (await tg("createInvoiceLink", {
    title: "TrackLink Pro", description: `${PRO_DAYS} дней: до ${PRO_LIMIT} ссылок`,
    payload: `pro:${req.uid}`, currency: "XTR", prices: [{ label: "Pro на 30 дней", amount: PRO_PRICE }],
  })).json();
  r.ok ? res.json({ link: r.result }) : res.status(500).json({ error: "Не удалось создать счёт" });
});

app.patch("/api/links/:code", async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 60) || null;
  const r = await pool.query("update links set name=$1 where code=$2 and owner=$3", [name, req.params.code, req.uid]);
  res.status(r.rowCount ? 200 : 404).json({ ok: !!r.rowCount });
});

app.delete("/api/links/:code", async (req, res) => {
  const r = await pool.query("delete from links where code=$1 and owner=$2", [req.params.code, req.uid]);
  res.status(r.rowCount ? 200 : 404).json({ ok: !!r.rowCount });
});

process.on("unhandledRejection", console.error); // чтобы одна ошибка не роняла сервер
app.listen(process.env.PORT || 3000);
