require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');
const fs        = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const META_BASE_URL = `https://graph.facebook.com/v22.0`;

// Non-blocking cache write (fire-and-forget)
function saveCacheAsync(filePath, data) {
  fs.writeFile(filePath, JSON.stringify(data), err => {
    if (err) console.error(`Cache write error (${path.basename(filePath)}):`, err.message);
  });
}

// ── File-based cache for creative info (30 day TTL) ─────────────────────────
const CACHE_FILE = path.join(__dirname, '.cache-creatives.json');
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

function slimCreative(ad) {
  const c = ad.creative;
  if (!c) return { id: ad.id, creative: null, _cachedAt: ad._cachedAt || Date.now() };
  return {
    id: ad.id,
    creative: {
      id:           c.id,
      name:         c.name || '',
      object_type:  c.object_type || '',
      primary_text: c.primary_text || '',
      is_catalog:   !!c.object_story_spec?.template_data,
    },
    _cachedAt: ad._cachedAt || Date.now(),
  };
}

function loadCacheFromFile() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const now = Date.now();
      const filtered = {};
      let migrated = false;
      for (const [id, entry] of Object.entries(raw)) {
        if (entry._cachedAt && (now - entry._cachedAt) > CACHE_TTL) continue;
        // Auto-migrate old bulky entries to slim format
        if (entry.creative?.object_story_spec || entry.creative?.asset_feed_spec) {
          const primaryText = entry.creative?.asset_feed_spec?.bodies?.[0]?.text
            || entry.creative?.object_story_spec?.link_data?.message
            || entry.creative?.object_story_spec?.video_data?.message
            || entry.creative?.object_story_spec?.photo_data?.message
            || entry.creative?.name || '';
          filtered[id] = slimCreative({ ...entry, creative: { ...entry.creative, primary_text: primaryText } });
          migrated = true;
        } else {
          filtered[id] = entry;
        }
      }
      if (migrated) saveCacheAsync(CACHE_FILE, filtered);
      return filtered;
    }
  } catch (e) { console.error('Cache read error:', e.message); }
  return {};
}

let creativeCache = loadCacheFromFile();

// ── File-based cache for insights (survive server restart) ──────────────────
const INSIGHTS_CACHE_FILE = path.join(__dirname, '.cache-insights.json');

function loadInsightsCacheFromFile() {
  try {
    if (fs.existsSync(INSIGHTS_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(INSIGHTS_CACHE_FILE, 'utf8'));
    }
  } catch (e) { console.error('Insights cache read error:', e.message); }
  return {};
}

let insightsCache = loadInsightsCacheFromFile();

// ── File-based cache for HD thumbnails (creative_id → {url, _cachedAt}) ──────
const HD_THUMB_CACHE_FILE = path.join(__dirname, '.cache-hd-thumbs.json');
const HD_THUMB_TTL = 24 * 60 * 60 * 1000; // 24 hours (Meta CDN URLs expire quickly)

function loadHdThumbCache() {
  try {
    if (fs.existsSync(HD_THUMB_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HD_THUMB_CACHE_FILE, 'utf8'));
      const now = Date.now();
      const filtered = {};
      let changed = false;
      for (const [id, entry] of Object.entries(raw)) {
        if (typeof entry === 'string') { changed = true; continue; }
        if (entry._cachedAt && (now - entry._cachedAt) > HD_THUMB_TTL) { changed = true; continue; }
        filtered[id] = entry;
      }
      if (changed) saveCacheAsync(HD_THUMB_CACHE_FILE, filtered);
      return filtered;
    }
  } catch (e) { console.error('HD thumb cache read error:', e.message); }
  return {};
}

let hdThumbCache = loadHdThumbCache();

const AD_METRICS = [
  'impressions', 'clicks', 'spend', 'reach',
  'ctr', 'cpc', 'cpm',
  'actions', 'action_values',
  'frequency',
  'unique_clicks', 'unique_ctr',
].join(',');

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function getCredentials(req) {
  const token = req.headers['x-meta-token'] || process.env.META_ACCESS_TOKEN || '';
  const rawAccount = (req.headers['x-meta-account-id'] || process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, '');
  return {
    token:     /^[A-Za-z0-9_\-]+$/.test(token) ? token : '',
    accountId: /^[0-9]+$/.test(rawAccount) ? rawAccount : '',
  };
}

