// 4KHDHub Scraper for Nuvio Local Scrapers
// React Native compatible

"use strict";
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/4khdhub/constants.js
var BASE_URL = "https://4khdhub.fans";
var TMDB_API_KEY = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
var FALLBACK_DOMAINS = ["https://4khdhub.fans", "https://4khdhub.click"];
var PLAYABLE_CHECK_TIMEOUT_MS = 7e3;
var PLAYABLE_EXTENSION_PATTERN = /\.(?:mp4|mkv|webm|m3u8)(?:[?#]|$)/i;
var HTML_WRAPPER_HOSTS = /* @__PURE__ */ new Set(["hubcdn.fans"]);
var RESOLVABLE_WRAPPER_HOST_PATTERNS = [/hubcloud/i];
function normalizeStreamUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
}
function isKnownHtmlWrapperUrl(value) {
  try {
    return HTML_WRAPPER_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}
function hasPlayableExtension(value) {
  return PLAYABLE_EXTENSION_PATTERN.test(String(value || ""));
}
function isResolvableWrapperStream(stream) {
  const rawUrl = normalizeStreamUrl(stream == null ? void 0 : stream.url);
  if (!rawUrl) return false;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return RESOLVABLE_WRAPPER_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}
function isTrustedExtractorStream(stream) {
  const url = normalizeStreamUrl(stream == null ? void 0 : stream.url);
  if (!url || isKnownHtmlWrapperUrl(url)) return false;
  const source = String(stream == null ? void 0 : stream.source || "").toLowerCase();
  return source.includes("fsl")
    || source.includes("pixel")
    || source.includes("pdl")
    || source.includes("10gbps")
    || source.includes("buzz")
    || source.includes("hubcdn")
    || source.includes("s3")
    || source.includes("mega")
    || source.includes("download");
}
function resolvePlayableStream(stream) {
  return __async(this, null, function* () {
    const url = normalizeStreamUrl(stream == null ? void 0 : stream.url);
    if (!url || isKnownHtmlWrapperUrl(url)) return null;
    if (hasPlayableExtension(url)) {
      return __spreadProps(__spreadValues({}, stream), { url, headers: stream.headers || null });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PLAYABLE_CHECK_TIMEOUT_MS);
    try {
      const res = yield fetch(url, {
        headers: __spreadValues(__spreadValues({}, stream.headers || {}), {
          Range: "bytes=0-1023"
        }),
        redirect: "follow",
        signal: controller.signal
      });
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const contentLength = Number.parseInt(res.headers.get("content-length") || "0", 10);
      const contentRange = String(res.headers.get("content-range") || "");
      const finalUrl = normalizeStreamUrl(res.url || url);
      if (res.body && typeof res.body.cancel === "function") {
        yield res.body.cancel();
      }
      if (!res.ok && res.status !== 206) return null;
      if (contentType.includes("text/html")) return null;
      const videoLike = contentType.startsWith("video/") || contentType.includes("mpegurl") || contentType.includes("application/vnd.apple.mpegurl") || contentType.includes("application/octet-stream") && (hasPlayableExtension(finalUrl) || contentLength > 1048576) || Boolean(contentRange);
      return videoLike ? __spreadProps(__spreadValues({}, stream), { url: finalUrl, headers: stream.headers || null }) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });
}
function filterPlayableStreams(streams) {
  return __async(this, null, function* () {
    const output = [];
    const seen = /* @__PURE__ */ new Set();
    const resolvedStreams = yield Promise.all((Array.isArray(streams) ? streams : []).map((stream) => __async(this, null, function* () {
      if (isResolvableWrapperStream(stream)) {
        return __spreadProps(__spreadValues({}, stream), {
          url: normalizeStreamUrl(stream.url),
          headers: stream.headers || null,
          behaviorHints: __spreadProps(__spreadValues({}, stream.behaviorHints || {}), { notWebReady: true })
        });
      }
      if (isTrustedExtractorStream(stream)) {
        return __spreadProps(__spreadValues({}, stream), {
          url: normalizeStreamUrl(stream.url),
          headers: stream.headers || null
        });
      }
      return yield resolvePlayableStream(stream);
    })));
    for (const playable of resolvedStreams) {
      if (!playable) continue;
      const key = normalizeStreamUrl(playable.url);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(playable);
    }
    return output;
  });
}

// src/4khdhub/utils.js
var domainCache = { url: BASE_URL, ts: 0 };
function isReachableDomain(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetch(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(5000)
      });
      if (response.body && typeof response.body.cancel === "function") {
        yield response.body.cancel();
      }
      return response && response.ok;
    } catch {
      return false;
    }
  });
}
function fetchLatestDomain() {
  return __async(this, null, function* () {
    const now = Date.now();
    if (now - domainCache.ts < 36e5) return domainCache.url;
    const candidates = [...FALLBACK_DOMAINS];
    try {
      const response = yield fetch(DOMAINS_URL, { signal: AbortSignal.timeout(5000) });
      const data = yield response.json();
      if (data && data["4khdhub"]) {
        candidates.unshift(data["4khdhub"]);
      }
    } catch (e) { }
    for (const candidate of [...new Set(candidates)]) {
      if (yield isReachableDomain(candidate)) {
        domainCache.url = candidate;
        break;
      }
    }
    domainCache.ts = now;
    return domainCache.url;
  });
}

