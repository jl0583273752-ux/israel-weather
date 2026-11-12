// סנכרון "תחזית ישראל" – רץ ב-GitHub Actions כל 15 דקות וכותב את public/data.json
// מקורות: Open-Meteo (תחזית מודלים לכל יישוב), Mavir (תחזית לפי עיר), השירות המטאורולוגי (אזהרות ותחזית ארצית),
// ופידי RSS של אתרי החדשות (ידיעות מזג אוויר בלבד, פעם בשעה).
// Node 20 ומעלה, בלי תלויות חיצוניות.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLACES = JSON.parse(await fs.readFile(path.join(ROOT, "data/places.json"), "utf8"));
const OUT = path.join(ROOT, "public/data.json");
const PREV_URL = process.env.PREV_URL || "";          // כתובת data.json הקודם (לשמירת חדשות ו-Mavir בין ריצות)
const NOW = new Date();
const UA = "IsraelWeatherDashboard/1.0 (personal, non-commercial; runs every 15 min)";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- זמן ישראל ---------- */
const TZ = "Asia/Jerusalem";
const ilDate = (d = NOW) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
function ilIso(d = NOW) { // ISO עם היסט של ישראל
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).formatToParts(d).map(x => [x.type, x.value]));
  const off = (p.timeZoneName || "GMT+02:00").replace("GMT", "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
const TODAY = ilDate();
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* ---------- רשת ---------- */
async function get(url, { json = false, timeout = 25000, tries = 2 } = {}) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "he,en;q=0.8" }, signal: ac.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return json ? await r.json() : await r.text();
    } catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 1500)); }
    finally { clearTimeout(t); }
  }
}
async function pool(items, n, fn) { const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; log("נכשל:", String(items[k]).slice(0, 60), e.message); } } }));
  return out; }

/* ---------- 1. Open-Meteo: תחזית שעתית ויומית לכל יישוב ולכל תחנה ---------- */
// קודי WMO -> קודי הדף: 0 בהיר, 1 בהיר עד מעונן חלקית, 2 מעונן חלקית, 3 מעונן, 4 גשם, 5 סופת רעמים
const wmo = c => c == null ? 1 : c === 0 ? 0 : c === 1 ? 1 : c === 2 ? 2 : (c === 3 || c === 45 || c === 48) ? 3 : c >= 95 ? 5 : (c >= 51 && c <= 86) ? 4 : 2;
async function openMeteo(points) {
  const res = [];
  for (let i = 0; i < points.length; i += 80) {
    const ch = points.slice(i, i + 80);
    const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: ch.map(p => p.la).join(","), longitude: ch.map(p => p.lo).join(","),
      hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
      timezone: TZ, forecast_days: "7", wind_speed_unit: "kmh",
    });
    const j = await get(url, { json: true, timeout: 60000, tries: 3 });
    res.push(...(Array.isArray(j) ? j : [j]));
  }
  return res;
}
function hoursByDay(om) { // { 'YYYY-MM-DD': [ {h,t,f,hum,r,c,w} ] }
  const H = om.hourly, by = {};
  H.time.forEach((t, i) => { const d = t.slice(0, 10), h = +t.slice(11, 13);
    (by[d] = by[d] || []).push({ h, t: Math.round(H.temperature_2m[i]), f: Math.round(H.apparent_temperature[i]), hum: Math.round(H.relative_humidity_2m[i]),
      r: Math.round((H.precipitation[i] || 0) * 10) / 10, c: wmo(H.weather_code[i]), w: Math.round(H.wind_speed_10m[i]) }); });
  return by;
}
function stationDoc(id, name, om) {
  const by = hoursByDay(om), D = om.daily, days = [], daily = [];
  for (let i = 0; i < 7; i++) {
    const k = addDays(TODAY, i);
    if (i < 3 && by[k]) { days.push({ rows: by[k].map(({ h, t, r, c, w }) => ({ c, h, r, t, w })) }); daily.push(null); }
    else { const j = D.time.indexOf(k); daily.push(j < 0 ? null : { code: wmo(D.weather_code[j]), max: Math.round(D.temperature_2m_max[j]), min: Math.round(D.temperature_2m_min[j]), rain: Math.round((D.precipitation_sum[j] || 0) * 10) / 10 }); }
  }
  return { id, name, src: "MODEL", start: TODAY, days, daily };
}
function cityDoc(id, c, om) { // פורמט "שכבת ערים" של הדף (שורות שעתיות ל-3 ימים)
  const by = hoursByDay(om), rows = [];
  for (let i = 0; i < 3; i++) { const k = addDays(TODAY, i); (by[k] || []).forEach(x => rows.push({ ...x, d: k, wd: null })); }
  return { id, name: c.n, lat: c.la, lon: c.lo, rainKind: "mm", rows, updated: ilIso(), srcLabel: "תחזית מודלים (Open-Meteo)" };
}

