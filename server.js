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

async function createLink(owner, target) {
  const u = new URL(target);
  if (!/^https?:$/.test(u.protocol)) throw new Error("bad url");
  const code = newCode();
  await pool.query("insert into links (code,url,owner,created) values ($1,$2,$3,$4)", [code, u.toString(), owner, Date.now()]);
  return code;
}

app.get("/", (_, res) => res.send("ok")); // для проверки живости (health check)
app.get("/app", (_, res) => res.type("html").send(APP));

app.get("/s/:code", async (req, res) => {
  try {
    const { rows } = await pool.query("select url from links where code=$1", [req.params.code]);
    if (!rows[0]) return res.status(404).send("Ссылка не найдена");
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim();
    const country = geoip.lookup(ip)?.country || "??";
    const device = /mobile|android|iphone/i.test(req.headers["user-agent"] || "") ? "mobile" : "desktop";
    res.redirect(302, rows[0].url); // сначала отвечаем, потом пишем клик
    pool.query("insert into clicks (code,ts,country,device,src) values ($1,$2,$3,$4,$5)",
      [req.params.code, Date.now(), country, device, req.query.src || ""]).catch(console.error);
  } catch (e) { console.error(e); res.status(500).send("Ошибка сервера"); }
});

app.post("/webhook", (req, res) => {
  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.send("ok");
  const m = req.body.message;
  if (m?.text) onMessage(m).catch(console.error);
});

async function onMessage(m) {
  const chat_id = m.chat.id, text = m.text.trim();
  if (text.startsWith("/new")) {
    try {
      const code = await createLink(m.from.id, text.slice(4).trim());
      return tg("sendMessage", { chat_id, text: `Готово: ${BASE_URL}/s/${code}\nДобавьте ?src=название, чтобы отслеживать источник.` });
    } catch {
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
  try { res.json({ code: await createLink(req.uid, req.body.url) }); }
  catch { res.status(400).json({ error: "Некорректная ссылка" }); }
});

app.get("/api/links", async (req, res) => {
  const { rows } = await pool.query(
    `select l.code, l.url, l.created, (select count(*)::int from clicks c where c.code=l.code) as clicks
     from links l where l.owner=$1 order by l.created desc limit 50`, [req.uid]);
  res.json(rows);
});

app.get("/api/links/:code", async (req, res) => {
  const { code } = req.params;
  const own = await pool.query("select 1 from links where code=$1 and owner=$2", [code, req.uid]);
  if (!own.rows[0]) return res.status(404).json({ error: "not found" });
  const since = Date.now() - 7 * 864e5;
  const top = (col) => pool.query(
    `select ${col} as k, count(*)::int as n from clicks where code=$1 and ts>$2 group by k order by n desc limit 5`, [code, since]);
  const [days, countries, sources] = await Promise.all([
    pool.query(`select to_char(to_timestamp(ts/1000.0) at time zone 'UTC','YYYY-MM-DD') as k, count(*)::int as n
                from clicks where code=$1 and ts>$2 group by k`, [code, since]),
    top("country"), top("nullif(src,'')"),
  ]);
  res.json({ days: days.rows, countries: countries.rows, sources: sources.rows });
});

app.listen(process.env.PORT || 3000);