// src/4khdhub/http.js
function fetchText(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    try {
      const headers = __spreadValues({
        "User-Agent": USER_AGENT
      }, options.headers);
      const response = yield fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      return yield response.text();
    } catch (err) {
      console.log(`[4KHDHub] Request failed for ${url}: ${err.message}`);
      return null;
    }
  });
}

// src/4khdhub/tmdb.js
function getTmdbDetails(tmdbId, type) {
  return __async(this, null, function* () {
    const isSeries = type === "series" || type === "tv";
    const endpoint = isSeries ? "tv" : "movie";
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    console.log(`[4KHDHub] Fetching TMDB details from: ${url}`);
    try {
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = yield fetch(url, { signal: AbortSignal.timeout(8000) });
          break;
        } catch (retryErr) {
          if (attempt === 2) throw retryErr;
          yield new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      const data = yield response.json();
      if (isSeries) {
        return {
          title: data.name,
          year: data.first_air_date ? parseInt(data.first_air_date.split("-")[0]) : 0
        };
      } else {
        return {
          title: data.title,
          year: data.release_date ? parseInt(data.release_date.split("-")[0]) : 0
        };
      }
    } catch (error) {
      console.log(`[4KHDHub] TMDB request failed: ${error.message}`);
      return null;
    }
  });
}