/* ---------- 2. Mavir ---------- */
const decode = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ");
const HEB_MONTH = { "ינואר": 1, "פברואר": 2, "מרץ": 3, "אפריל": 4, "מאי": 5, "יוני": 6, "יולי": 7, "אוגוסט": 8, "ספטמבר": 9, "אוקטובר": 10, "נובמבר": 11, "דצמבר": 12 };
function parseMavir(html, slug, city) {
  const tx = decode(html);
  // זמן עדכון: "עדכון אחרון ב- 12 נובמבר 2026, יום חמישי, 08:00"
  let updated = null; const um = tx.match(/עדכון אחרון ב-?\s*(\d{1,2})\s+(\S+)\s+(\d{4})[^0-9]{0,20}(\d{1,2}):(\d{2})/);
  if (um && HEB_MONTH[um[2]]) updated = `${um[3]}-${String(HEB_MONTH[um[2]]).padStart(2, "0")}-${um[1].padStart(2, "0")}T${um[4].padStart(2, "0")}:${um[5]}:00+02:00`;
  // ימים: "+24° +13° היום בהיר סיכוי למשקעים 11% 0.0 מ"מ רוח צפונית מערבית ... במהירויות עד 4.4 מ'/ש'"
  const re = /([+-−]?\d{1,2})°\s*([+-−]?\d{1,2})°\s*(היום|מחר|[^0-9°]{0,12}?(\d{2})\.(\d{2}))\s*(בהיר|מעונן חלקית|מעונן|גשם[^\s]*|ממטרים|סופ[^\s]*|ערפל)?[^%]{0,40}?סיכוי למשקעים\s*(\d{1,3})%\s*([\d.]+)\s*מ["״׳']?מ\s*רוח\s+(.{2,30}?)\s+(?:%%WN_DIRECTION%%\s*)?במהירויות עד\s*([\d.]+)/g;
  const days = []; const year = TODAY.slice(0, 4); let m;
  while ((m = re.exec(tx))) {
    const date = m[3] === "היום" ? TODAY : m[3] === "מחר" ? addDays(TODAY, 1) : `${year}-${m[5]}-${m[4]}`;
    const rain = +m[8], cond = m[6] || "";
    const code = rain >= 1 ? 4 : /סופ/.test(cond) ? 5 : /גשם|ממטר/.test(cond) ? 4 : cond === "מעונן חלקית" ? 2 : cond === "מעונן" ? 3 : 0;
    if (!days.some(d => d.date === date)) days.push({ date, max: +m[1].replace("−", "-"), min: +m[2].replace("−", "-"), code, prob: +m[7], rain, dir: m[9].trim(), wind: Math.round(+m[10] * 3.6) });
  }
  if (!days.length) return null;
  return { city, url: `https://mavir.co.il/israel/${slug}`, updated: updated || ilIso(), days: days.filter(d => d.date >= TODAY).slice(0, 10) };
}

/* ---------- 3. השירות המטאורולוגי: אזהרות ותחזית ארצית (RSS) ---------- */
const IMS_ALERTS = "https://ims.gov.il/sites/default/files/ims_data/rss/alert/rssAlert_general_country_he.xml";
const IMS_FORECAST = "https://ims.gov.il/sites/default/files/ims_data/rss/forecast_country/rssForecastCountry_he.xml";
function rssItems(xml) {
  const items = []; const re = /<item[\s>][\s\S]*?<\/item>/g; let m;
  const tag = (s, t) => { const x = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)); return x ? x[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : ""; };
  while ((m = re.exec(xml))) { const s = m[0]; items.push({ title: decode(tag(s, "title")).trim(), link: tag(s, "link").replace(/&amp;/g, "&").trim(), desc: decode(tag(s, "description")).trim(), date: tag(s, "pubDate") || tag(s, "dc:date") }); }
  return items;
}
const zonesOf = t => { const z = new Set();
  if (/צפון|גליל|גולן|חרמון|עמק/.test(t)) { z.add("nv"); z.add("nc"); } if (/חיפה|כרמל|חוף הצפוני/.test(t)) z.add("nc");
  if (/מרכז|מישור החוף|שפלה|גוש דן|שרון|תל אביב/.test(t)) z.add("cc"); if (/ירושלים|הרים|יהודה|שומרון/.test(t)) z.add("mt");
  if (/נגב|דרום|באר שבע/.test(t)) z.add("ng"); if (/ים המלח|ערבה|אילת|מדבר יהודה|בקעת/.test(t)) z.add("es");
  return z.size ? [...z] : ["cc", "nc", "nv", "mt", "ng", "es"]; };
