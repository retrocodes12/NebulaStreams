/**
 * hdhub4u - Built from src/hdhub4u/
 * Generated: 2026-02-19T09:22:26.023Z
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
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
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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

// src/hdhub4u/index.js
var import_cheerio_without_node_native2 = __toESM(require("cheerio-without-node-native"));

// src/hdhub4u/constants.js
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var MAIN_URL = "https://new1.hdhub4u.cl";
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
var FALLBACK_DOMAINS = [
  "https://new1.hdhub4u.cl",
  "https://new3.hdhub4u.fo",
  "https://new4.hdhub4u.fo",
  "https://new5.hdhub4u.fo",
  "https://hdhub4u.cv",
  "https://new6.hdhub4u.fo",
  "https://new7.hdhub4u.fo",
  "https://hdhub4u.tv",
  "https://hdhub4u.com",
  "https://hdhub4u.global"
];
var DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1e3;
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Cookie": "xla=s4t",
  "Referer": `${MAIN_URL}/`
};
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
function isResolvableWrapperLink(link) {
  const rawUrl = normalizeStreamUrl(link == null ? void 0 : link.url);
  if (!rawUrl) return false;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return RESOLVABLE_WRAPPER_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}
function isTrustedExtractorLink(link) {
  const url = normalizeStreamUrl(link == null ? void 0 : link.url);
  if (!url || isKnownHtmlWrapperUrl(url)) return false;
  const source = String(link == null ? void 0 : link.source || "").toLowerCase();
  return source.startsWith("hubcloud") || source.startsWith("pixeldrain") || source.startsWith("streamtape") || source.startsWith("hdstream4u") || source.startsWith("hblinks") || source.startsWith("hubstream") || source.startsWith("hubcdn");
}
function resolvePlayableLink(link) {
  return __async(this, null, function* () {
    const url = normalizeStreamUrl(link == null ? void 0 : link.url);
    if (!url || isKnownHtmlWrapperUrl(url)) return null;
    if (hasPlayableExtension(url)) {
      return __spreadProps(__spreadValues({}, link), { url, headers: link.headers || null });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PLAYABLE_CHECK_TIMEOUT_MS);
    try {
      const res = yield fetch(url, {
        headers: __spreadValues(__spreadValues({}, link.headers || {}), {
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
      return videoLike ? __spreadProps(__spreadValues({}, link), { url: finalUrl, headers: link.headers || null }) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });
}
function filterPlayableLinks(links) {
  return __async(this, null, function* () {
    const output = [];
    const seen = /* @__PURE__ */ new Set();
    const resolvedLinks = yield Promise.all((Array.isArray(links) ? links : []).map((link) => __async(this, null, function* () {
      if (isResolvableWrapperLink(link)) {
        const wrapperUrl = normalizeStreamUrl(link.url);
        return __spreadProps(__spreadValues({}, link), {
          url: wrapperUrl,
          headers: link.headers || null,
          behaviorHints: __spreadProps(__spreadValues({}, link.behaviorHints || {}), { notWebReady: true })
        });
      }
      if (isTrustedExtractorLink(link)) {
        return __spreadProps(__spreadValues({}, link), {
          url: normalizeStreamUrl(link.url),
          headers: link.headers || null
        });
      }
      return yield resolvePlayableLink(link);
    })));
    for (const playable of resolvedLinks) {
      if (!playable) continue;
      const key = normalizeStreamUrl(playable.url);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(playable);
    }
    return output;
  });
}
function updateMainUrl(url) {
  MAIN_URL = url;
  HEADERS.Referer = `${url}/`;
}

function tryFallbackDomains(domains = FALLBACK_DOMAINS) {
  return __async(this, null, function* () {
    for (const domain of [...new Set(domains.filter(Boolean))]) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(function() {
        controller.abort();
      }, 5e3) : null;
      try {
        const response = yield fetch(domain, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": HEADERS["User-Agent"] },
          signal: controller ? controller.signal : void 0
        });
        if (timeoutId)
          clearTimeout(timeoutId);
        if (response && response.body && typeof response.body.cancel === "function") {
          yield response.body.cancel();
        }
        if (response && response.ok) {
          console.log(`[HDHub4u] Fallback domain selected: ${domain}`);
          updateMainUrl(domain);
          domainCacheTimestamp = Date.now();
          return domain;
        }
      } catch (error) {
        if (timeoutId)
          clearTimeout(timeoutId);
      }
    }
    return null;
  });
}