// src/4khdhub/utils.js
function atob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let str = String(input).replace(/=+$/, "");
  if (str.length % 4 === 1) {
    throw new Error("'atob' failed: The string to be decoded is not correctly encoded.");
  }
  let output = "";
  for (let bc = 0, bs, buffer, i = 0; buffer = str.charAt(i++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer);
  }
  return output;
}
function rot13Cipher(str) {
  return str.replace(/[a-zA-Z]/g, function (c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}
function levenshteinDistance(s, t) {
  if (s === t)
    return 0;
  const n = s.length;
  const m = t.length;
  if (n === 0)
    return m;
  if (m === 0)
    return n;
  const d = [];
  for (let i = 0; i <= n; i++) {
    d[i] = [];
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[n][m];
}
function parseBytes(val) {
  if (typeof val === "number")
    return val;
  if (!val)
    return 0;
  const match = val.match(/^([0-9.]+)\s*([a-zA-Z]+)$/);
  if (!match)
    return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  let multiplier = 1;
  if (unit.indexOf("k") === 0)
    multiplier = 1024;
  else if (unit.indexOf("m") === 0)
    multiplier = 1024 * 1024;
  else if (unit.indexOf("g") === 0)
    multiplier = 1024 * 1024 * 1024;
  else if (unit.indexOf("t") === 0)
    multiplier = 1024 * 1024 * 1024 * 1024;
  return num * multiplier;
}
function formatBytes(val) {
  if (val === 0)
    return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.floor(Math.log(val) / Math.log(k));
  if (i < 0)
    i = 0;
  return parseFloat((val / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
function sanitizeSearchTitle(value) {
  return String(value || "").replace(/[""'`]+/g, " ").replace(/\s+/g, " ").trim();
}

// src/4khdhub/parsers.js — ported from 4khdhub.js
function extractQuality(text) {
  var t = (text || "").toUpperCase();
  if (/\b(2160P|4K)\b/.test(t)) return "4K";
  if (/\b1080P\b/.test(t)) return "1080p";
  if (/\b720P\b/.test(t)) return "720p";
  if (/\b480P\b/.test(t)) return "480p";
  return "HD";
}

function extractCodec(text) {
  var t = text || "";
  if (/DV[\s.]?HDR[\s.]?H[\s.]?265/i.test(t)) return "DV HDR H265";
  if (/HDR[\s.-]DV[\s.]?H[\s.]?265/i.test(t)) return "HDR DV H265";
  if (/DV[\s.]?HDR/i.test(t)) return "DV HDR";
  if (/HDR[\s.-]DV/i.test(t)) return "HDR DV";
  if (/\bHDR\b/i.test(t)) return "HDR";
  if (/H[\s.]?265|HEVC/i.test(t)) return "H.265";
  if (/H[\s.]?264|x264/i.test(t)) return "H.264";
  if (/\bAV1\b/i.test(t)) return "AV1";
  return null;
}

function extractAudio(text) {
  var t = text || "";
  if (/DDP5\.1.*Atmos|Atmos.*DDP/i.test(t)) return "DDP5.1 Atmos";
  if (/DDP5\.1/i.test(t)) return "DDP5.1";
  if (/AAC5\.1/i.test(t)) return "AAC5.1";
  if (/TrueHD.*Atmos|Atmos.*TrueHD/i.test(t)) return "TrueHD Atmos";
  if (/\bTrueHD\b/i.test(t)) return "TrueHD";
  if (/\bAtmos\b/i.test(t)) return "Atmos";
  if (/\bDDP\b/i.test(t)) return "DDP";
  if (/\bAAC\b/i.test(t)) return "AAC";
  return null;
}

function extractLanguages(text) {
  var t = text || "";
  var langs = [];
  var LANG_MAP = [
    ["Hindi", /\bHindi\b/i],
    ["English", /\bEnglish\b/i],
    ["Tamil", /\bTamil\b/i],
    ["Telugu", /\bTelugu\b/i],
    ["Malayalam", /\bMalayalam\b/i],
    ["Kannada", /\bKannada\b/i],
    ["Bengali", /\bBengali\b/i],
    ["Punjabi", /\bPunjabi\b/i],
    ["Korean", /\bKorean\b/i],
    ["Japanese", /\bJapanese\b/i],
    ["Chinese", /\bChinese\b/i],
    ["Spanish", /\bSpanish\b/i],
    ["French", /\bFrench\b/i],
    ["German", /\bGerman\b/i],
    ["Arabic", /\bArabic\b/i],
    ["Russian", /\bRussian\b/i],
    ["Turkish", /\bTurkish\b/i],
    ["Portuguese", /\bPortuguese\b/i],
  ];
  LANG_MAP.forEach(function (pair) {
    if (pair[1].test(t)) langs.push(pair[0]);
  });
  if (/\bMulti\b/i.test(t) && !langs.length) langs.push("Multi-Audio");
  return langs;
}

function parseCardInfo(cheerioInstance, el) {
  var $ = cheerioInstance;
  var header = $(el).find(".download-header").first();
  var headerText = header.find(".flex-1").clone().children("code").remove().end().text().trim();
  var fileTitle = $(el).find(".file-title, .episode-file-title").text().trim();

  var badgeText = "";
  header.find("code .badge, code span").each(function (_, b) {
    badgeText += " " + $(b).text().trim();
  });

  var corpus = headerText + " " + fileTitle + " " + badgeText;
  var codec = extractCodec(fileTitle + " " + headerText);
  var audio = extractAudio(fileTitle);
  var langs = extractLanguages(badgeText + " " + headerText);

  var srcMatch = corpus.match(/\b(WEB[\s-]?DL|WEBRip|BluRay|BRRip|HDCAM|NF|AMZN|DSNP)\b/i);
  var SOURCE_LABELS = { 'bluray': 'BluRay', 'brrip': 'BRRip', 'webrip': 'WEBRip', 'web-dl': 'WEB-DL', 'webdl': 'WEB-DL', 'hdcam': 'HDCAM', 'nf': 'NF', 'amzn': 'AMZN', 'dsnp': 'DSNP' };
  var source = srcMatch ? (SOURCE_LABELS[srcMatch[1].toLowerCase().replace(/\s/g, '')] || srcMatch[1].toUpperCase()) : null;

  return { codec, audio, languages: langs, source };
}

function buildEpisodePreviewStreams(cheerioInstance, items, title, season, episode) {
  var $ = cheerioInstance;
  var seen = new Set();
  var results = [];

  items.forEach(function (item) {
    var fileTitle = $(item).find(".episode-file-title, .file-title").first().text().trim();
    var itemText = $(item).text() || "";
    var sizeText = $(item).find(".badge-size").first().text().trim();
    if (!sizeText) {
      var sizeMatch = itemText.match(/([\d.]+ ?[GM]B)/i);
      sizeText = sizeMatch ? sizeMatch[1].replace(/\s+/, " ") : "";
    }

    var qualityMatch = (fileTitle + " " + itemText).match(/(\d{3,4}p|4K|2K)/i);
    var quality = qualityMatch ? qualityMatch[1] : extractQuality(fileTitle + " " + itemText);
    var cardInfo = parseCardInfo($, item);

    $(item).find("div.episode-links a, div.download-item a, a").each(function (_, anchor) {
      var href = $(anchor).attr("href");
      var linkText = $(anchor).text().trim();
      if (!href || href.includes("#") || seen.has(href)) {
        return;
      }
      if (!/hubcloud|hubdrive/i.test(href + " " + linkText)) {
        return;
      }

      seen.add(href);
      var titleLine = title;
      titleLine += ` \u00B7 S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
      if (quality && quality !== "HD") titleLine += ` ${quality}`;

      var lines = [titleLine];
      var techParts = [];
      if (cardInfo.source) techParts.push(cardInfo.source);
      if (cardInfo.codec) techParts.push(cardInfo.codec);
      if (techParts.length) lines.push("\uD83D\uDCFA " + techParts.join(" \u00B7 "));
      if (cardInfo.languages && cardInfo.languages.length) lines.push("\uD83D\uDD0A " + cardInfo.languages.join(" + "));
      if (cardInfo.audio) lines.push("\uD83C\uDFB5" + cardInfo.audio);
      if (sizeText) lines.push("\uD83D\uDCBE " + sizeText);
      lines.push("\uD83D\uDD17 " + (linkText || "HubCloud") + " from 4KHDHub");

      results.push({
        name: `4KHDHub - ${linkText || "HubCloud"}${quality && quality !== "HD" ? ` ${quality}` : ""}`,
        title: lines.join("\n"),
        url: href,
        quality: quality && quality !== "HD" ? quality : void 0,
        size: sizeText || void 0,
        filename: fileTitle || void 0,
        provider: "4khdhub",
        behaviorHints: {
          bingeGroup: `4khdhub-${linkText || "hubcloud"}`,
          notWebReady: true,
          ...(sizeText ? { videoSize: parseBytes(sizeText) } : {})
        }
      });
    });
  });

  return results;
}

// src/4khdhub/search.js
var cheerio = require("cheerio-without-node-native");
function fetchPageUrl(name, year, isSeries) {
  return __async(this, null, function* () {
    const domain = yield fetchLatestDomain();
    const sanitizedName = sanitizeSearchTitle(name);
    const searchUrl = `${domain}/?s=${encodeURIComponent(sanitizedName + " " + year)}`;
    console.log(`[4KHDHub] Search Request URL: ${searchUrl}`);
    const html = yield fetchText(searchUrl);
    if (!html) {
      console.log("[4KHDHub] Search failed: No HTML response");
      return null;
    }
    const $ = cheerio.load(html);
    const targetType = isSeries ? "Series" : "Movies";
    console.log(`[4KHDHub] Parsing search results for type: ${targetType}`);
    const matchingCards = $(".movie-card").filter((_, el) => {
      const hasFormat = $(el).find(`.movie-card-format:contains("${targetType}")`).length > 0;
      if (!hasFormat) {
      }
      return hasFormat;
    }).filter((_, el) => {
      const metaText = $(el).find(".movie-card-meta").text();
      const movieCardYear = parseInt(metaText);
      const yearMatch = !isNaN(movieCardYear) && Math.abs(movieCardYear - year) <= 1;
      if (!yearMatch) {
        console.log(`[4KHDHub] Skip: Year mismatch (${movieCardYear} vs ${year}) - ${$(el).find(".movie-card-title").text().trim()}`);
      }
      return yearMatch;
    }).filter((_, el) => {
      const movieCardTitle = sanitizeSearchTitle($(el).find(".movie-card-title").text().replace(/\[.*?]/g, "").trim());
      const distance = levenshteinDistance(movieCardTitle.toLowerCase(), sanitizedName.toLowerCase());
      const match = distance < 5;
      console.log(`[4KHDHub] Checking: "${movieCardTitle}" (Dist: ${distance}) vs "${sanitizedName}"`);
      return match;
    }).map((_, el) => {
      let href = $(el).attr("href");
      if (href && !href.startsWith("http")) {
        href = domain + (href.startsWith("/") ? "" : "/") + href;
      }
      return href;
    }).get();
    if (matchingCards.length === 0) {
      console.log("[4KHDHub] No matching cards found after filtering");
    } else {
      console.log(`[4KHDHub] Found ${matchingCards.length} matching cards`);
    }
    return matchingCards.length > 0 ? matchingCards[0] : null;
  });
}

// src/4khdhub/extractor.js
var cheerio2 = require("cheerio-without-node-native");
function resolveRedirectUrl(redirectUrl) {
  return __async(this, null, function* () {
    const redirectHtml = yield fetchText(redirectUrl);
    if (!redirectHtml)
      return null;
    try {
      var regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
      var combinedString = '';
      var match;
      while ((match = regex.exec(redirectHtml)) !== null) {
        combinedString += (match[1] || match[2] || '');
      }
      if (!combinedString) {
        var singleMatch = redirectHtml.match(/'o','(.*?)'/);
        if (singleMatch) combinedString = singleMatch[1];
      }
      if (!combinedString)
        return null;
      var redirectData = JSON.parse(atob(rot13Cipher(atob(atob(combinedString)))));
      var encodedUrl = (redirectData.o || '').trim();
      if (encodedUrl) {
        let resolved = atob(encodedUrl);
        if (resolved.startsWith("/")) {
          resolved = domainCache.url + resolved;
        }
        return resolved;
      }
      var wphttp = (redirectData.blog_url || '').trim();
      var data = (redirectData.data || '').trim();
      if (wphttp && data) {
        var fallbackHtml = yield fetchText(wphttp + '?re=' + data);
        if (fallbackHtml) return fallbackHtml.trim();
      }
    } catch (e) {
      console.log(`[4KHDHub] Error resolving redirect: ${e.message}`);
    }
    return null;
  });
}
function extractSourceResults($, el) {
  return __async(this, null, function* () {
    const localHtml = $(el).html();
    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/);
    const heightMatch = localHtml.match(/\d{3,}p/);
    const title = $(el).find(".file-title, .episode-file-title").text().trim();
    let height = heightMatch ? parseInt(heightMatch[0]) : 0;
    if (height === 0 && (title.includes("4K") || title.includes("4k") || localHtml.includes("4K") || localHtml.includes("4k"))) {
      height = 2160;
    }
    const meta = {
      bytes: sizeMatch ? parseBytes(sizeMatch[1]) : 0,
      height,
      title
    };
    const hubCloudLink = $(el).find("a").filter((_, a) => $(a).text().includes("HubCloud")).attr("href");
    if (hubCloudLink) {
      if (/^https?:\/\/(?:[^/]+\.)?hubcloud\./i.test(hubCloudLink)) {
        return { url: hubCloudLink, meta };
      }
      const resolved = yield resolveRedirectUrl(hubCloudLink);
      return { url: resolved, meta };
    }
    const hubDriveLink = $(el).find("a").filter((_, a) => $(a).text().includes("HubDrive")).attr("href");
    if (hubDriveLink) {
      const resolvedDrive = /^https?:\/\/(?:[^/]+\.)?hubdrive\./i.test(hubDriveLink)
        ? hubDriveLink
        : yield resolveRedirectUrl(hubDriveLink);
      if (resolvedDrive) {
        const hubDriveHtml = yield fetchText(resolvedDrive);
        if (hubDriveHtml) {
          const $2 = cheerio2.load(hubDriveHtml);
          let innerCloudLink = $2('a:contains("HubCloud")').attr("href");
          if (innerCloudLink && innerCloudLink.startsWith("/")) {
            innerCloudLink = domainCache.url + innerCloudLink;
          }
          if (innerCloudLink) {
            return { url: innerCloudLink, meta };
          }
        }
      }
    }
    return null;
  });
}
function extractHubCloudRedirectUrl(html) {
  var m;
  m = html.match(/var url ?= ?'(.*?)'/);
  if (m) return m[1];
  m = html.match(/window\.location(?:\.href)? ?= ?['"](.*?)['"]/);
  if (m) return m[1];
  m = html.match(/location\.replace\(['"]([^'"]+)['"]\)/);
  if (m) return m[1];
  m = html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;\s*url=(.*?)["']/i);
  if (m) return m[1];
  m = html.match(/document\.location(?:\.href)? ?= ?['"](.*?)['"]/);
  if (m) return m[1];
  return null;
}
function extractHubCloudCookieName(html) {
  var m = html.match(/stck\(\s*['"]([\w]+)['"]\s*,/);
  return m ? m[1] : null;
}
function hasValidHubCloudContent($) {
  return $("#size").length > 0 || $('a:contains("FSL")').length > 0 || $('a:contains("PixelServer")').length > 0;
}
function extractHubCloud(hubCloudUrl, baseMeta) {
  return __async(this, null, function* () {
    if (!hubCloudUrl)
      return [];
    var redirectHtml = yield fetchText(hubCloudUrl, { headers: { Referer: hubCloudUrl } });
    if (!redirectHtml)
      return [];
    var finalLinksUrl = extractHubCloudRedirectUrl(redirectHtml) || "";
    if (!finalLinksUrl) {
      const $first = cheerio2.load(redirectHtml);
      const downloadBtn = $first("#download");
      if (downloadBtn.length) {
        finalLinksUrl = downloadBtn.attr("href") || "";
      }
    }
    if (!finalLinksUrl)
      return [];
    if (!finalLinksUrl.startsWith("http")) {
      try {
        const urlObj = new URL(hubCloudUrl);
        finalLinksUrl = `${urlObj.protocol}//${urlObj.hostname}/${finalLinksUrl.replace(/^\//, "")}`;
      } catch (e) {
        finalLinksUrl = hubCloudUrl + finalLinksUrl;
      }
    }
    var cookieName = extractHubCloudCookieName(redirectHtml);
    var cookieHeader = cookieName ? { Cookie: cookieName + '=s4t' } : {};
    var linksHtml = yield fetchText(finalLinksUrl, { headers: __spreadValues({ Referer: hubCloudUrl }, cookieHeader) });
    if (!linksHtml)
      return [];
    var $ = cheerio2.load(linksHtml);
    if (!hasValidHubCloudContent($)) {
      yield new Promise(function (r) { setTimeout(r, 1000); });
      var retryHtml = yield fetchText(hubCloudUrl, { headers: { Referer: hubCloudUrl } });
      if (retryHtml) {
        var retryUrl = "";
        const $retry = cheerio2.load(retryHtml);
        const retryBtn = $retry("#download");
        if (retryBtn.length) {
          retryUrl = retryBtn.attr("href") || "";
        } else {
          retryUrl = extractHubCloudRedirectUrl(retryHtml) || "";
        }
        if (retryUrl && !retryUrl.startsWith("http")) {
          try {
            const urlObj = new URL(hubCloudUrl);
            retryUrl = `${urlObj.protocol}//${urlObj.hostname}/${retryUrl.replace(/^\//, "")}`;
          } catch (e) { }
        }
        if (retryUrl) {
          linksHtml = yield fetchText(retryUrl, { headers: __spreadValues({ Referer: hubCloudUrl }, cookieHeader) });
          if (linksHtml) $ = cheerio2.load(linksHtml);
        }
      }
      if (!hasValidHubCloudContent($)) return [];
    }
    const results = [];
    const sizeText = $("#size").text();
    const titleText = $("title").text().trim();
    const playbackHeaders = { Referer: finalLinksUrl, "User-Agent": USER_AGENT };
    const currentMeta = __spreadProps(__spreadValues({}, baseMeta), {
      bytes: parseBytes(sizeText) || baseMeta.bytes,
      title: ""
    });
    $("a").each((_, el) => {
      const text = $(el).text();
      const href = $(el).attr("href");
      if (!href)
        return;
      const lowerText = text.toLowerCase();
      if (text.includes("FSL") && !text.includes("FSLv2")) {
        results.push({
          source: "FSL",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (text.includes("FSLv2")) {
        results.push({
          source: "FSLv2",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (text.includes("Download File")) {
        results.push({
          source: "FSL",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (lowerText.includes("10gbps")) {
        results.push({
          source: "10Gbps",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (lowerText.includes("pdl") || href.includes("workers.dev")) {
        results.push({
          source: "PDL",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (lowerText.includes("buzzserver")) {
        results.push({
          source: "BuzzServer",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (lowerText.includes("s3 server")) {
        results.push({
          source: "S3",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (lowerText.includes("mega server")) {
        results.push({
          source: "Mega",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (href.toLowerCase().includes("hubcdn")) {
        results.push({
          source: "HubCdn",
          url: href,
          meta: currentMeta,
          headers: playbackHeaders
        });
      } else if (text.includes("PixelServer")) {
        const userUrl = href.replace("/api/file/", "/u/");
        let pixelUrl = userUrl.replace("/u/", "/api/file/");
        try { const u = new URL(pixelUrl); u.searchParams.set("download", ""); pixelUrl = u.href; } catch (_) {}
        results.push({
          source: "PixelServer",
          url: pixelUrl,
          meta: currentMeta,
          headers: __spreadProps(__spreadValues({}, playbackHeaders), { Referer: userUrl })
        });
      }
    });
    return results;
  });
}

// src/4khdhub/index.js
var cheerio3 = require("cheerio-without-node-native");
function getMirrorStreams(tmdbId, type, season, episode) {
  return __async(this, null, function* () {
    try {
      const mirrorProvider = require("./hdhub4u.js");
      const mirrorStreams = yield mirrorProvider.getStreams(tmdbId, type, season, episode);
      return (Array.isArray(mirrorStreams) ? mirrorStreams : []).map((stream) => __spreadProps(__spreadValues({}, stream), {
        name: String(stream.name || "HDHub4u").replace(/^HDHub4u/i, "4KHDHub Mirror"),
        provider: "4khdhub",
        behaviorHints: __spreadValues({
          bingeGroup: "4khdhub-mirror"
        }, stream.behaviorHints || {})
      }));
    } catch (error) {
      console.log(`[4KHDHub] Mirror fallback failed: ${error.message}`);
      return [];
    }
  });
}
function getStreams(tmdbId, type, season, episode) {
  return __async(this, null, function* () {
    const tmdbDetails = yield getTmdbDetails(tmdbId, type);
    if (!tmdbDetails) {
      console.log("[4KHDHub] TMDB failed, trying mirror fallback");
      return yield getMirrorStreams(tmdbId, type, season, episode);
    }
    const { title, year } = tmdbDetails;
    const normalizedTitle = sanitizeSearchTitle(title);
    console.log(`[4KHDHub] Search: ${normalizedTitle} (${year})`);
    const isSeries = type === "series" || type === "tv";
    const pageUrl = yield fetchPageUrl(normalizedTitle, year, isSeries);
    if (!pageUrl) {
      console.log("[4KHDHub] Page not found");
      return yield getMirrorStreams(tmdbId, type, season, episode);
    }
    console.log(`[4KHDHub] Found page: ${pageUrl}`);
    const html = yield fetchText(pageUrl);
    if (!html)
      return [];
    const $ = cheerio3.load(html);
    const itemsToProcess = [];
    if (isSeries && season && episode) {
      const seasonStr = "S" + String(season).padStart(2, "0");
      const episodeStr = "Episode-" + String(episode).padStart(2, "0");
      $(".episode-item").each((_, el) => {
        if ($(".episode-title", el).text().includes(seasonStr)) {
          const downloadItems = $(".episode-download-item", el).filter((_2, item) => $(item).text().includes(episodeStr));
          downloadItems.each((_2, item) => {
            itemsToProcess.push(item);
          });
        }
      });
      if (itemsToProcess.length === 0) {
        $("div.episodes-list > div.season-item").each((_, seasonEl) => {
          const seasonText = $(seasonEl).find("div.episode-header > div.episode-number").first().text() || "";
          const seasonMatch = seasonText.match(/S?0*([1-9][0-9]*)/i);
          const pageSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : null;

          if (pageSeason !== Number(season)) {
            return;
          }

          const seasonContent = $(seasonEl).children("div.episode-content");
          const downloadItems = seasonContent.find(".episode-download-item").filter((_2, item) => {
            const episodeText = $(item).find("span.badge-psa").text() || $(item).text() || "";
            const episodeMatch = episodeText.match(/Episode-0*([1-9][0-9]*)/i);
            const pageEpisode = episodeMatch ? parseInt(episodeMatch[1], 10) : null;
            return pageEpisode === Number(episode);
          });

          downloadItems.each((_2, item) => {
            itemsToProcess.push(item);
          });
        });
      }
    } else {
      $(".download-item").each((_, el) => {
        itemsToProcess.push(el);
      });
    }
    console.log(`[4KHDHub] Processing ${itemsToProcess.length} items`);
    const streamPromises = itemsToProcess.map((item) => __async(this, null, function* () {
      try {
        const sourceResult = yield extractSourceResults($, item);
        if (sourceResult && sourceResult.url) {
          console.log(`[4KHDHub] Extracting from HubCloud: ${sourceResult.url}`);
          const cardInfo = parseCardInfo($, item);
          const extractedLinks = yield extractHubCloud(sourceResult.url, sourceResult.meta);
          return extractedLinks.map((link) => {
            // Line 1: title · S01E03 (for TV) + quality
            let titleLine = title;
            if (isSeries && season && episode) {
              titleLine += ` \u00B7 S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
            }
            if (sourceResult.meta.height) titleLine += ` ${sourceResult.meta.height}p`;
            const lines = [titleLine];

            // Line 3: source · codec
            const techParts = [];
            if (cardInfo.source) techParts.push(cardInfo.source);
            if (cardInfo.codec) techParts.push(cardInfo.codec);
            if (techParts.length) lines.push("\uD83D\uDCFA " + techParts.join(" \u00B7 "));

            // Line 4: languages
            if (cardInfo.languages && cardInfo.languages.length) {
              lines.push("\uD83D\uDD0A " + cardInfo.languages.join(" + "));
            }

            // Line 5: audio (no space after emoji)
            if (cardInfo.audio) lines.push("\uD83C\uDFB5" + cardInfo.audio);

            const sizeLabel = formatBytes(link.meta.bytes || 0);
            if (sizeLabel) lines.push("\uD83D\uDCBE " + sizeLabel);
            lines.push("\uD83D\uDD17 " + link.source + " from 4KHDHub");

            return {
              name: `4KHDHub - ${link.source}${sourceResult.meta.height ? ` ${sourceResult.meta.height}p` : ""}`,
              title: lines.join("\n"),
              url: link.url,
              quality: sourceResult.meta.height ? `${sourceResult.meta.height}p` : void 0,
              size: sizeLabel,
              filename: sourceResult.meta.title || void 0,
              provider: "4khdhub",
              ...(link.headers ? { headers: link.headers } : {}),
              behaviorHints: {
                bingeGroup: `4khdhub-${link.source}`,
                notWebReady: true,
                ...(link.meta.bytes ? { videoSize: link.meta.bytes } : {})
              }
            };
          });
        }
        return [];
      } catch (err) {
        console.log(`[4KHDHub] Item processing error: ${err.message}`);
        return [];
      }
    }));
    const results = yield Promise.all(streamPromises);
    const streams = results.reduce((acc, val) => acc.concat(val), []);
    const playableStreams = yield filterPlayableStreams(streams);
    if (playableStreams.length > 0) {
      return playableStreams;
    }
    if (isSeries && itemsToProcess.length > 0) {
      const previewStreams = buildEpisodePreviewStreams($, itemsToProcess, title, season, episode);
      if (previewStreams.length > 0) {
        console.log(`[4KHDHub] Returning ${previewStreams.length} episode preview streams`);
        return previewStreams;
      }
    }
    console.log("[4KHDHub] No direct streams found");
    return yield getMirrorStreams(tmdbId, type, season, episode);
  });
}
module.exports = { getStreams };