function warningsFrom(items) {
  return items.filter(it => !it.date || NOW - new Date(it.date) < 3 * 864e5).map(it => {
    const t = it.title + " " + it.desc;
    const lvl = /אדומ|כתומ/.test(t) ? "crit" : /צהוב/.test(t) ? "warn" : "info";
    const kind = /הצפות|הצפה|שיטפ/.test(t) ? "flood" : /רוח/.test(t) ? "wind" : /חום|שרב/.test(t) ? "heat" : /קור|קרה|שלג/.test(t) ? "cold" : /סופ|ברק|ברד/.test(t) ? "storm" : "info";
    return { title: it.title || "אזהרה", text: it.desc.slice(0, 400), kind, lvl, from: it.date ? ilIso(new Date(it.date)) : "", to: "", zones: zonesOf(t), src: [{ t: "השירות המטאורולוגי", u: it.link || "https://ims.gov.il/he/imsWarnings" }] };
  });
}

/* ---------- 4. חדשות מזג אוויר מאתרי החדשות (RSS, פעם בשעה) ---------- */
// רשימת פידים – אפשר להוסיף או להסיר. פיד שלא עונה פשוט מדולג.
const FEEDS = [
  ["ynet", "https://www.ynet.co.il/Integration/StoryRss2.xml"],
  ["ynet", "https://www.ynet.co.il/Integration/StoryRss1854.xml"],
  ["וואלה", "https://rss.walla.co.il/feed/1"],
  ["מעריב", "https://www.maariv.co.il/Rss/RssChadashot"],
  ["ישראל היום", "https://www.israelhayom.co.il/rss.xml"],
  ["mako", "https://rcs.mako.co.il/rss/31750a2610f26110VgnVCM1000005201000aRCRD.xml"],
  ["סרוגים", "https://www.srugim.co.il/feed"],
  ["כיפה", "https://www.kipa.co.il/feed/"],
  ["JDN", "https://www.jdn.co.il/feed/"],
  ["בחדרי חרדים", "https://www.bhol.co.il/rss/news.xml"],
  ["כיכר השבת", "https://www.kikar.co.il/rss.xml"],
  ["i24NEWS", "https://www.i24news.tv/he/rss"],
  ["מקור ראשון", "https://www.makorrishon.co.il/feed/"],
];
const WX = /מזג ה?אוויר|השירות המטאורולוגי|תחזית (מזג|לסופ|לימים|ל?שבת)|גשמים?\b|שיטפונ|הצפות|שרב|חמסין|עומס חום|סופת (רעמים|חול)|ברקים|ברד|שלג|קרה|רוחות חזקות|אובך|מפלס הכנרת|הכנרת עלה|מכ"ם גשם/;
const NOT_WX = /בורסה|מניות|כלכל|ריבית|בחירות|סקר|כדורגל|כדורסל/;
async function fetchNews() {
  const res = await pool(FEEDS, 4, async ([src, url]) => rssItems(await get(url, { timeout: 20000 })).map(it => ({ ...it, src })));
  const out = [];
  for (const list of res) for (const it of list || []) {
    const t = it.title + " " + it.desc; if (!WX.test(t) || NOT_WX.test(it.title)) continue;
    const d = it.date ? new Date(it.date) : null; if (!d || isNaN(d) || NOW - d > 48 * 36e5) continue;
    out.push({ src: it.src, t: it.title, sum: it.desc.length > 180 ? it.desc.slice(0, 177).replace(/\s\S*$/, "") + "…" : it.desc, time: ilIso(d), u: it.link,
      tags: [/שיטפ|הצפות|הצפה/.test(t) && "הצפות", /ברק|סופת רעמים/.test(t) && "ברקים", /שרב|חום/.test(t) && "חום", /גשם/.test(t) && "גשם"].filter(Boolean), zones: zonesOf(t) });
  }
  return out;
}
function mergeNews(fresh, old) {
  const seen = new Set(), all = [...fresh, ...(old || [])].filter(n => n && n.u && NOW - new Date(n.time) < 48 * 36e5)
    .filter(n => { const k = n.u.split("?")[0]; if (seen.has(k)) return false; seen.add(k); return true; });
  return all.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 25);
}