// Async report: create → poll → fetch all results
async function fetchInsightsAsync(base, token, fields, timeRange, onProgress) {
  // 1. Create async report via POST
  const createRes = await axios.post(`${base}/insights`, null, {
    params: {
      access_token: token, level: 'ad', fields,
      time_range: JSON.stringify(timeRange),
    },
  });

  // Meta may return data directly for small datasets (GET-like response)
  if (createRes.data.data) {
    return createRes.data.data;
  }

  const reportId = createRes.data.report_run_id;
  if (!reportId) {
    throw new Error('No report_run_id returned from Meta');
  }

  // 2. Poll until complete (max 2 min)
  for (let i = 0; i < 60; i++) {
    const poll = await axios.get(`${META_BASE_URL}/${reportId}`, {
      params: { access_token: token },
    });
    const status = poll.data.async_status;
    const pct = poll.data.async_percent_completion || 0;
    if (onProgress) onProgress(status, pct);
    if (status === 'Job Completed') break;
    if (status === 'Job Failed' || status === 'Job Skipped') {
      throw new Error(`Async report ${status}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // 3. Fetch all results with pagination
  const results = [];
  let url = `${META_BASE_URL}/${reportId}/insights`;
  let params = { access_token: token, limit: 500 };
  while (url) {
    const res = await axios.get(url, { params });
    results.push(...(res.data.data || []));
    const next = res.data.paging?.next || null;
    url = next;
    params = next ? {} : null; // next URL has params embedded, just pass empty
  }
  return results;
}

function findPurchaseAction(arr = []) {
  return arr.find(x => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
}

// Fetch ads by IDs in batches (max 50 per request to avoid URL length limit)
async function fetchAdsByIds(token, adIds, fields) {
  if (!adIds.length) return [];
  const results = [];
  const BATCH = 50;
  for (let i = 0; i < adIds.length; i += BATCH) {
    const batch = adIds.slice(i, i + BATCH);
    try {
      const res = await axios.get(`${META_BASE_URL}/`, {
        params: { ids: batch.join(','), fields, access_token: token }
      });
      for (const [id, data] of Object.entries(res.data)) {
        if (data && !data.error) results.push(data);
      }
    } catch (err) {
      console.error(`Batch fetch failed (${batch.length} ads):`, err.response?.data?.error?.message || err.message);
    }
  }
  return results;
}

function groupByAdName(rows) {
  const map = {};
  for (const row of rows) {
    const name = row.ad_name || 'unknown';
    if (!map[name]) map[name] = { ad_name: name, _rows: [] };
    map[name]._rows.push(row);
  }
  return Object.values(map).map(({ _rows, ...entry }) => {
    // Thumbnail of the ad with highest spend, fallback to any ad with a thumbnail
    const topAd = _rows.reduce((best, r) => parseFloat(r.spend || 0) > parseFloat(best.spend || 0) ? r : best, _rows[0]);
    entry.thumbnail_url = topAd?.thumbnail_url
      || _rows.find(r => r.thumbnail_url)?.thumbnail_url
      || null;
    entry.is_catalog = !!topAd?.is_catalog;

    const sum = fn => _rows.reduce((s, r) => s + fn(r), 0);
    for (const f of ['impressions', 'clicks', 'spend', 'reach', 'unique_clicks', 'frequency']) {
      entry[f] = sum(r => parseFloat(r[f] || 0));
    }
    entry.ctr = entry.impressions ? (entry.clicks / entry.impressions * 100).toFixed(2) : '0';
    entry.cpc = entry.clicks      ? (entry.spend  / entry.clicks).toFixed(2)             : '0';
    entry.cpm = entry.impressions ? (entry.spend  / entry.impressions * 1000).toFixed(2) : '0';
    entry.purchase_count = sum(r => parseFloat(findPurchaseAction(r.actions)?.value       || 0));
    entry.purchase_value = sum(r => parseFloat(findPurchaseAction(r.action_values)?.value || 0));
    entry.roas = entry.spend > 0 && entry.purchase_value > 0 ? entry.purchase_value / entry.spend : 0;
    entry.cpr  = entry.purchase_count > 0 ? entry.spend / entry.purchase_count : 0;
    entry.aov  = entry.purchase_count > 0 ? entry.purchase_value / entry.purchase_count : 0;
    return entry;
  });
}

function buildPrimaryTextMap(allAds) {
  const map = {};
  for (const ad of allAds) {
    const cid = ad.creative?.id;
    if (!cid) continue;
    // Try asset_feed_spec first (carousel/dynamic ads)
    const text = ad.creative?.asset_feed_spec?.bodies?.[0]?.text
      // Fallback: object_story_spec (single image/video ads)
      || ad.creative?.object_story_spec?.link_data?.message
      || ad.creative?.object_story_spec?.video_data?.message
      || ad.creative?.object_story_spec?.photo_data?.message
      // Fallback: creative name
      || ad.creative?.name
      || '';
    if (text) map[cid] = text;
  }
  return map;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    hasMetaToken:   !!process.env.META_ACCESS_TOKEN,
    hasAdAccountId: !!process.env.META_AD_ACCOUNT_ID,
    hasClaudeKey:   !!process.env.ANTHROPIC_API_KEY,
  });
});

// GET /api/dashboard?days=7 — SSE with progress updates
app.get('/api/dashboard', async (req, res) => {
  const { token, accountId } = getCredentials(req);
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const days    = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 90);
  const forceRefresh = req.query.refresh === '1';
  const current = { since: dateStr(days),     until: dateStr(0) };
  const prev    = { since: dateStr(days * 2), until: dateStr(days + 1) };
  const fields  = `ad_id,ad_name,${AD_METRICS}`;
  const base    = `${META_BASE_URL}/act_${accountId}`;

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const progress = msg => res.write(`data: ${JSON.stringify({ progress: msg })}\n\n`);
  const startTime = Date.now();
  const elapsed = () => ((Date.now() - startTime) / 1000).toFixed(1) + 's';

  try {
    // 1. Fetch insights
    const cacheKey = String(days);
    const ic = insightsCache[cacheKey];
    let currRows, prevRows;
    if (!forceRefresh && ic) {
      currRows = ic.current;
      prevRows = ic.previous;
      progress(`Using cached insights (${currRows.length} + ${prevRows.length} rows) [${elapsed()}]`);
    } else {
      progress(`Creating async reports... [${elapsed()}]`);
      const pollStatus = [0, 0];
      const reportProgress = () => {
        progress(`Polling reports: current ${pollStatus[0]}% | previous ${pollStatus[1]}% [${elapsed()}]`);
      };
      [currRows, prevRows] = await Promise.all([
        fetchInsightsAsync(base, token, fields, current, (s, p) => { pollStatus[0] = p; reportProgress(); }),
        fetchInsightsAsync(base, token, fields, prev, (s, p) => { pollStatus[1] = p; reportProgress(); }),
      ]);
      insightsCache = { [cacheKey]: { current: currRows, previous: prevRows } };
      saveCacheAsync(INSIGHTS_CACHE_FILE, insightsCache);
      progress(`Insights loaded: ${currRows.length} current + ${prevRows.length} previous rows [${elapsed()}]`);
    }

    // 2. Collect unique ad_ids, fetch only missing creative info
    const allAdIds = [...new Set([...currRows, ...prevRows].map(r => r.ad_id).filter(Boolean))];

    const missingIds = allAdIds.filter(id => !creativeCache[id]);
    if (missingIds.length > 0) {
      progress(`Fetching creative info for ${missingIds.length} new ads... [${elapsed()}]`);
      const fetched = await fetchAdsByIds(token, missingIds, 'id,creative{id,name,object_type,asset_feed_spec,object_story_spec}');
      // Extract primary_text before slimming
      const ptMap = buildPrimaryTextMap(fetched);
      const now = Date.now();
      for (const ad of fetched) {
        if (ad.creative?.id && ptMap[ad.creative.id]) {
          ad.creative.primary_text = ptMap[ad.creative.id];
        }
        creativeCache[ad.id] = slimCreative({ ...ad, _cachedAt: now });
      }
      for (const id of missingIds) {
        if (!creativeCache[id]) creativeCache[id] = { id, creative: null, _cachedAt: now };
      }
      saveCacheAsync(CACHE_FILE, creativeCache);
      progress(`Creative info cached (${fetched.length} ads) [${elapsed()}]`);
    } else {
      progress(`All ${allAdIds.length} ads already cached [${elapsed()}]`);
    }
    const allAds = allAdIds.map(id => creativeCache[id]).filter(Boolean);

    // Prune: remove entries not in active ads
    const activeAdIdSet = new Set(allAdIds);
    let pruned = false;
    for (const id of Object.keys(creativeCache)) {
      if (!activeAdIdSet.has(id)) { delete creativeCache[id]; pruned = true; }
    }
    if (pruned) saveCacheAsync(CACHE_FILE, creativeCache);

    // Fetch HD thumbnails by creative ID directly (thumbnail_width only works at creative level)
    // Skip catalog/DPA ads - they only have placeholder images
    const creativeInfoMap = {};
    for (const ad of allAds) {
      if (ad.creative?.id) creativeInfoMap[ad.creative.id] = {
        type: ad.creative.object_type,
        isCatalog: !!ad.creative.is_catalog,
      };
    }
    const nonCatalogCreativeIds = Object.keys(creativeInfoMap).filter(cid => {
      const info = creativeInfoMap[cid];
      return info.type && ['SHARE', 'VIDEO'].includes(info.type) && !info.isCatalog;
    });
    // Use cached HD thumbs, only fetch missing ones
    const missingHdIds = nonCatalogCreativeIds.filter(cid => !hdThumbCache[cid]);
    if (missingHdIds.length > 0) {
      progress(`Fetching HD thumbnails for ${missingHdIds.length} new creatives... [${elapsed()}]`);
      const BATCH = 50;
      for (let i = 0; i < missingHdIds.length; i += BATCH) {
        const batch = missingHdIds.slice(i, i + BATCH);
        try {
          const res = await axios.get(`${META_BASE_URL}/`, {
            params: { ids: batch.join(','), fields: 'thumbnail_url', thumbnail_width: 480, thumbnail_height: 480, access_token: token }
          });
          for (const [id, data] of Object.entries(res.data)) {
            if (data?.thumbnail_url) hdThumbCache[id] = { url: data.thumbnail_url, _cachedAt: Date.now() };
          }
        } catch (err) {
          console.error('HD thumb fetch error:', err.response?.data?.error?.message || err.message);
        }
      }
      saveCacheAsync(HD_THUMB_CACHE_FILE, hdThumbCache);
      progress(`Fetched HD thumbnails for ${missingHdIds.length} creatives [${elapsed()}]`);
    } else if (nonCatalogCreativeIds.length > 0) {
      progress(`All ${nonCatalogCreativeIds.length} HD thumbnails cached [${elapsed()}]`);
    }
    // Prune HD thumb entries not in active creatives
    const activeCreativeIds = new Set(Object.keys(creativeInfoMap));
    let hdPruned = false;
    for (const id of Object.keys(hdThumbCache)) {
      if (!activeCreativeIds.has(id)) { delete hdThumbCache[id]; hdPruned = true; }
    }
    if (hdPruned) saveCacheAsync(HD_THUMB_CACHE_FILE, hdThumbCache);
    // Extract URLs from cache entries
    const hdThumbMap = {};
    for (const [id, entry] of Object.entries(hdThumbCache)) {
      hdThumbMap[id] = entry.url;
    }

    // Build creative map from allAds — HD thumb is single source for all image URLs
    const creativeMap = {};
    for (const ad of allAds) {
      const c = ad.creative;
      if (!c) continue;
      creativeMap[ad.id] = {
        id:           c.id,
        name:         c.name || '',
        object_type:  c.object_type || '',
        primary_text: c.primary_text || '',
        is_catalog:   !!c.is_catalog,
        thumbnail_url: hdThumbMap[c.id] || null,
      };
    }

    // Ads: attach thumbnail + is_catalog
    const attachThumb = rows => rows.map(r => {
      const cm = creativeMap[r.ad_id];
      return { ...r, thumbnail_url: cm?.thumbnail_url || null, is_catalog: !!cm?.is_catalog };
    });

    // Creatives: attach creative details
    const attachCreative = rows => rows.map(r => ({ ...r, creative: creativeMap[r.ad_id] || null }));
    const fmtMap = { VIDEO: 'Video', SHARE: 'Image', PHOTO: 'Carousel' };
    const groupByCreative = rows => {
      const map = {};
      for (const row of rows) {
        const id = row.creative?.id || 'unknown';
        if (!map[id]) {
          map[id] = {
            creative_id:   id,
            primary_text:  row.creative?.primary_text || '',
            format:        row.creative ? (fmtMap[row.creative.object_type] || 'Image') : null,
            thumbnail_url: row.creative?.thumbnail_url || null,
            is_catalog:    !!row.creative?.is_catalog,
            ad_name:       row.ad_name || '',
            _rows:         [],
          };
        }
        map[id]._rows.push(row);
      }
      return Object.values(map).map(({ _rows, ...entry }) => {
        const sum = fn => _rows.reduce((s, r) => s + fn(r), 0);
        for (const f of ['impressions', 'clicks', 'spend', 'reach', 'unique_clicks', 'frequency']) {
          entry[f] = sum(r => parseFloat(r[f] || 0));
        }
        entry.ctr = entry.impressions ? (entry.clicks / entry.impressions * 100).toFixed(2) : '0';
        entry.cpc = entry.clicks      ? (entry.spend  / entry.clicks).toFixed(2)             : '0';
        entry.cpm = entry.impressions ? (entry.spend  / entry.impressions * 1000).toFixed(2) : '0';
        entry.purchase_count = sum(r => parseFloat(findPurchaseAction(r.actions)?.value       || 0));
        entry.purchase_value = sum(r => parseFloat(findPurchaseAction(r.action_values)?.value || 0));
        entry.roas = entry.spend > 0 && entry.purchase_value > 0 ? entry.purchase_value / entry.spend : 0;
        entry.cpr  = entry.purchase_count > 0 ? entry.spend / entry.purchase_count : 0;
        entry.aov  = entry.purchase_count > 0 ? entry.purchase_value / entry.purchase_count : 0;
        return entry;
      });
    };

    progress(`Processing data... [${elapsed()}]`);
    const hasSpend = rows => rows.filter(r => parseFloat(r.spend || 0) > 0);
    const result = {
      ads: {
        current:  groupByAdName(attachThumb(hasSpend(currRows))),
        previous: groupByAdName(attachThumb(hasSpend(prevRows))),
      },
      creatives: {
        current:  groupByCreative(attachCreative(hasSpend(currRows))),
        previous: groupByCreative(attachCreative(hasSpend(prevRows))),
      },
      period:    { current, previous: prev },
      cached_at: new Date().toISOString(),
    };
    progress(`Done [${elapsed()}]`);
    res.write(`data: ${JSON.stringify({ result })}\n\n`);
    res.end();
  } catch (err) {
    const metaError = err.response?.data?.error;
    let error = 'Meta API error';
    let detail = err.response?.data || err.message;

    // Detect token expiry / invalid token
    if (metaError) {
      const code = metaError.code;
      const subcode = metaError.error_subcode;
      if (code === 190) {
        error = 'Meta API token expired or invalid';
        detail = subcode === 463
          ? 'Token has expired. Please generate a new access token from Meta Business Suite and update META_ACCESS_TOKEN in .env.'
          : subcode === 467
            ? 'Token is no longer valid. The user may have changed their password or revoked access.'
            : `Token error (subcode ${subcode}): ${metaError.message}`;
      } else if (code === 4 || code === 17) {
        error = 'Meta API rate limit reached';
        detail = 'Too many requests. Please wait a few minutes before trying again.';
      }
    }

    res.write(`data: ${JSON.stringify({ error, detail })}\n\n`);
    res.end();
  }
});

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const { messages = [], context = {} } = req.body;
  const systemPrompt = buildSystemPrompt(context);
  const apiKey = req.headers['x-claude-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Missing ANTHROPIC_API_KEY' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const stream = await new Anthropic({ apiKey }).messages.stream({
        model:      'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        system:     systemPrompt,
        messages:   messages.map(({ role, content }) => ({ role, content })),
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    } catch (err) {
      if (err.status === 529 && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
      return;
    }
  }
  res.end();
});

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx) {
  const parts = [`Bạn là chuyên gia phân tích quảng cáo Meta Ads (Facebook/Instagram).
Nhiệm vụ: phân tích dữ liệu hiệu suất quảng cáo và đưa ra insights hữu ích, actionable.

Hãy:
- Chỉ ra các ad / creative đang hoạt động tốt hoặc kém so với kỳ trước
- Gợi ý nguyên nhân và hành động cụ thể
- Trả lời bằng tiếng Việt trừ khi được yêu cầu khác
- Sử dụng số liệu cụ thể khi phân tích
`];

  const { ads, creatives, period } = ctx;
  const cs = period?.current?.since  || '';
  const cu = period?.current?.until  || '';
  const ps = period?.previous?.since || '';
  const pu = period?.previous?.until || '';

  // Strip image URLs and internal fields, filter spend > $10 to save tokens
  const slim = arr => (arr || [])
    .filter(r => parseFloat(r.spend || 0) > 10)
    .map(({ thumbnail_url, is_catalog, ...rest }) => rest);

  if (ads?.current?.length)        parts.push(`\n## ADs hiện tại (${cs} → ${cu}):\n${JSON.stringify(slim(ads.current))}`);
  if (ads?.previous?.length)       parts.push(`\n## ADs kỳ trước (${ps} → ${pu}):\n${JSON.stringify(slim(ads.previous))}`);
  if (creatives?.current?.length)  parts.push(`\n## Creatives hiện tại:\n${JSON.stringify(slim(creatives.current))}`);
  if (creatives?.previous?.length) parts.push(`\n## Creatives kỳ trước:\n${JSON.stringify(slim(creatives.previous))}`);

  return parts.join('');
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Meta Ads Dashboard running on http://localhost:${PORT}`));
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { dateStr, findPurchaseAction, groupByAdName, buildPrimaryTextMap, buildSystemPrompt };
}
