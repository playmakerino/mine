require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const META_BASE_URL = `https://graph.facebook.com/v21.0`;

const AD_METRICS = [
  'impressions', 'clicks', 'spend', 'reach',
  'ctr', 'cpc', 'cpm', 'cpp',
  'actions', 'action_values', 'cost_per_action_type',
  'purchase_roas', 'frequency',
  'unique_clicks', 'unique_ctr',
].join(',');

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function getCredentials(req) {
  return {
    token:     req.headers['x-meta-token']      || process.env.META_ACCESS_TOKEN,
    accountId: req.headers['x-meta-account-id'] || process.env.META_AD_ACCOUNT_ID,
  };
}

function insightParams(token, fields, timeRange) {
  return { access_token: token, level: 'ad', fields, time_range: JSON.stringify(timeRange), limit: 500 };
}

function findPurchaseAction(arr = []) {
  return arr.find(x => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 80004 && i < retries - 1)
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      else throw err;
    }
  }
}

// Fetch all ads (all statuses, auto-paginate) to build a complete thumbnail/creative map
async function fetchAllAds(token, accountId, fields) {
  const ALL_STATUSES = JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED']);
  const results = [];
  let url    = `${META_BASE_URL}/act_${accountId}/ads`;
  let params = { access_token: token, fields, effective_status: ALL_STATUSES, limit: 500 };

  while (url) {
    const res  = await axios.get(url, { params });
    const data = res.data;
    results.push(...(data.data || []));
    // Follow next page cursor if present
    url    = data.paging?.next || null;
    params = null; // cursor URL already contains all params
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

    const sum = fn => _rows.reduce((s, r) => s + fn(r), 0);
    for (const f of ['impressions', 'clicks', 'spend', 'reach', 'unique_clicks', 'frequency']) {
      entry[f] = sum(r => parseFloat(r[f] || 0));
    }
    entry.ctr = entry.impressions ? (entry.clicks / entry.impressions * 100).toFixed(2) : '0';
    entry.cpc = entry.clicks      ? (entry.spend  / entry.clicks).toFixed(2)             : '0';
    entry.cpm = entry.impressions ? (entry.spend  / entry.impressions * 1000).toFixed(2) : '0';
    entry.purchase_count = sum(r => parseFloat(findPurchaseAction(r.actions)?.value       || 0));
    entry.purchase_value = sum(r => parseFloat(findPurchaseAction(r.action_values)?.value || 0));
    entry.purchase_roas  = entry.spend > 0 && entry.purchase_value > 0
      ? [{ value: (entry.purchase_value / entry.spend).toFixed(4) }]
      : null;
    return entry;
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    hasMetaToken:   !!process.env.META_ACCESS_TOKEN,
    hasAdAccountId: !!process.env.META_AD_ACCOUNT_ID,
    hasClaudeKey:   !!process.env.ANTHROPIC_API_KEY,
    hasManusKey:    !!process.env.MANUS_API_KEY,
  });
});