/* ---------- טקסט ארצי אוטומטי מהנתונים ---------- */
const COND = ["בהיר", "בהיר עד מעונן חלקית", "מעונן חלקית", "מעונן", "גשם", "סופות רעמים"];
function autoText(stations, k) {
  const pick = ["ta", "jlm", "hfa", "bs", "elt"], nm = { ta: "תל אביב", jlm: "ירושלים", hfa: "חיפה", bs: "באר שבע", elt: "אילת" };
  const parts = [], codes = [], rains = [];
  for (const id of Object.keys(stations)) { const s = stations[id]; const i = Math.round((new Date(k) - new Date(s.start)) / 864e5);
    const e = i < 3 ? s.days[i] && s.days[i].rows : null; let mx, mn, rr, cc;
    if (e && e.length) { mx = Math.max(...e.map(r => r.t)); mn = Math.min(...e.map(r => r.t)); rr = e.reduce((a, r) => a + r.r, 0); cc = Math.max(...e.filter(r => r.h >= 8 && r.h <= 17).map(r => r.c), 0); }
    else if (s.daily[i]) { mx = s.daily[i].max; mn = s.daily[i].min; rr = s.daily[i].rain; cc = s.daily[i].code; }
    if (mx == null) continue; codes.push(cc); rains.push({ id, rr });
    if (pick.includes(id)) parts.push(`${nm[id]} ${mx}°/${mn}°`); }
  if (!codes.length) return "";
  codes.sort((a, b) => a - b); const med = codes[Math.floor(codes.length / 2)]; const wet = rains.filter(x => x.rr >= 1).length;
  return `${COND[med]}${wet ? `, גשם צפוי ב־${wet} מתוך ${rains.length} התחנות` : ", ללא גשם משמעותי"}. ${parts.join(" · ")}.`;
}

/* ---------- ריצה ---------- */
const prev = PREV_URL ? await get(PREV_URL, { json: true }).catch(() => null) : null;
log("נתונים קודמים:", prev ? prev.updated : "אין");

// 1. Open-Meteo
const stIds = Object.keys(PLACES.stations);
const points = [...stIds.map(id => PLACES.stations[id]), ...PLACES.cities];
const om = await openMeteo(points);
const stations = {}; stIds.forEach((id, i) => { if (om[i] && om[i].hourly) stations[id] = stationDoc(id, PLACES.stations[id].name, om[i]); });
const cities = {}; PLACES.cities.forEach((c, i) => { const o = om[stIds.length + i]; if (o && o.hourly) cities["c" + i] = cityDoc("c" + i, c, o); });
log("Open-Meteo:", Object.keys(stations).length, "תחנות,", Object.keys(cities).length, "יישובים");

// 2. Mavir – בכל ריצה רבע מהערים (כל עיר מתעדכנת פעם בשעה), ובריצה הראשונה כולן
const slugs = Object.keys(PLACES.mavir), q = Math.floor(NOW / 9e5) % 4;
const todo = prev && prev.mavir && Object.keys(prev.mavir).length > 50 ? slugs.filter((_, i) => i % 4 === q) : slugs;
const mavir = { ...((prev && prev.mavir) || {}) };
const mres = await pool(todo, 4, async slug => parseMavir(await get(`https://mavir.co.il/israel/${slug}`), slug, PLACES.mavir[slug]));
let mOk = 0; todo.forEach((s, i) => { if (mres[i]) { mavir[s] = mres[i]; mOk++; } });
for (const k of Object.keys(mavir)) if (NOW - new Date(mavir[k].updated) > 30 * 36e5) delete mavir[k];
log("Mavir:", mOk, "/", todo.length, "עמודים נקראו,", Object.keys(mavir).length, "ערים במאגר");