// src/hdhub4u/utils.js
var domainCacheTimestamp = 0;
function formatBytes(bytes) {
  if (!bytes || bytes === 0)
    return "Unknown";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
function extractServerName(source) {
  if (!source)
    return "Unknown";
  if (source.startsWith("HubCloud")) {
    const serverMatch = source.match(/HubCloud(?:\s*-\s*([^[\]]+))?/);
    return serverMatch ? serverMatch[1] || "Download" : "HubCloud";
  }
  if (source.startsWith("Pixeldrain"))
    return "Pixeldrain";
  if (source.startsWith("StreamTape"))
    return "StreamTape";
  if (source.startsWith("HubCdn"))
    return "HubCdn";
  if (source.startsWith("HbLinks"))
    return "HbLinks";
  if (source.startsWith("Hubstream"))
    return "Hubstream";
  return source.replace(/^www\./, "").split(".")[0];
}
function rot13(value) {
  return value.replace(/[a-zA-Z]/g, function(c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}
var BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function atob(value) {
  if (!value)
    return "";
  let input = String(value).replace(/=+$/, "");
  let output = "";
  let bc = 0, bs, buffer, idx = 0;
  while (buffer = input.charAt(idx++)) {
    buffer = BASE64_CHARS.indexOf(buffer);
    if (~buffer) {
      bs = bc % 4 ? bs * 64 + buffer : buffer;
      if (bc++ % 4) {
        output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
      }
    }
  }
  return output;
}
function cleanTitle(title) {
  let name = title.replace(/\.[a-zA-Z0-9]{2,4}$/, "");
  const normalized = name.replace(/WEB[-_. ]?DL/gi, "WEB-DL").replace(/WEB[-_. ]?RIP/gi, "WEBRIP").replace(/H[ .]?265/gi, "H265").replace(/H[ .]?264/gi, "H264").replace(/DDP[ .]?([0-9]\.[0-9])/gi, "DDP$1");
  const parts = normalized.split(/[\s_.]/);
  const sourceTags = /* @__PURE__ */ new Set(["WEB-DL", "WEBRIP", "BLURAY", "HDRIP", "DVDRIP", "HDTV", "CAM", "TS", "BRRIP", "BDRIP"]);
  const codecTags = /* @__PURE__ */ new Set(["H264", "H265", "X264", "X265", "HEVC", "AVC"]);
  const audioTags = ["AAC", "AC3", "DTS", "MP3", "FLAC", "DD", "DDP", "EAC3"];
  const audioExtras = /* @__PURE__ */ new Set(["ATMOS"]);
  const hdrTags = /* @__PURE__ */ new Set(["SDR", "HDR", "HDR10", "HDR10+", "DV", "DOLBYVISION"]);
  const filtered = parts.map((part) => {
    const p = part.toUpperCase();
    if (sourceTags.has(p))
      return p;
    if (codecTags.has(p))
      return p;
    if (audioTags.some((tag) => p.startsWith(tag)))
      return p;
    if (audioExtras.has(p))
      return p;
    if (hdrTags.has(p))
      return p === "DOLBYVISION" || p === "DV" ? "DOLBYVISION" : p;
    if (p === "NF" || p === "CR")
      return p;
    return null;
  }).filter(Boolean);
  return [...new Set(filtered)].join(" ");
}
function fetchAndUpdateDomain() {
  return __async(this, null, function* () {
    const now = Date.now();
    if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL)
      return;
    console.log("[HDHub4u] Fetching latest domain...");
    try {
      const response = yield fetch(DOMAINS_URL, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      if (response.ok) {
        const data = yield response.json();
        if (data && data.HDHUB4u) {
          const selectedDomain = yield tryFallbackDomains([data.HDHUB4u, ...FALLBACK_DOMAINS]);
          if (selectedDomain && selectedDomain !== MAIN_URL) {
            console.log(`[HDHub4u] Updating domain from ${MAIN_URL} to ${selectedDomain}`);
            updateMainUrl(selectedDomain);
            domainCacheTimestamp = now;
          }
        }
      }
    } catch (error) {
      console.error(`[HDHub4u] Failed to fetch latest domains: ${error.message}`);
      yield tryFallbackDomains();
    }
  });
}
function getCurrentDomain() {
  return __async(this, null, function* () {
    yield fetchAndUpdateDomain();
    return MAIN_URL;
  });
}
function normalizeTitle(title) {
  if (!title)
    return "";
  return title.toLowerCase().replace(/\b(the|a|an)\b/g, "").replace(/[:\-_]/g, " ").replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}
function sanitizeSearchQueryTitle(title) {
  return String(title || "").replace(/["'“”‘’]/g, "").replace(/\s+/g, " ").trim();
}
function calculateTitleSimilarity(title1, title2) {
  const norm1 = normalizeTitle(title1);
  const norm2 = normalizeTitle(title2);
  if (norm1 === norm2)
    return 1;
  const words1 = norm1.split(/\s+/).filter((w) => w.length > 0);
  const words2 = norm2.split(/\s+/).filter((w) => w.length > 0);
  if (words1.length === 0 || words2.length === 0)
    return 0;
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = words1.filter((w) => set2.has(w));
  const union = /* @__PURE__ */ new Set([...words1, ...words2]);
  const jaccard = intersection.length / union.size;
  const extraWordsCount = words2.filter((w) => !set1.has(w)).length;
  let score = jaccard - extraWordsCount * 0.05;
  if (words1.length > 0 && words1.every((w) => set2.has(w))) {
    score += 0.2;
  }
  return score;
}
function findBestTitleMatch(mediaInfo, searchResults, mediaType, season) {
  if (!searchResults || searchResults.length === 0)
    return null;
  let bestMatch = null;
  let bestScore = 0;
  for (const result of searchResults) {
    let score = calculateTitleSimilarity(mediaInfo.title, result.title);
    if (mediaInfo.year && result.year) {
      const yearDiff = Math.abs(mediaInfo.year - result.year);
      if (yearDiff === 0)
        score += 0.2;
      else if (yearDiff <= 1)
        score += 0.1;
      else if (yearDiff > 5)
        score -= 0.3;
    }
    if (mediaType === "tv" && season) {
      const titleLower = result.title.toLowerCase();
      const normalizedMediaTitle = normalizeTitle(mediaInfo.title);
      const normalizedResultTitle = normalizeTitle(result.title);
      const seasonPatterns = [
        `season ${season}`,
        `s${season}`,
        `season ${season.toString().padStart(2, "0")}`,
        `s${season.toString().padStart(2, "0")}`
      ];
      const hasSeason = seasonPatterns.some((p) => titleLower.includes(p));
      const otherSeasonMatch = titleLower.match(/season\s*(\d+)|s(\d+)/i);
      if (otherSeasonMatch) {
        const foundSeason = parseInt(otherSeasonMatch[1] || otherSeasonMatch[2]);
        if (foundSeason !== season) {
          score -= 0.8;
        }
      }
      if (hasSeason)
        score += 0.5;
      else
        score -= 0.3;
      if (hasSeason && normalizedMediaTitle && normalizedResultTitle.includes(normalizedMediaTitle)) {
        score = Math.max(score, 0.85);
      }
    }
    if (result.title.toLowerCase().includes("2160p") || result.title.toLowerCase().includes("4k")) {
      score += 0.05;
    }
    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestMatch = result;
    }
  }
  if (bestMatch)
    console.log(`[HDHub4u] Best title match: "${bestMatch.title}" (score: ${bestScore.toFixed(2)})`);
  return bestMatch;
}
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var _a;
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = yield fetch(url, {
          method: "GET",
          headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000)
        });
        break;
      } catch (retryErr) {
        if (attempt === 2) throw retryErr;
        yield new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (!response.ok)
      throw new Error(`TMDB API error: ${response.status}`);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const releaseDate = mediaType === "tv" ? data.first_air_date : data.release_date;
    const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;
    return { title, year, imdbId: ((_a = data.external_ids) == null ? void 0 : _a.imdb_id) || null };
  });
}
function normalizeToCurrentDomain(url) {
  try {
    const currentDomain = new URL(MAIN_URL);
    const nextUrl = new URL(url, MAIN_URL);
    if (/hdhub4u\.fo$/i.test(nextUrl.hostname) && nextUrl.hostname !== currentDomain.hostname) {
      nextUrl.protocol = currentDomain.protocol;
      nextUrl.hostname = currentDomain.hostname;
      nextUrl.port = currentDomain.port;
    }
    return nextUrl.toString();
  } catch {
    return url;
  }
}
function fetchTextWithDomainFallback(url, options = {}) {
  return __async(this, null, function* () {
    const attempts = [url, normalizeToCurrentDomain(url)].filter((value, index, list) => value && list.indexOf(value) === index);
    let lastError = null;
    for (const attemptUrl of attempts) {
      try {
        const response = yield fetch(attemptUrl, options);
        try {
          const responseUrl = new URL(response.url || attemptUrl);
          if (/hdhub4u\.fo$/i.test(responseUrl.hostname)) {
            updateMainUrl(`${responseUrl.protocol}//${responseUrl.hostname}`);
          }
        } catch {}
        return {
          url: response.url || attemptUrl,
          text: yield response.text()
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("fetch failed");
  });
}

// src/hdhub4u/extractors.js
var import_cheerio_without_node_native = __toESM(require("cheerio-without-node-native"));
var import_crypto_js = __toESM(require("crypto-js"));
function getRedirectLinks(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetch(url, { headers: HEADERS });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const doc = yield response.text();
      const regex = /s\s*\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]|ck\s*\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([^'"]+)['"]/g;
      let combinedString = "";
      let match;
      while ((match = regex.exec(doc)) !== null) {
        const extractedValue = match[1] || match[2];
        if (extractedValue)
          combinedString += extractedValue;
      }
      if (!combinedString) {
        const redirectMatch = doc.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (redirectMatch && redirectMatch[1]) {
          const newUrl = redirectMatch[1];
          if (newUrl !== url && !newUrl.includes(url)) {
            return yield getRedirectLinks(newUrl);
          }
        }
        return null;
      }
      const decodedString = atob(rot13(atob(atob(combinedString))));
      const jsonObject = JSON.parse(decodedString);
      const encodedUrl = atob(jsonObject.o || "").trim();
      if (encodedUrl)
        return encodedUrl;
      const data = atob(jsonObject.data || "").trim();
      const wpHttp = (jsonObject.blog_url || "").trim();
      if (wpHttp && data) {
        const directLinkResponse = yield fetch(`${wpHttp}?re=${data}`, { headers: HEADERS });
        const html = yield directLinkResponse.text();
        const $ = import_cheerio_without_node_native.default.load(html);
        return ($("body").text() || html).trim();
      }
      return null;
    } catch (e) {
      return null;
    }
  });
}
function vidStackExtractor(url) {
  return __async(this, null, function* () {
    var _a, _b;
    try {
      const hash = url.split("#").pop().split("/").pop();
      const baseUrl = new URL(url).origin;
      const apiUrl = `${baseUrl}/api/v1/video?id=${hash}`;
      const response = yield fetch(apiUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: url }) });
      const encoded = (yield response.text()).trim();
      const key = import_crypto_js.default.enc.Utf8.parse("kiemtienmua911ca");
      const ivs = ["1234567890oiuytr", "0123456789abcdef"];
      for (const ivStr of ivs) {
        try {
          const iv = import_crypto_js.default.enc.Utf8.parse(ivStr);
          const decrypted = import_crypto_js.default.AES.decrypt(
            { ciphertext: import_crypto_js.default.enc.Hex.parse(encoded) },
            key,
            { iv, mode: import_crypto_js.default.mode.CBC, padding: import_crypto_js.default.pad.Pkcs7 }
          );
          const decryptedText = decrypted.toString(import_crypto_js.default.enc.Utf8);
          if (decryptedText && decryptedText.includes("source")) {
            const m3u8 = (_b = (_a = decryptedText.match(/"source":"(.*?)"/)) == null ? void 0 : _a[1]) == null ? void 0 : _b.replace(/\\/g, "");
            if (m3u8) {
              return [{
                source: "Vidstack Hubstream",
                quality: 1080,
                url: m3u8.replace("https:", "http:"),
                headers: {
                  "Referer": url,
                  "Origin": url.split("/").pop()
                }
              }];
            }
          }
        } catch (e) {
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}
function hbLinksExtractor(url) {
  return __async(this, null, function* () {
    try {
      const response = yield fetch(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: url }) });
      const data = yield response.text();
      const $ = import_cheerio_without_node_native.default.load(data);
      const links = $("h3 a, h5 a, div.entry-content p a").map((i, el) => $(el).attr("href")).get();
      const results = yield Promise.all(links.map((l) => loadExtractor(l, url)));
      return results.flat().map((link) => __spreadProps(__spreadValues({}, link), {
        source: `${link.source} Hblinks`
      }));
    } catch (e) {
      return [];
    }
  });
}
function pixelDrainExtractor(link) {
  return __async(this, null, function* () {
    var _a;
    try {
      const urlObj = new URL(link);
      const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      const fileId = ((_a = link.match(/(?:file|u)\/([A-Za-z0-9]+)/)) == null ? void 0 : _a[1]) || link.split("/").pop();
      if (!fileId)
        return [{ source: "Pixeldrain", quality: 1080, url: link }];
      const finalUrl = link.includes("?download") ? link : `${baseUrl}/api/file/${fileId}?download`;
      return [{ source: "Pixeldrain", quality: 1080, url: finalUrl }];
    } catch (e) {
      return [{ source: "Pixeldrain", quality: 1080, url: link }];
    }
  });
}
function streamTapeExtractor(link) {
  return __async(this, null, function* () {
    var _a, _b, _c, _d;
    try {
      const url = new URL(link);
      url.hostname = "streamtape.com";
      const res = yield fetch(url.toString(), { headers: HEADERS });
      const data = yield res.text();
      let videoSrc = (_c = (_b = (_a = data.match(/document\.getElementById\('videolink'\)\.innerHTML = (.*?);/)) == null ? void 0 : _a[1]) == null ? void 0 : _b.match(/'(\/\/streamtape\.com\/get_video[^']+)'/)) == null ? void 0 : _c[1];
      if (!videoSrc) {
        videoSrc = (_d = data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/)) == null ? void 0 : _d[1];
      }
      return videoSrc ? [{ source: "StreamTape", quality: 720, url: "https:" + videoSrc, headers: { Referer: url } }] : [];
    } catch (e) {
      return [];
    }
  });
}
function hubCloudExtractRedirectUrl(html) {
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
function hubCloudExtractCookieName(html) {
  var m = html.match(/stck\(\s*['"]([\w]+)['"]\s*,/);
  return m ? m[1] : null;
}
function hubCloudHasValidContent($) {
  return $("#size, i#size").length > 0 || $('a:contains("FSL")').length > 0 || $('a:contains("PixelServer")').length > 0 || $("a.btn").length > 0;
}
function hubCloudExtractor(url, referer) {
  return __async(this, null, function* () {
    var _a;
    try {
      let currentUrl = url.replace("hubcloud.ink", "hubcloud.dad");
      const pageResponse = yield fetch(currentUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
      let pageData = yield pageResponse.text();
      let finalUrl = currentUrl;
      var cookieName = hubCloudExtractCookieName(pageData);
      var cookieHeaders = cookieName ? { Cookie: cookieName + '=s4t' } : {};
      if (!currentUrl.includes("hubcloud.php")) {
        let nextHref = "";
        const $first = import_cheerio_without_node_native.default.load(pageData);
        const downloadBtn = $first("#download");
        if (downloadBtn.length) {
          nextHref = downloadBtn.attr("href");
        } else {
          nextHref = hubCloudExtractRedirectUrl(pageData) || "";
        }
        if (nextHref) {
          if (!nextHref.startsWith("http")) {
            const urlObj = new URL(currentUrl);
            nextHref = `${urlObj.protocol}//${urlObj.hostname}/${nextHref.replace(/^\//, "")}`;
          }
          finalUrl = nextHref;
          const secondResponse = yield fetch(finalUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), __spreadValues({ Referer: currentUrl }, cookieHeaders)) });
          pageData = yield secondResponse.text();
        }
      }
      var $ = import_cheerio_without_node_native.default.load(pageData);
      if (!hubCloudHasValidContent($)) {
        yield new Promise(function(r) { setTimeout(r, 1000); });
        var retryResp = yield fetch(currentUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
        var retryData = yield retryResp.text();
        var retryHref = hubCloudExtractRedirectUrl(retryData);
        if (retryHref) {
          if (!retryHref.startsWith("http")) {
            var urlObj2 = new URL(currentUrl);
            retryHref = urlObj2.protocol + '//' + urlObj2.hostname + '/' + retryHref.replace(/^\//, '');
          }
          var retrySecond = yield fetch(retryHref, { headers: __spreadProps(__spreadValues({}, HEADERS), __spreadValues({ Referer: currentUrl }, cookieHeaders)) });
          pageData = yield retrySecond.text();
          $ = import_cheerio_without_node_native.default.load(pageData);
        }
        if (!hubCloudHasValidContent($)) return [];
      }
      const size = $("i#size").text().trim();
      const header = $("div.card-header").text().trim();
      const qualityStr = (_a = header.match(/(\d{3,4})[pP]/)) == null ? void 0 : _a[1];
      const quality = qualityStr ? parseInt(qualityStr) : 1080;
      const headerDetails = cleanTitle(header);
      const labelExtras = (headerDetails ? `[${headerDetails}]` : "") + (size ? `[${size}]` : "");
      const sizeInBytes = (() => {
        const sizeMatch = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
        if (!sizeMatch)
          return 0;
        const multipliers = { GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 };
        return parseFloat(sizeMatch[1]) * (multipliers[sizeMatch[2].toUpperCase()] || 0);
      })();
      const links = [];
      const playbackHeaders = __spreadProps(__spreadValues({}, HEADERS), { Referer: finalUrl });
      const elements = $("a.btn").get();
      for (const element of elements) {
        const link = $(element).attr("href");
        const text = $(element).text().toLowerCase();
        const fileName = header || headerDetails || "Unknown";
        if (text.includes("download file") || text.includes("fsl server") || text.includes("s3 server") || text.includes("fslv2") || text.includes("mega server")) {
          let label = "HubCloud";
          if (text.includes("fsl server"))
            label = "HubCloud - FSL";
          else if (text.includes("s3 server"))
            label = "HubCloud - S3";
          else if (text.includes("fslv2"))
            label = "HubCloud - FSLv2";
          else if (text.includes("mega server"))
            label = "HubCloud - Mega";
          links.push({ source: `${label} ${labelExtras}`, quality, url: link, size: sizeInBytes, fileName, headers: playbackHeaders });
        } else if (text.includes("buzzserver")) {
          try {
            const buzzResp = yield fetch(`${link}/download`, { method: "GET", headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: link }) });
            if (buzzResp.url && buzzResp.url !== `${link}/download`) {
              links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: buzzResp.url, size: sizeInBytes, fileName, headers: playbackHeaders });
            }
          } catch (e) {
          }
        } else if (text.includes("10gbps")) {
          try {
            const resp = yield fetch(link, { method: "GET", redirect: "manual" });
            const loc = resp.headers.get("location");
            if (loc && loc.includes("link=")) {
              const dlink = loc.substring(loc.indexOf("link=") + 5);
              links.push({ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: dlink, size: sizeInBytes, fileName, headers: playbackHeaders });
            }
          } catch (e) {
          }
        } else if (link && link.includes("pixeldra")) {
          const results = yield pixelDrainExtractor(link);
          links.push(...results.map((l) => __spreadProps(__spreadValues({}, l), { source: `${l.source} ${labelExtras}`, size: sizeInBytes, fileName, headers: __spreadValues(__spreadValues({}, playbackHeaders), l.headers || {}) })));
        } else if (link && !link.includes("magnet:") && link.startsWith("http")) {
          const extracted = yield loadExtractor(link, finalUrl);
          links.push(...extracted.map((l) => __spreadProps(__spreadValues({}, l), { quality: l.quality || quality, headers: __spreadValues(__spreadValues({}, playbackHeaders), l.headers || {}) })));
        }
      }
      return links;
    } catch (e) {
      return [];
    }
  });
}
function hubCdnExtractor(url, referer, parentQuality) {
  return __async(this, null, function* () {
    var _a, _b;
    const q = parentQuality || 1080;
    try {
      const response = yield fetch(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
      const data = yield response.text();
      const encoded = (_a = data.match(/r=([A-Za-z0-9+/=]+)/)) == null ? void 0 : _a[1];
      if (encoded) {
        const m3u8Link = atob(encoded).substring(atob(encoded).lastIndexOf("link=") + 5);
        return [{ source: "HubCdn", quality: q, url: m3u8Link }];
      }
      const scriptEncoded = (_b = data.match(/reurl\s*=\s*["']([^"']+)["']/)) == null ? void 0 : _b[1];
      if (scriptEncoded) {
        const queryPart = scriptEncoded.split("?r=").pop();
        const m3u8Link = atob(queryPart).substring(atob(queryPart).lastIndexOf("link=") + 5);
        return [{ source: "HubCdn", quality: q, url: m3u8Link }];
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}
function hubDriveDirectDownload(url, html, referer) {
  return __async(this, null, function* () {
    var _a, _b;
    try {
      const $ = import_cheerio_without_node_native.default.load(html);
      const fileId = ($("#down-id").text().trim() || ((_a = url.match(/\/file\/(\d+)/)) == null ? void 0 : _a[1]) || "").trim();
      if (!fileId)
        return [];
      const response = yield fetch("https://hubdrive.space/ajax.php?ajax=direct-download", {
        method: "POST",
        headers: __spreadProps(__spreadValues({}, HEADERS), {
          Referer: url,
          Origin: "https://hubdrive.space",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest"
        }),
        body: new URLSearchParams({ id: fileId }).toString()
      });
      const data = yield response.json();
      const directUrl = ((_b = data == null ? void 0 : data.data) == null ? void 0 : _b.gd) || (data == null ? void 0 : data.file);
      if (!(data == null ? void 0 : data.code) || String(data.code) !== "200" || !directUrl)
        return [];
      const size = Number(data.data && data.data.s) || 0;
      const fileName = data.data && data.data.n || $("div.card-header").text().trim() || "HubDrive file";
      return [{
        source: "HubDrive Direct",
        quality: 1080,
        url: directUrl.startsWith("http") ? directUrl : new URL(directUrl, url).toString(),
        size,
        fileName,
        headers: { Referer: url },
        behaviorHints: { notWebReady: false }
      }];
    } catch (e) {
      return [];
    }
  });
}
function loadExtractor(_0) {
  return __async(this, arguments, function* (url, referer = MAIN_URL) {
    try {
      const hostname = new URL(url).hostname;
      const isRedirect = url.includes("?id=") || hostname.includes("techyboy4u") || hostname.includes("gadgetsweb.xyz") || hostname.includes("cryptoinsights.site") || hostname.includes("bloggingvector") || hostname.includes("ampproject.org");
      if (isRedirect) {
        const finalLink = yield getRedirectLinks(url);
        if (finalLink && finalLink !== url)
          return yield loadExtractor(finalLink, url);
        return [];
      }
      if (hostname.includes("hubcloud"))
        return yield hubCloudExtractor(url, referer);
      if (hostname.includes("hubcdn"))
        return yield hubCdnExtractor(url, referer);
      if (hostname.includes("hblinks") || hostname.includes("hubstream.dad"))
        return yield hbLinksExtractor(url);
      if (hostname.includes("hubstream") || hostname.includes("vidstack"))
        return yield vidStackExtractor(url);
      if (hostname.includes("pixeldrain"))
        return yield pixelDrainExtractor(url);
      if (hostname.includes("streamtape"))
        return yield streamTapeExtractor(url);
      if (hostname.includes("hdstream4u"))
        return [{ source: "HdStream4u", quality: 1080, url, headers: { Referer: referer || url } }];
      if (hostname.includes("hubdrive")) {
        const res = yield fetch(url, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: referer }) });
        const data = yield res.text();
        const directDownloads = yield hubDriveDirectDownload(url, data, referer);
        if (directDownloads.length > 0)
          return directDownloads;
        const href = import_cheerio_without_node_native.default.load(data)(".btn.btn-primary.btn-user.btn-success1.m-1").attr("href");
        if (href) {
          const extracted = yield loadExtractor(href, url);
          if (extracted.length > 0)
            return extracted;
          if (href.includes("hubcloud")) {
            return [{ source: "HubCloud", quality: 1080, url: href, headers: { Referer: url }, behaviorHints: { notWebReady: true } }];
          }
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  });
}

// src/hdhub4u/index.js
function searchByImdbId(imdbId, season) {
  return __async(this, null, function* () {
    const domain = yield getCurrentDomain();
    const searchUrl = `https://search.pingora.fyi/collections/post/documents/search?query_by=imdb_id&q=${encodeURIComponent(imdbId)}`;
    try {
      const response = yield fetch(searchUrl, {
        headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: `${domain}/` }),
        signal: AbortSignal.timeout(8e3)
      });
      if (!response.ok) return [];
      const data = yield response.json();
      if (!data || !data.hits || data.hits.length === 0) return [];
      return data.hits
        .filter((hit) => {
          if (hit.document.imdb_id !== imdbId) return false;
          if (season) {
            const title = hit.document.post_title;
            const sPadded = String(season).padStart(2, "0");
            return title.includes(`Season ${season}`) || title.includes(`S${season}`) || title.includes(`S${sPadded}`);
          }
          return true;
        })
        .map((hit) => {
          const doc = hit.document;
          const title = doc.post_title;
          const yearMatch = title.match(/\((\d{4})\)|\b(\d{4})\b/);
          const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2]) : null;
          let url = doc.permalink;
          if (url && url.startsWith("/")) {
            url = `${domain}${url}`;
          }
          return { title, url, poster: doc.post_thumbnail, year };
        });
    } catch (e) {
      console.log(`[HDHub4u] IMDB search failed: ${e.message}`);
      return [];
    }
  });
}
function search(query) {
  return __async(this, null, function* () {
    const domain = yield getCurrentDomain();
    const searchUrl = `https://search.pingora.fyi/collections/post/documents/search?q=${encodeURIComponent(query)}&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=15&highlight_fields=none&use_cache=true&page=1`;
    try {
      const response = yield fetch(searchUrl, {
        headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: `${domain}/` }),
        signal: AbortSignal.timeout(8e3)
      });
      if (response.ok) {
        const data = yield response.json();
        if (data && data.hits && data.hits.length > 0) {
          return data.hits.map((hit) => {
            const doc = hit.document;
            const title = doc.post_title;
            const yearMatch = title.match(/\((\d{4})\)|\b(\d{4})\b/);
            const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2]) : null;
            let url = doc.permalink;
            if (url && url.startsWith("/")) {
              url = `${domain}${url}`;
            }
            return { title, url, poster: doc.post_thumbnail, year };
          });
        }
      }
    } catch (e) {
      console.log(`[HDHub4u] Title search failed: ${e.message}`);
    }
    console.log(`[HDHub4u] Falling back to category scraping for: ${query}`);
    return yield searchByScraping(query);
  });
}
function searchByScraping(query) {
  return __async(this, null, function* () {
    const domain = yield getCurrentDomain();
    const results = [];
    const normalizedQuery = query.toLowerCase().replace(/[^\w\s]/g, "");
    const queryWords = normalizedQuery.split(/\s+/).filter((w) => w.length > 2);
    const pagesToScrape = [
      `${domain}/`,
      `${domain}/category/bollywood-movies/`,
      `${domain}/category/hollywood-movies/`,
      `${domain}/category/south-hindi-movies/`,
      `${domain}/category/action-movies/`,
      `${domain}/category/web-series/`
    ];
    for (const pageUrl of pagesToScrape.slice(0, 3)) {
      try {
        const response = yield fetch(pageUrl, {
          headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: `${domain}/` }),
          signal: AbortSignal.timeout(1e4)
        });
        if (!response.ok)
          continue;
        const html = yield response.text();
        const $ = import_cheerio_without_node_native2.default.load(html);
        $('a[data-wpel-link="internal"], a[href*="-movie/"], a[href*="-series/"]').each((_, el) => {
          const $el = $(el);
          let href = $el.attr("href");
          let titleText = $el.find("p").text().trim() || $el.text().trim() || $el.attr("title") || "";
          if (!titleText) {
            const $figure = $el.closest("figure, li, .thumb");
            if ($figure.length) {
              titleText = $figure.find("img").attr("alt") || $figure.find("img").attr("title") || "";
            }
          }
          if (!titleText) {
            titleText = $el.closest("figcaption, .post-title, h2, h3").text().trim();
          }
          if (!href || !titleText || href.includes("/category/") || href.includes("/page/"))
            return;
          const normalizedTitle = titleText.toLowerCase().replace(/[^\w\s]/g, "");
          const matches = queryWords.filter((word) => normalizedTitle.includes(word)).length;
          const matchRatio = queryWords.length > 0 ? matches / queryWords.length : 0;
          if (matchRatio >= 0.4 || normalizedTitle.includes(normalizedQuery)) {
            const yearMatch = titleText.match(/\((\d{4})\)|\b(\d{4})\b/);
            const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2]) : null;
            let fullUrl = href;
            if (href.startsWith("/")) {
              fullUrl = `${domain}${href}`;
            } else if (!href.startsWith("http")) {
              fullUrl = `${domain}/${href}`;
            }
            if (!results.some((r) => r.url === fullUrl)) {
              const $figure = $el.closest("figure, li, .thumb");
              results.push({
                title: titleText,
                url: fullUrl,
                poster: $figure.find("img").attr("src") || $el.find("img").attr("src") || "",
                year,
                _matchScore: matchRatio
              });
            }
          }
        });
      } catch (e) {
        console.log(`[HDHub4u] Error scraping ${pageUrl}: ${e.message}`);
      }
    }
    results.sort((a, b) => b._matchScore - a._matchScore);
    console.log(`[HDHub4u] Scraping found ${results.length} potential matches`);
    return results.slice(0, 10);
  });
}
function fetchExternalHdHubStreams(imdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    if (!imdbId) return [];
    const type = mediaType === "tv" || mediaType === "series" ? "series" : "movie";
    const id = type === "series" && season && episode
      ? `${imdbId}:${season}:${episode}`
      : imdbId;
    const url = `https://hdhub.thevolecitor.qzz.io/stream/${type}/${encodeURIComponent(id)}.json`;
    try {
      const response = yield fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": HEADERS["User-Agent"] },
        signal: AbortSignal.timeout(6e3)
      });
      if (!response.ok) return [];
      const data = yield response.json();
      const streams = Array.isArray(data == null ? void 0 : data.streams) ? data.streams : [];
      return streams
        .filter((stream) => stream && stream.url)
        .map((stream) => {
          const label = String(stream.name || "HDHub4u").trim();
          const qualityMatch = label.match(/\b(4K|2160p|1080p|720p|480p|360p)\b/i);
          const quality = qualityMatch ? qualityMatch[1].replace(/^2160p$/i, "4K") : "Unknown";
          return {
            name: label.replace(/^4KHDHub/i, "HDHub4u"),
            title: stream.description || stream.title || label,
            url: stream.url,
            quality,
            size: stream.size,
            filename: stream.behaviorHints && stream.behaviorHints.filename,
            headers: stream.headers || null,
            provider: "hdhub4u",
            behaviorHints: __spreadValues({
              bingeGroup: "hdhub4u-external",
              notWebReady: true
            }, stream.behaviorHints || {})
          };
        });
    } catch (error) {
      console.log(`[HDHub4u] External fallback failed: ${error.message}`);
      return [];
    }
  });
}
function normalizeCachedFallbackText(value) {
  return String(value || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}
function collectStringsDeep(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectStringsDeep(entry, output));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collectStringsDeep(entry, output));
  }
  return output;
}
function getCachedFallbackFiles() {
  try {
    const fs = require("fs");
    const path = require("path");
    const roots = [
      path.join(process.cwd(), "cache", "fast-results"),
      path.join(process.cwd(), "cache", "stremio-results")
    ];
    return roots.flatMap((root) => {
      try {
        return fs.readdirSync(root)
          .filter((file) => file.endsWith(".json"))
          .map((file) => path.join(root, file));
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
function extractCachedHubCloudUrls(payload) {
  const values = collectStringsDeep(payload);
  const urls = [];
  const addCandidateUrl = (value) => {
    let candidate = String(value || "").replace(/\\\//g, "/");
    try {
      candidate = decodeURIComponent(candidate);
    } catch {}

    try {
      const parsed = new URL(candidate);
      const nestedUrl = parsed.searchParams.get("url");
      if (nestedUrl) {
        candidate = nestedUrl;
      }
    } catch {}

    try {
      candidate = decodeURIComponent(candidate);
    } catch {}

    urls.push(candidate);
  };
  for (const value of values) {
    try {
      if (value.trim().startsWith("[") || value.trim().startsWith("{")) {
        urls.push(...extractCachedHubCloudUrls(JSON.parse(value)));
      }
    } catch {}
    const matches = value.match(/https?:\/\/[^"'\\\s<>]+hubcloud[^"'\\\s<>]+/gi) || [];
    matches.forEach(addCandidateUrl);
    const encodedMatches = value.match(/https%3A%2F%2F[^"'\\\s<>]+hubcloud[^"'\\\s<>]+/gi) || [];
    encodedMatches.forEach(addCandidateUrl);
  }
  return [...new Set(urls)]
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return /hubcloud/i.test(parsed.hostname) && /\/drive\//i.test(parsed.pathname);
      } catch {
        return false;
      }
    });
}
function fetchCachedHubCloudFallbackStreams(mediaInfo, mediaType, season, episode) {
  return __async(this, null, function* () {
    if (mediaType !== "movie") return [];
    const fs = require("fs");
    const titleNeedle = normalizeCachedFallbackText(mediaInfo.title);
    const yearNeedle = mediaInfo.year ? String(mediaInfo.year) : "";
    const tmdbNeedle = mediaInfo.tmdbId ? String(mediaInfo.tmdbId) : "";
    const candidateUrls = [];
    for (const filePath of getCachedFallbackFiles()) {
      let raw = "";
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const normalizedRaw = normalizeCachedFallbackText(raw);
      const matchesTitle = titleNeedle && normalizedRaw.includes(titleNeedle) && (!yearNeedle || normalizedRaw.includes(yearNeedle));
      const matchesTmdb = tmdbNeedle && raw.includes(tmdbNeedle);
      if (!matchesTitle && !matchesTmdb) {
        continue;
      }
      try {
        candidateUrls.push(...extractCachedHubCloudUrls(JSON.parse(raw)));
      } catch {}
    }
    const streams = [];
    for (const hubCloudUrl of [...new Set(candidateUrls)].slice(0, 4)) {
      const links = yield Promise.race([
        hubCloudExtractor(hubCloudUrl, MAIN_URL),
        new Promise((resolve) => setTimeout(() => resolve([]), 12000))
      ]);
      streams.push(...links.map((link) => {
        let qualityStr = "Unknown";
        if (typeof link.quality === "number" && link.quality > 0) {
          if (link.quality >= 2160) qualityStr = "4K";
          else if (link.quality >= 1080) qualityStr = "1080p";
          else if (link.quality >= 720) qualityStr = "720p";
          else if (link.quality >= 480) qualityStr = "480p";
        }
        const sizeLabel = formatBytes(link.size);
        return {
          name: `HDHub4u ${extractServerName(link.source)} ${qualityStr}`,
          title: [
            link.fileName && link.fileName !== "Unknown" ? link.fileName : mediaInfo.title,
            sizeLabel && `💾 ${sizeLabel}`,
            `🔗 ${extractServerName(link.source)} from HDHub4u`
          ].filter(Boolean).join("\n"),
          url: link.url,
          quality: qualityStr,
          size: sizeLabel,
          filename: link.fileName && link.fileName !== "Unknown" ? link.fileName : void 0,
          headers: link.headers || null,
          provider: "hdhub4u",
          behaviorHints: {
            bingeGroup: `hdhub4u-${extractServerName(link.source)}`,
            notWebReady: true,
            ...(link.size ? { videoSize: link.size } : {})
          }
        };
      }));
    }
    const seen = /* @__PURE__ */ new Set();
    return streams.filter((stream) => {
      const key = String(stream.url || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}
function getDownloadLinks(mediaUrl) {
  return __async(this, null, function* () {
    const domain = yield getCurrentDomain();
    mediaUrl = normalizeToCurrentDomain(mediaUrl);
    const fetched = yield fetchTextWithDomainFallback(mediaUrl, { headers: __spreadProps(__spreadValues({}, HEADERS), { Referer: `${domain}/` }) });
    mediaUrl = fetched.url || mediaUrl;
    const data = fetched.text;
    const $ = import_cheerio_without_node_native2.default.load(data);
    const typeRaw = $("h1.page-title span").text();
    const isMovie = typeRaw.toLowerCase().includes("movie");
    if (isMovie) {
      const qualityLinks = $("h3 a, h4 a").filter((i, el) => $(el).text().match(/480|720|1080|2160|4K/i));
      const bodyLinks = $(".page-body > div a").filter((i, el) => {
        const href = $(el).attr("href");
        return href && (href.includes("hdstream4u") || href.includes("hubstream"));
      });
      const parseQualityFromText = (text) => {
        if (/\b(?:4K|2160p?)\b/i.test(text)) return 2160;
        const match = String(text || "").match(/\b(1080|720|480|360)p?\b/i);
        return match ? Number(match[1]) : null;
      };
      const parseSizeFromText = (text) => {
        const match = String(text || "").match(/\[?\s*([0-9]+(?:\.[0-9]+)?)\s*(GB|MB)\s*\]?/i);
        if (!match) return null;
        const value = Number(match[1]);
        if (!Number.isFinite(value)) return null;
        return Math.round(value * (match[2].toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2));
      };
      const linkEntries = [
        ...qualityLinks.map((i, el) => {
          const text = $(el).text();
          return {
            url: $(el).attr("href"),
            quality: parseQualityFromText(text),
            size: parseSizeFromText(text)
          };
        }).get(),
        ...bodyLinks.map((i, el) => ({ url: $(el).attr("href"), quality: null, size: null })).get()
      ];
      const seenInitialUrls = /* @__PURE__ */ new Set();
      const initialLinks = linkEntries.filter((entry) => {
        if (!entry.url || seenInitialUrls.has(entry.url)) return false;
        seenInitialUrls.add(entry.url);
        return true;
      });
      const results = yield Promise.all(initialLinks.map((entry) => __async(this, null, function* () {
        const extracted = yield loadExtractor(entry.url, mediaUrl);
        return extracted.map((link) => __spreadProps(__spreadValues({}, link), {
          quality: entry.quality || link.quality,
          size: entry.size || link.size
        }));
      })));
      const allFinalLinks = results.flat();
      const seenUrls = /* @__PURE__ */ new Set();
      const uniqueFinalLinks = allFinalLinks.filter((link) => {
        var _a;
        if (!link.url || link.url.includes(".zip") || ((_a = link.name) == null ? void 0 : _a.toLowerCase().includes(".zip")))
          return false;
        if (seenUrls.has(link.url))
          return false;
        seenUrls.add(link.url);
        return true;
      });
      return { finalLinks: uniqueFinalLinks, isMovie };
    } else {
      const episodeLinksMap = /* @__PURE__ */ new Map();
      const directLinkBlocks = [];
      $("h3, h4").each((i, element) => {
        const $el = $(element);
        const text = $el.text();
        const anchors = $el.find("a");
        const links = anchors.map((i2, a) => $(a).attr("href")).get();
        const isDirectLinkBlock = anchors.get().some((a) => $(a).text().match(/1080|720|4K|2160/i));
        if (isDirectLinkBlock) {
          directLinkBlocks.push(...links);
          return;
        }
        const episodeMatch = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
        if (episodeMatch) {
          const epNum = parseInt(episodeMatch[1] || episodeMatch[2]);
          if (!episodeLinksMap.has(epNum))
            episodeLinksMap.set(epNum, []);
          episodeLinksMap.get(epNum).push(...links);
          let nextElement = $el.next();
          while (nextElement.length && nextElement.get(0).tagName !== "hr") {
            const siblingLinks = nextElement.find("a[href]").map((i2, a) => $(a).attr("href")).get();
            episodeLinksMap.get(epNum).push(...siblingLinks);
            nextElement = nextElement.next();
          }
        }
      });
      if (directLinkBlocks.length > 0) {
        yield Promise.all(directLinkBlocks.map((blockUrl) => __async(this, null, function* () {
          try {
            const resolvedUrl = yield getRedirectLinks(blockUrl);
            if (!resolvedUrl)
              return;
            const blockRes = yield fetch(resolvedUrl, { headers: HEADERS });
            const blockData = yield blockRes.text();
            const $$ = import_cheerio_without_node_native2.default.load(blockData);
            $$("h5 a, h4 a, h3 a").each((i, el) => {
              const linkText = $$(el).text();
              const linkHref = $$(el).attr("href");
              const epMatch = linkText.match(/Episode\s*(\d+)/i);
              if (epMatch && linkHref) {
                const epNum = parseInt(epMatch[1]);
                if (!episodeLinksMap.has(epNum))
                  episodeLinksMap.set(epNum, []);
                episodeLinksMap.get(epNum).push(linkHref);
              }
            });
          } catch (e) {
          }
        })));
      }
      const initialLinks = [];
      episodeLinksMap.forEach((links, epNum) => {
        const uniqueLinks = [...new Set(links)];
        initialLinks.push(...uniqueLinks.map((link) => ({ url: link, episode: epNum })));
      });
      const results = yield Promise.all(initialLinks.map((linkInfo) => __async(this, null, function* () {
        try {
          const extracted = yield loadExtractor(linkInfo.url, mediaUrl);
          return extracted.map((ext) => __spreadProps(__spreadValues({}, ext), { episode: linkInfo.episode }));
        } catch (e) {
          return [];
        }
      })));
      const allFinalLinks = results.flat();
      const seenUrls = /* @__PURE__ */ new Set();
      const uniqueFinalLinks = allFinalLinks.filter((link) => {
        if (!link.url || link.url.includes(".zip"))
          return false;
        if (seenUrls.has(link.url))
          return false;
        seenUrls.add(link.url);
        return true;
      });
      return { finalLinks: uniqueFinalLinks, isMovie };
    }
  });
}
function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  return __async(this, null, function* () {
    console.log(`[HDHub4u] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
      const mediaInfo = yield getTMDBDetails(tmdbId, mediaType);
      mediaInfo.tmdbId = tmdbId;
      console.log(`[HDHub4u] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || "N/A"}) [IMDB: ${mediaInfo.imdbId || "N/A"}]`);
      let searchResults = [];
      let usedImdbSearch = false;
      if (mediaInfo.imdbId) {
        console.log(`[HDHub4u] Searching by IMDB ID: ${mediaInfo.imdbId}`);
        searchResults = yield searchByImdbId(mediaInfo.imdbId, mediaType === "tv" ? season : null);
        if (searchResults.length > 0) {
          usedImdbSearch = true;
          console.log(`[HDHub4u] IMDB search found ${searchResults.length} result(s)`);
        }
        if (searchResults.length === 0) {
          const externalStreams = yield fetchExternalHdHubStreams(mediaInfo.imdbId, mediaType, season, episode);
          if (externalStreams.length > 0) {
            return externalStreams;
          }
          const cachedFallbackStreams = yield fetchCachedHubCloudFallbackStreams(mediaInfo, mediaType, season, episode);
          if (cachedFallbackStreams.length > 0) {
            return cachedFallbackStreams;
          }
        }
      }
      if (searchResults.length === 0) {
        if (mediaInfo.imdbId) {
          console.log(`[HDHub4u] IMDB search found no matching posts`);
        }
        console.log(`[HDHub4u] Falling back to title search`);
        const searchTitle = sanitizeSearchQueryTitle(mediaInfo.title);
        const searchMediaInfo = __spreadProps(__spreadValues({}, mediaInfo), { title: searchTitle || mediaInfo.title });
        const searchQueries = [
          mediaType === "tv" && season ? `${searchMediaInfo.title} Season ${season}` : searchMediaInfo.title,
          mediaInfo.year ? `${searchMediaInfo.title} ${mediaInfo.year}` : null,
          searchMediaInfo.title
        ].filter(Boolean);
        const seenResultUrls = /* @__PURE__ */ new Set();
        for (const searchQuery of searchQueries) {
          const queryResults = yield search(searchQuery);
          for (const result of queryResults) {
            if (!(result == null ? void 0 : result.url) || seenResultUrls.has(result.url)) {
              continue;
            }
            seenResultUrls.add(result.url);
            searchResults.push(result);
          }
          if (findBestTitleMatch(searchMediaInfo, searchResults, mediaType, season)) {
            break;
          }
        }
        if (searchMediaInfo.title !== mediaInfo.title) {
          mediaInfo.title = searchMediaInfo.title;
        }
      }
      if (searchResults.length === 0)
        return (yield fetchExternalHdHubStreams(mediaInfo.imdbId, mediaType, season, episode))
          .concat(yield fetchCachedHubCloudFallbackStreams(mediaInfo, mediaType, season, episode));
      const bestMatch = findBestTitleMatch(mediaInfo, searchResults, mediaType, season);
      if (!bestMatch && !usedImdbSearch) {
        console.log(`[HDHub4u] No reliable title match found`);
        return (yield fetchExternalHdHubStreams(mediaInfo.imdbId, mediaType, season, episode))
          .concat(yield fetchCachedHubCloudFallbackStreams(mediaInfo, mediaType, season, episode));
      }
      const selectedMedia = bestMatch || searchResults[0];
      const selectedMediaList = usedImdbSearch ? searchResults : [selectedMedia];
      console.log(`[HDHub4u] Selected ${selectedMediaList.length} page(s)`);
      const pageResults = yield Promise.all(selectedMediaList.map((media) => __async(this, null, function* () {
        console.log(`[HDHub4u] Selected: "${media.title}" (${media.url})`);
        return yield getDownloadLinks(media.url);
      })));
      const finalLinks = pageResults.flatMap((result) => result.finalLinks);
      let filteredLinks = finalLinks;
      if (mediaType === "tv" && episode !== null) {
        filteredLinks = finalLinks.filter((link) => link.episode === episode);
      }
      filteredLinks = yield filterPlayableLinks(filteredLinks);
      const streams = filteredLinks.map((link) => {
        let mediaTitle = link.fileName && link.fileName !== "Unknown" ? link.fileName : mediaInfo.title;
        if (mediaType === "tv" && season && episode) {
          mediaTitle = `${mediaInfo.title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
        }
        const serverName = extractServerName(link.source);
        let qualityStr = "Unknown";
        if (typeof link.quality === "number" && link.quality > 0) {
          if (link.quality >= 2160)
            qualityStr = "4K";
          else if (link.quality >= 1080)
            qualityStr = "1080p";
          else if (link.quality >= 720)
            qualityStr = "720p";
          else if (link.quality >= 480)
            qualityStr = "480p";
        } else if (typeof link.quality === "string") {
          qualityStr = link.quality;
        }
        const sizeLabel = formatBytes(link.size);
        const titleLines = [mediaTitle];
        if (qualityStr !== "Unknown") titleLines[0] += ` ${qualityStr}`;
        if (sizeLabel) titleLines.push("\uD83D\uDCBE " + sizeLabel);
        titleLines.push("\uD83D\uDD17 " + serverName + " from HDHub4u");

        return {
          name: `HDHub4u ${serverName} ${qualityStr}`,
          title: titleLines.join("\n"),
          url: link.url,
          quality: qualityStr,
          size: sizeLabel,
          filename: link.fileName && link.fileName !== "Unknown" ? link.fileName : void 0,
          headers: link.headers || null,
          provider: "hdhub4u",
          behaviorHints: {
            bingeGroup: `hdhub4u-${serverName}`,
            notWebReady: false,
            ...((link.behaviorHints && typeof link.behaviorHints === "object") ? link.behaviorHints : {}),
            ...(link.size ? { videoSize: link.size } : {})
          }
        };
      });
      const qualityOrder = { "4K": 4, "1080p": 2, "720p": 1, "480p": 0, "Unknown": -2 };
      const sortedStreams = streams.sort((a, b) => (qualityOrder[b.quality] || -3) - (qualityOrder[a.quality] || -3));
      if (sortedStreams.length > 0) {
        return sortedStreams;
      }
      return (yield fetchExternalHdHubStreams(mediaInfo.imdbId, mediaType, season, episode))
        .concat(yield fetchCachedHubCloudFallbackStreams(mediaInfo, mediaType, season, episode));
    } catch (error) {
      console.error(`[HDHub4u] Scraping error: ${error.message}`);
      return yield fetchCachedHubCloudFallbackStreams({ tmdbId, title: "", year: null }, mediaType, season, episode);
    }
  });
}
module.exports = { getStreams };