// GET /api/ads?days=7
app.get('/api/ads', async (req, res) => {
  const { token, accountId } = getCredentials(req);
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const days    = parseInt(req.query.days || '7', 10);
  const current = { since: dateStr(days),     until: dateStr(0) };
  const prev    = { since: dateStr(days * 2), until: dateStr(days + 1) };
  const fields  = `ad_id,ad_name,${AD_METRICS}`;
  const base    = `${META_BASE_URL}/act_${accountId}`;

  try {
    const [currRes, prevRes, allAds] = await Promise.all([
      withRetry(() => axios.get(`${base}/insights`, { params: insightParams(token, fields, current) })),
      withRetry(() => axios.get(`${base}/insights`, { params: insightParams(token, fields, prev) })),
      fetchAllAds(token, accountId, 'id,creative{thumbnail_url}'),
    ]);

    const thumbMap = Object.fromEntries(
      allAds.filter(ad => ad.creative?.thumbnail_url).map(ad => [ad.id, ad.creative.thumbnail_url])
    );
    const attach = rows => rows.map(r => ({ ...r, thumbnail_url: thumbMap[r.ad_id] || null }));

    res.json({
      current:   groupByAdName(attach(currRes.data.data || [])),
      previous:  groupByAdName(attach(prevRes.data.data || [])),
      period:    { current, previous: prev },
      cached_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Meta API error', detail: err.response?.data || err.message });
  }
});

// GET /api/creatives?days=7
app.get('/api/creatives', async (req, res) => {
  const { token, accountId } = getCredentials(req);
  if (!token || !accountId)
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });

  const days    = parseInt(req.query.days || '7', 10);
  const current = { since: dateStr(days),     until: dateStr(0) };
  const prev    = { since: dateStr(days * 2), until: dateStr(days + 1) };
  const fields  = `ad_id,ad_name,${AD_METRICS}`;
  const base    = `${META_BASE_URL}/act_${accountId}`;

  try {
    const [currRes, prevRes, allAds] = await Promise.all([
      withRetry(() => axios.get(`${base}/insights`, { params: insightParams(token, fields, current) })),
      withRetry(() => axios.get(`${base}/insights`, { params: insightParams(token, fields, prev) })),
      fetchAllAds(token, accountId, 'id,creative{id,name,thumbnail_url,object_type}'),
    ]);

    const creativeMap = Object.fromEntries(
      allAds.filter(ad => ad.creative).map(ad => [ad.id, ad.creative])
    );

    const attachCreative = rows => rows.map(r => ({ ...r, creative: creativeMap[r.ad_id] || null }));

    const fmtMap = { VIDEO: 'Video', SHARE: 'Image', PHOTO: 'Carousel' };

    const groupByCreative = rows => {
      const map = {};
      for (const row of rows) {
        const id  = row.creative?.id || 'unknown';
        if (!map[id]) {
          map[id] = {
            creative_id:   id,
            format:        row.creative ? (fmtMap[row.creative.object_type] || 'Image') : null,
            thumbnail_url: row.creative?.thumbnail_url || null,
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
        entry.purchase_roas  = _rows.find(r => r.purchase_roas)?.purchase_roas || null;

        return entry;
      });
    };

    res.json({
      current:   groupByCreative(attachCreative(currRes.data.data || [])),
      previous:  groupByCreative(attachCreative(prevRes.data.data || [])),
      period:    { current, previous: prev },
      cached_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Meta API error', detail: err.response?.data || err.message });
  }
});

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], context = {} } = req.body;
  const systemPrompt = buildSystemPrompt(context);

  if (model === 'claude') {
    const apiKey = req.headers['x-claude-key'] || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Missing ANTHROPIC_API_KEY' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const stream = await new Anthropic({ apiKey }).messages.stream({
        model:      'claude-sonnet-4-6',
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
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }

  } else if (model === 'manus') {
    const apiKey = req.headers['x-manus-key'] || process.env.MANUS_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Missing MANUS_API_KEY' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const lastMsg = messages[messages.length - 1]?.content || '';
      const prompt = systemPrompt + '\n\nUser: ' + lastMsg;

      // Create Manus task
      const taskRes = await axios.post('https://api.manus.ai/v1/tasks', { prompt }, {
        headers: { 'API_KEY': apiKey, 'Content-Type': 'application/json' },
      });
      const taskId = taskRes.data.task_id || taskRes.data.id;

      // Poll for task completion (max 60s)
      let result = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const poll = await axios.get(`https://api.manus.ai/v1/tasks/${taskId}`, {
          headers: { 'API_KEY': apiKey },
        });
        const status = poll.data.status;
        if (status === 'completed' || status === 'done') {
          result = poll.data.output || poll.data.result || poll.data.response || JSON.stringify(poll.data);
          break;
        } else if (status === 'failed' || status === 'error') {
          throw new Error(poll.data.error || 'Manus task failed');
        }
        res.write(`data: ${JSON.stringify({ text: '' })}\n\n`); // keep connection alive
      }

      if (!result) throw new Error('Manus task timed out');
      res.write(`data: ${JSON.stringify({ text: result })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }

  } else {
    return res.status(400).json({ error: `Unknown model: ${model}` });
  }
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

  if (ads?.current?.length)        parts.push(`\n## Dữ liệu ADs hiện tại (${cs} → ${cu}):\n${JSON.stringify(ads.current.slice(0, 50), null, 2)}`);
  if (ads?.previous?.length)       parts.push(`\n## Dữ liệu ADs kỳ trước (${ps} → ${pu}):\n${JSON.stringify(ads.previous.slice(0, 50), null, 2)}`);
  if (creatives?.current?.length)  parts.push(`\n## Dữ liệu Creatives hiện tại:\n${JSON.stringify(creatives.current.slice(0, 30), null, 2)}`);
  if (creatives?.previous?.length) parts.push(`\n## Dữ liệu Creatives kỳ trước:\n${JSON.stringify(creatives.previous.slice(0, 30), null, 2)}`);

  return parts.join('');
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Meta Ads Dashboard running on http://localhost:${PORT}`));
