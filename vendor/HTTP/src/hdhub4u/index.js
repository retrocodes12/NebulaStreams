import cheerio from 'cheerio-without-node-native';
import { HEADERS, MAIN_URL } from './constants.js';
import { 
  getCurrentDomain, getTMDBDetails, findBestTitleMatch, 
  extractServerName, formatBytes, sanitizeSearchQueryTitle
} from './utils.js';
import { loadExtractor, getRedirectLinks } from './extractors.js';

const PLAYABLE_CHECK_TIMEOUT_MS = 7000;
const PLAYABLE_EXTENSION_PATTERN = /\.(?:mp4|mkv|webm|m3u8)(?:[?#]|$)/i;
const HTML_WRAPPER_HOSTS = new Set(['hubcdn.fans']);
const RESOLVABLE_WRAPPER_HOST_PATTERNS = [/hubcloud/i];

function normalizeStreamUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return '';
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
  return PLAYABLE_EXTENSION_PATTERN.test(String(value || ''));
}

function isResolvableWrapperLink(link) {
  const rawUrl = normalizeStreamUrl(link?.url);
  if (!rawUrl) return false;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return RESOLVABLE_WRAPPER_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

function isTrustedExtractorLink(link) {
  const url = normalizeStreamUrl(link?.url);
  if (!url || isKnownHtmlWrapperUrl(url)) return false;
  const source = String(link?.source || "").toLowerCase();
  return source.startsWith("hubcloud")
    || source.startsWith("pixeldrain")
    || source.startsWith("streamtape")
    || source.startsWith("hdstream4u")
    || source.startsWith("hblinks")
    || source.startsWith("hubstream")
    || source.startsWith("hubcdn");
}

async function resolvePlayableLink(link) {
  const url = normalizeStreamUrl(link?.url);
  if (!url || isKnownHtmlWrapperUrl(url)) return null;

  if (hasPlayableExtension(url)) {
    return { ...link, url, headers: link.headers || null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLAYABLE_CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        ...(link?.headers || {}),
        Range: 'bytes=0-1023'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const contentLength = Number.parseInt(res.headers.get('content-length') || '0', 10);
    const contentRange = String(res.headers.get('content-range') || '');
    const finalUrl = normalizeStreamUrl(res.url || url);
    await res.body?.cancel?.();

    if (!res.ok && res.status !== 206) return null;
    if (contentType.includes('text/html')) return null;

    const videoLike = contentType.startsWith('video/')
      || contentType.includes('mpegurl')
      || contentType.includes('application/vnd.apple.mpegurl')
      || (contentType.includes('application/octet-stream') && (hasPlayableExtension(finalUrl) || contentLength > 1048576))
      || Boolean(contentRange);

    return videoLike ? { ...link, url: finalUrl, headers: link.headers || null } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function filterPlayableLinks(links) {
  const output = [];
  const seen = new Set();
  const resolvedLinks = await Promise.all((Array.isArray(links) ? links : []).map(async (link) => {
    if (isResolvableWrapperLink(link)) {
      const wrapperUrl = normalizeStreamUrl(link.url);
      return {
        ...link,
        url: wrapperUrl,
        headers: link.headers || null,
        behaviorHints: { ...(link.behaviorHints || {}), notWebReady: true }
      };
    }

    if (isTrustedExtractorLink(link)) {
      return {
        ...link,
        url: normalizeStreamUrl(link.url),
        headers: link.headers || null
      };
    }

    return await resolvePlayableLink(link);
  }));

  for (const playable of resolvedLinks) {
    if (!playable) continue;
    const key = normalizeStreamUrl(playable.url);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(playable);
  }

  return output;
}

async function searchByImdbId(imdbId, season) {
  const domain = await getCurrentDomain();
  const searchUrl = `https://search.pingora.fyi/collections/post/documents/search?query_by=imdb_id&q=${encodeURIComponent(imdbId)}`;
  
  try {
    const response = await fetch(searchUrl, { 
      headers: { ...HEADERS, Referer: `${domain}/` },
      signal: AbortSignal.timeout(8000) 
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (!data || !data.hits || data.hits.length === 0) return [];
    
    return data.hits
      .filter(hit => {
        if (hit.document.imdb_id !== imdbId) return false;
        if (season) {
          const title = hit.document.post_title;
          const sPadded = String(season).padStart(2, '0');
          return title.includes(`Season ${season}`) || title.includes(`S${season}`) || title.includes(`S${sPadded}`);
        }
        return true;
      })
      .map(hit => {
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
}

async function search(query) {
  const domain = await getCurrentDomain();
  const searchUrl = `https://search.pingora.fyi/collections/post/documents/search?q=${encodeURIComponent(query)}&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=15&highlight_fields=none&use_cache=true&page=1`;
  
  try {
    const response = await fetch(searchUrl, { 
      headers: { ...HEADERS, Referer: `${domain}/` },
      signal: AbortSignal.timeout(8000) 
    });
    if (response.ok) {
      const data = await response.json();
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
  return await searchByScraping(query);
}

async function searchByScraping(query) {
  const domain = await getCurrentDomain();
  const results = [];
  const normalizedQuery = query.toLowerCase().replace(/[^\w\s]/g, '');
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 2);
  
  // Pages to scrape: homepage + popular categories
  const pagesToScrape = [
    `${domain}/`,
    `${domain}/category/bollywood-movies/`,
    `${domain}/category/hollywood-movies/`,
    `${domain}/category/south-hindi-movies/`,
    `${domain}/category/action-movies/`,
    `${domain}/category/web-series/`
  ];
  
  for (const pageUrl of pagesToScrape.slice(0, 3)) { // Limit to first 3 for speed
    try {
      const response = await fetch(pageUrl, { 
        headers: { ...HEADERS, Referer: `${domain}/` },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) continue;
      
      const html = await response.text();
      const $ = cheerio.load(html);
      
      // hdhub4u DOM: <figure><img alt="TITLE"><a href="URL"></a></figure><figcaption><a><p>TITLE</p></a></figcaption>
      // Match any internal link to a movie page
      $('a[data-wpel-link="internal"], a[href*="-movie/"], a[href*="-series/"]').each((_, el) => {
        const $el = $(el);
        let href = $el.attr('href');
        
        // Get title from adjacent elements (img alt/title, or <p> in figcaption)
        let titleText = $el.find('p').text().trim() || $el.text().trim() || $el.attr('title') || '';
        if (!titleText) {
          // Try getting from sibling/previous img
          const $figure = $el.closest('figure, li, .thumb');
          if ($figure.length) {
            titleText = $figure.find('img').attr('alt') || $figure.find('img').attr('title') || '';
          }
        }
        // Also try parent's text
        if (!titleText) {
          titleText = $el.closest('figcaption, .post-title, h2, h3').text().trim();
        }
        
        if (!href || !titleText || href.includes('/category/') || href.includes('/page/')) return;
        
        // Normalize title for matching
        const normalizedTitle = titleText.toLowerCase().replace(/[^\w\s]/g, '');
        
        // Check if query words appear in title
        const matches = queryWords.filter(word => normalizedTitle.includes(word)).length;
        const matchRatio = queryWords.length > 0 ? matches / queryWords.length : 0;
        
        if (matchRatio >= 0.4 || normalizedTitle.includes(normalizedQuery)) {
          const yearMatch = titleText.match(/\((\d{4})\)|\b(\d{4})\b/);
          const year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2]) : null;
          
          let fullUrl = href;
          if (href.startsWith('/')) {
            fullUrl = `${domain}${href}`;
          } else if (!href.startsWith('http')) {
            fullUrl = `${domain}/${href}`;
          }
          
          // Avoid duplicates
          if (!results.some(r => r.url === fullUrl)) {
            const $figure = $el.closest('figure, li, .thumb');
            results.push({
              title: titleText,
              url: fullUrl,
              poster: $figure.find('img').attr('src') || $el.find('img').attr('src') || '',
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
  
  // Sort by match score
  results.sort((a, b) => b._matchScore - a._matchScore);
  
  console.log(`[HDHub4u] Scraping found ${results.length} potential matches`);
  return results.slice(0, 10); // Return top 10
}

async function getDownloadLinks(mediaUrl) {
  const domain = await getCurrentDomain();
  const response = await fetch(mediaUrl, { headers: { ...HEADERS, Referer: `${domain}/` } });
  const data = await response.text();
  const $ = cheerio.load(data);
  
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
    const seenInitialUrls = new Set();
    const initialLinks = linkEntries.filter((entry) => {
      if (!entry.url || seenInitialUrls.has(entry.url)) return false;
      seenInitialUrls.add(entry.url);
      return true;
    });
    
    const results = await Promise.all(initialLinks.map(async (entry) => {
      const extracted = await loadExtractor(entry.url, mediaUrl);
      return extracted.map((link) => ({
        ...link,
        quality: entry.quality || link.quality,
        size: entry.size || link.size
      }));
    }));
    const allFinalLinks = results.flat();
    
    const seenUrls = new Set();
    const uniqueFinalLinks = allFinalLinks.filter(link => {
      if (!link.url || link.url.includes(".zip") || link.name?.toLowerCase().includes(".zip")) return false;
      if (seenUrls.has(link.url)) return false;
      seenUrls.add(link.url);
      return true;
    });
    
    return { finalLinks: uniqueFinalLinks, isMovie };
  } else {
    // TV Logic
    const episodeLinksMap = new Map();
    const directLinkBlocks = [];

    $("h3, h4").each((i, element) => {
      const $el = $(element);
      const text = $el.text();
      const anchors = $el.find("a");
      const links = anchors.map((i2, a) => $(a).attr("href")).get();
      
      const isDirectLinkBlock = anchors.get().some(a => $(a).text().match(/1080|720|4K|2160/i));
      if (isDirectLinkBlock) {
          directLinkBlocks.push(...links);
          return;
      }

      const episodeMatch = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
      if (episodeMatch) {
        const epNum = parseInt(episodeMatch[1] || episodeMatch[2]);
        if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);
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
        await Promise.all(directLinkBlocks.map(async (blockUrl) => {
            try {
                const resolvedUrl = await getRedirectLinks(blockUrl);
                if (!resolvedUrl) return;
                const blockRes = await fetch(resolvedUrl, { headers: HEADERS });
                const blockData = await blockRes.text();
                const $$ = cheerio.load(blockData);
                $$("h5 a, h4 a, h3 a").each((i, el) => {
                    const linkText = $$(el).text();
                    const linkHref = $$(el).attr("href");
                    const epMatch = linkText.match(/Episode\s*(\d+)/i);
                    if (epMatch && linkHref) {
                        const epNum = parseInt(epMatch[1]);
                        if (!episodeLinksMap.has(epNum)) episodeLinksMap.set(epNum, []);
                        episodeLinksMap.get(epNum).push(linkHref);
                    }
                });
            } catch (e) {}
        }));
    }
    
    const initialLinks = [];
    episodeLinksMap.forEach((links, epNum) => {
      const uniqueLinks = [...new Set(links)];
      initialLinks.push(...uniqueLinks.map(link => ({ url: link, episode: epNum })));
    });
    
    const results = await Promise.all(initialLinks.map(async (linkInfo) => {
        try {
            const extracted = await loadExtractor(linkInfo.url, mediaUrl);
            return extracted.map(ext => ({ ...ext, episode: linkInfo.episode }));
        } catch (e) { return []; }
    }));
    
    const allFinalLinks = results.flat();
    const seenUrls = new Set();
    const uniqueFinalLinks = allFinalLinks.filter(link => {
        if (!link.url || link.url.includes(".zip")) return false;
        if (seenUrls.has(link.url)) return false;
        seenUrls.add(link.url);
        return true;
    });
    
    return { finalLinks: uniqueFinalLinks, isMovie };
  }
}

async function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
  console.log(`[HDHub4u] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
  try {
    const mediaInfo = await getTMDBDetails(tmdbId, mediaType);
    console.log(`[HDHub4u] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || "N/A"}) [IMDB: ${mediaInfo.imdbId || "N/A"}]`);
    
    // Try IMDB ID search first (most reliable via pingora)
    let searchResults = [];
    let usedImdbSearch = false;
    if (mediaInfo.imdbId) {
      console.log(`[HDHub4u] Searching by IMDB ID: ${mediaInfo.imdbId}`);
      searchResults = await searchByImdbId(mediaInfo.imdbId, mediaType === "tv" ? season : null);
      if (searchResults.length > 0) {
        usedImdbSearch = true;
        console.log(`[HDHub4u] IMDB search found ${searchResults.length} result(s)`);
      }
    }
    
    if (searchResults.length === 0) {
      if (mediaInfo.imdbId) {
        console.log(`[HDHub4u] IMDB search found no matching posts`);
      }
      console.log(`[HDHub4u] Falling back to title search`);
      const searchTitle = sanitizeSearchQueryTitle(mediaInfo.title);
      const searchMediaInfo = { ...mediaInfo, title: searchTitle || mediaInfo.title };
      const searchQueries = [
        mediaType === "tv" && season ? `${searchMediaInfo.title} Season ${season}` : searchMediaInfo.title,
        mediaInfo.year ? `${searchMediaInfo.title} ${mediaInfo.year}` : null,
        searchMediaInfo.title
      ].filter(Boolean);
      const seenResultUrls = new Set();

      for (const searchQuery of searchQueries) {
        const queryResults = await search(searchQuery);

        for (const result of queryResults) {
          if (!result?.url || seenResultUrls.has(result.url)) {
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
    
    if (searchResults.length === 0) return [];
    
    const bestMatch = findBestTitleMatch(mediaInfo, searchResults, mediaType, season);
    if (!bestMatch && !usedImdbSearch) {
      console.log(`[HDHub4u] No reliable title match found`);
      return [];
    }
    const selectedMedia = bestMatch || searchResults[0];
    const selectedMediaList = usedImdbSearch ? searchResults : [selectedMedia];
    console.log(`[HDHub4u] Selected ${selectedMediaList.length} page(s)`);
    
    const pageResults = await Promise.all(selectedMediaList.map(async (media) => {
      console.log(`[HDHub4u] Selected: "${media.title}" (${media.url})`);
      return await getDownloadLinks(media.url);
    }));
    const finalLinks = pageResults.flatMap(result => result.finalLinks);
    let filteredLinks = finalLinks;
    
    if (mediaType === "tv" && episode !== null) {
      filteredLinks = finalLinks.filter(link => link.episode === episode);
    }

    filteredLinks = await filterPlayableLinks(filteredLinks);
    
    const streams = filteredLinks.map(link => {
      let mediaTitle = link.fileName && link.fileName !== "Unknown" ? link.fileName : mediaInfo.title;
      if (mediaType === "tv" && season && episode) {
          mediaTitle = `${mediaInfo.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      }
      
      const serverName = extractServerName(link.source);
      let qualityStr = "Unknown";
      if (typeof link.quality === "number" && link.quality > 0) {
          if (link.quality >= 2160) qualityStr = "4K";
          else if (link.quality >= 1080) qualityStr = "1080p";
          else if (link.quality >= 720) qualityStr = "720p";
          else if (link.quality >= 480) qualityStr = "480p";
      } else if (typeof link.quality === "string") {
          qualityStr = link.quality;
      }
      
      return {
        name: `HDHub4u ${serverName}`,
        title: mediaTitle,
        url: link.url,
        quality: qualityStr,
        size: formatBytes(link.size),
        headers: link.headers || null,
        provider: "hdhub4u",
        behaviorHints: {
          ...(link.behaviorHints && typeof link.behaviorHints === "object" ? link.behaviorHints : {})
        }
      };
    });
    
    const qualityOrder = { "4K": 4, "1080p": 2, "720p": 1, "480p": 0, "Unknown": -2 };
    return streams.sort((a, b) => (qualityOrder[b.quality] || -3) - (qualityOrder[a.quality] || -3));
  } catch (error) {
    console.error(`[HDHub4u] Scraping error: ${error.message}`);
    return [];
  }
}

module.exports = { getStreams };