// 3. השירות המטאורולוגי
let warnings = (prev && prev.meta && prev.meta.warnings) || [], imsText = "", imsUp = prev && prev.meta && prev.meta.providers && prev.meta.providers.ims && prev.meta.providers.ims.updated;
try { warnings = warningsFrom(rssItems(await get(IMS_ALERTS))); imsUp = ilIso(); } catch (e) { log("אזהרות השירות לא זמינות:", e.message); }
try { const it = rssItems(await get(IMS_FORECAST)); if (it.length) { imsText = it.map(x => x.desc || x.title).join(" ").slice(0, 900); imsUp = ilIso(); } } catch (e) { log("תחזית השירות לא זמינה:", e.message); }

// 4. חדשות – פעם בשעה (כשעברו 55 דקות מהשאיבה הקודמת) או כשאין חדשות
const oldNews = (prev && prev.live && prev.live.news) || [];
let news = oldNews, newsUp = prev && prev.live && prev.live.updated;
if (!oldNews.length || !newsUp || NOW - new Date(newsUp) > 55 * 6e4) {
  try { news = mergeNews(await fetchNews(), oldNews); newsUp = ilIso(); log("חדשות:", news.length); } catch (e) { log("חדשות נכשלו:", e.message); news = mergeNews([], oldNews); }
} else news = mergeNews([], oldNews);

// טקסטים, גשם לפי אזור, ומטא
const regtext = {}; for (let i = 0; i < 7; i++) { const k = addDays(TODAY, i); const a = autoText(stations, k); regtext[k] = (i === 0 && imsText ? imsText + " " : "") + a; }
const ZN = { cc: ["ta", "rsh", "net", "hdr", "kfs", "mdn", "ash"], nc: ["hfa"], nv: ["nzr", "afl", "tbr", "sfd", "krm", "ksh", "mrg", "hrm"], mt: ["jlm"], ng: ["bs"], es: ["dsa", "elt"] };
const ZNAME = { cc: "מישור החוף והשפלה", nc: "חיפה וחוף הצפון", nv: "הגליל והעמקים", mt: "הרי ירושלים ויהודה", ng: "הנגב הצפוני", es: "מדבר יהודה, ים המלח והערבה" };
const rainOf = s => s ? s.days.reduce((a, d) => a + d.rows.reduce((b, r) => b + r.r, 0), 0) + s.daily.reduce((a, d) => a + (d ? d.rain : 0), 0) : 0;
const regrain = Object.entries(ZN).map(([z, ids]) => { const v = ids.map(id => rainOf(stations[id])); const hi = Math.round(Math.max(0, ...v));
  return { zone: z, name: ZNAME[z], hi, range: hi < 1 ? "ללא גשם משמעותי" : `עד כ־${hi} מ״מ`, note: "סך הגשם החזוי לשבוע לפי המודלים בתחנות האזור." }; });

const updated = ilIso();
const flashes = [...warnings.map(w => ({ lvl: w.lvl, src: "השירות המטאורולוגי", t: w.title, time: w.from || updated, u: w.src[0].u })),
  ...news.slice(0, 10).map(n => ({ lvl: "info", src: n.src, t: `${n.src}: ${n.t}`, time: n.time, u: n.u }))];
const out = {
  updated,
  meta: { updated, start: TODAY, schedule: "כל 15 דקות", regtext, zonetext: {}, regrain, warnings, news,
    radar: (prev && prev.meta && prev.meta.radar) || [
      { k: "radar", src: "השירות המטאורולוגי", t: "מכ״ם ולוויין", d: "המכ״ם הרשמי, בעמוד הבית של השירות", u: "https://ims.gov.il/he" },
      { k: "warn", src: "השירות המטאורולוגי", t: "אזהרות לציבור", d: "האזהרות הרשמיות בתוקף", u: "https://ims.gov.il/he/imsWarnings" },
      { k: "radar", src: "Weather2day", t: "מכ״ם גשם", d: "תמונת המכ״ם העדכנית", u: "https://www.weather2day.co.il/rain-radar-google" }],
    providers: { ims: imsUp ? { name: "השירות המטאורולוגי", updated: imsUp, url: "https://ims.gov.il/he", via: "פיד האזהרות ופיד התחזית הארצית (RSS)" } : undefined,
      model: { name: "תחזית מודלים", updated, url: "https://open-meteo.com/", via: "Open-Meteo – מודלים מספריים (בהם ECMWF), לכל יישוב לפי מיקום" } } },
  stations, cities, mavir,
  live: { updated: newsUp || updated, news, flashes, warnings },
};
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(out));
log("נכתב", OUT, Math.round(JSON.stringify(out).length / 1024), "KB");
