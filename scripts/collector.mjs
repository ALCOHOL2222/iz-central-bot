import fs from "fs";
import path from "path";
import zlib from "zlib";
import { chromium } from "playwright";

const ROOT_SITEMAP = "https://iz.ru/sitemap.xml";
const TZ_NAME = "Europe/Moscow";
const OUT_FILE = path.resolve("data/reports.json");
const DAYS_BACK = 14;

const EXCLUDED_FIRST_SEGMENTS = new Set([
  "", "search", "tags", "tag", "authors", "author", "topic", "themes", "theme",
  "special", "specprojects", "project", "projects", "reklama", "advert", "about",
  "contacts", "company", "dossier", "poll", "tests", "games", "tv", "weather", "archive"
]);

function tzTodayIso() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_NAME,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter(x => x.type !== "literal").map(x => [x.type, x.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysIso(iso, diff) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + diff);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildDateList(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
  }
  return out;
}

function looksLikeGzip(buf) {
  return buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function normalizeAnyUrl(raw) {
  try {
    const u = new URL(raw, "https://iz.ru");
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeIzArticleUrl(raw) {
  try {
    const u = new URL(raw, "https://iz.ru");
    if (!/(^|\.)iz\.ru$/i.test(u.hostname)) return null;
    if (u.hostname === "www.iz.ru") u.hostname = "iz.ru";
    u.hash = "";
    u.search = "";
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    return u.toString();
  } catch {
    return null;
  }
}

function detectType(url) {
  if (/-izi(?:[/?#]|$)/i.test(url)) return "izi";
  if (/-iiz(?:[/?#]|$)/i.test(url)) return "iiz";
  return "other";
}

function hasFileExtension(pathname) {
  return /\.[a-z0-9]{2,6}$/i.test(pathname);
}

function isCountableMaterialUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)iz\.ru$/i.test(u.hostname)) return false;

    const pathname = u.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/") return false;
    if (hasFileExtension(pathname)) return false;

    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 2) return false;

    const first = String(parts[0] || "").toLowerCase();
    if (EXCLUDED_FIRST_SEGMENTS.has(first)) return false;

    const last = String(parts[parts.length - 1] || "");
    if (last.length < 4) return false;

    return true;
  } catch {
    return false;
  }
}

function extractIsoDate(value) {
  const s = String(value || "");
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function extractSitemapLocs(xml) {
  const out = [];
  const re = /<sitemap\b[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const loc = normalizeAnyUrl(m[1].trim());
    if (loc) out.push(loc);
  }
  return out;
}

function parseUrlSet(xml) {
  const out = [];
  const re = /<url\b[\s\S]*?<loc>([\s\S]*?)<\/loc>(?:[\s\S]*?<lastmod>([\s\S]*?)<\/lastmod>)?[\s\S]*?<\/url>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const loc = normalizeIzArticleUrl(m[1].trim());
    if (!loc) continue;
    out.push({ loc, lastmodRaw: (m[2] || "").trim() });
  }
  return out;
}

async function getXmlText(page, url) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  if (!response) throw new Error(`No response for ${url}`);

  const status = response.status();
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} for ${url}`);
  }

  const headers = await response.allHeaders();
  const body = Buffer.from(await response.body());
  const contentType = String(headers["content-type"] || "").toLowerCase();

  if (url.toLowerCase().endsWith(".gz") || contentType.includes("gzip") || contentType.includes("x-gzip") || looksLikeGzip(body)) {
    return zlib.gunzipSync(body).toString("utf8");
  }

  const txt = body.toString("utf8");
  if (txt.includes("<sitemapindex") || txt.includes("<urlset")) return txt;

  try {
    const preText = await page.locator("pre").first().textContent({ timeout: 1000 });
    if (preText && (preText.includes("<sitemapindex") || preText.includes("<urlset"))) {
      return preText;
    }
  } catch {}

  const html = await page.content();
  if (html.includes("<sitemapindex") || html.includes("<urlset")) return html;

  throw new Error(`Unexpected content-type=${contentType} for ${url}`);
}

async function run() {
  const today = tzTodayIso();
  const from = addDaysIso(today, -(DAYS_BACK - 1));
  const to = today;

  const byDay = {};
  for (const day of buildDateList(from, to)) {
    byDay[day] = {
      totalChecked: 0,
      totalIzi: 0,
      totalIiz: 0,
      totalAi: 0,
      topLinks: []
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  const queue = [ROOT_SITEMAP];
  const visited = new Set();

  let fetchedIndexes = 0;
  let fetchedUrlSets = 0;
  let failedFetches = 0;
  let childLocs = 0;

  try {
    await page.goto("https://iz.ru/", { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => null);

    while (queue.length) {
      const sitemapUrl = queue.shift();
      if (visited.has(sitemapUrl)) continue;
      visited.add(sitemapUrl);

      let xml = "";
      try {
        xml = await getXmlText(page, sitemapUrl);
      } catch (e) {
        failedFetches += 1;
        console.log("FETCH_FAIL", sitemapUrl, String(e.message || e));
        continue;
      }

      if (/<sitemapindex/i.test(xml)) {
        fetchedIndexes += 1;
        const locs = extractSitemapLocs(xml);
        childLocs += locs.length;
        for (const loc of locs) {
          if (!visited.has(loc)) queue.push(loc);
        }
        continue;
      }

      if (!/<urlset/i.test(xml)) continue;

      fetchedUrlSets += 1;
      const urls = parseUrlSet(xml);

      for (const item of urls) {
        if (!isCountableMaterialUrl(item.loc)) continue;
        const day = extractIsoDate(item.lastmodRaw);
        if (!day) continue;
        if (day < from || day > to) continue;
        if (!byDay[day]) continue;

        byDay[day].totalChecked += 1;

        const type = detectType(item.loc);
        if (type === "izi") byDay[day].totalIzi += 1;
        if (type === "iiz") byDay[day].totalIiz += 1;

        if ((type === "izi" || type === "iiz") && byDay[day].topLinks.length < 20) {
          byDay[day].topLinks.push(item.loc);
        }
      }
    }
  } finally {
    await browser.close();
  }

  for (const day of Object.keys(byDay)) {
    byDay[day].totalAi = byDay[day].totalIzi + byDay[day].totalIiz;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    timezone: TZ_NAME,
    source: ROOT_SITEMAP,
    debug: {
      fetchedIndexes,
      fetchedUrlSets,
      failedFetches,
      childLocs,
      visitedCount: visited.size
    },
    days: byDay
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result.debug, null, 2));

  if (fetchedUrlSets === 0) {
    throw new Error(`No URL-set sitemaps were parsed. debug=${JSON.stringify(result.debug)}`);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
