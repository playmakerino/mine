const { dateStr, findPurchaseAction, groupByAdName, buildPrimaryTextMap, buildSystemPrompt } = require('./server');

// ── dateStr ──────────────────────────────────────────────────────────────────

describe('dateStr', () => {
  test('returns a string in YYYY-MM-DD format', () => {
    const result = dateStr(0);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('returns today when daysAgo is 0', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(dateStr(0)).toBe(today);
  });

  test('returns yesterday when daysAgo is 1', () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const expected = d.toISOString().split('T')[0];
    expect(dateStr(1)).toBe(expected);
  });

  test('returns correct date for 7 days ago', () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    const expected = d.toISOString().split('T')[0];
    expect(dateStr(7)).toBe(expected);
  });

  test('returns correct date for 30 days ago', () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const expected = d.toISOString().split('T')[0];
    expect(dateStr(30)).toBe(expected);
  });
});

// ── findPurchaseAction ───────────────────────────────────────────────────────

describe('findPurchaseAction', () => {
  test('finds action with action_type "purchase"', () => {
    const actions = [
      { action_type: 'link_click', value: '10' },
      { action_type: 'purchase', value: '3' },
    ];
    expect(findPurchaseAction(actions)).toEqual({ action_type: 'purchase', value: '3' });
  });

  test('finds action with action_type "omni_purchase"', () => {
    const actions = [
      { action_type: 'link_click', value: '10' },
      { action_type: 'omni_purchase', value: '5' },
    ];
    expect(findPurchaseAction(actions)).toEqual({ action_type: 'omni_purchase', value: '5' });
  });

  test('returns undefined when no purchase action exists', () => {
    const actions = [
      { action_type: 'link_click', value: '10' },
      { action_type: 'page_engagement', value: '20' },
    ];
    expect(findPurchaseAction(actions)).toBeUndefined();
  });

  test('returns undefined for empty array', () => {
    expect(findPurchaseAction([])).toBeUndefined();
  });

  test('returns undefined when called with no arguments', () => {
    expect(findPurchaseAction()).toBeUndefined();
  });

  test('prefers first match (purchase before omni_purchase)', () => {
    const actions = [
      { action_type: 'purchase', value: '2' },
      { action_type: 'omni_purchase', value: '4' },
    ];
    expect(findPurchaseAction(actions)).toEqual({ action_type: 'purchase', value: '2' });
  });
});

// ── groupByAdName ────────────────────────────────────────────────────────────

describe('groupByAdName', () => {
  test('groups rows by ad_name and aggregates numeric metrics', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '100', clicks: '10', spend: '5', reach: '80', unique_clicks: '9', frequency: '1.2' },
      { ad_name: 'Ad A', impressions: '200', clicks: '20', spend: '10', reach: '150', unique_clicks: '18', frequency: '1.3' },
    ];
    const result = groupByAdName(rows);
    expect(result).toHaveLength(1);
    expect(result[0].ad_name).toBe('Ad A');
    expect(result[0].impressions).toBe(300);
    expect(result[0].clicks).toBe(30);
    expect(result[0].spend).toBe(15);
    expect(result[0].reach).toBe(230);
    expect(result[0].unique_clicks).toBe(27);
  });

  test('keeps separate groups for different ad names', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '100', clicks: '10', spend: '5', reach: '0', unique_clicks: '0', frequency: '0' },
      { ad_name: 'Ad B', impressions: '200', clicks: '20', spend: '10', reach: '0', unique_clicks: '0', frequency: '0' },
    ];
    const result = groupByAdName(rows);
    expect(result).toHaveLength(2);
    const names = result.map(r => r.ad_name).sort();
    expect(names).toEqual(['Ad A', 'Ad B']);
  });

  test('computes ctr correctly', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '1000', clicks: '50', spend: '10', reach: '0', unique_clicks: '0', frequency: '0' },
    ];
    const result = groupByAdName(rows);
    expect(result[0].ctr).toBe('5.00');
  });

  test('computes cpc correctly', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '1000', clicks: '50', spend: '100', reach: '0', unique_clicks: '0', frequency: '0' },
    ];
    const result = groupByAdName(rows);
    expect(result[0].cpc).toBe('2.00');
  });

  test('computes cpm correctly', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '1000', clicks: '50', spend: '10', reach: '0', unique_clicks: '0', frequency: '0' },
    ];
    const result = groupByAdName(rows);
    expect(result[0].cpm).toBe('10.00');
  });

  test('returns ctr/cpc/cpm as "0" when impressions or clicks are zero', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '0', clicks: '0', spend: '0', reach: '0', unique_clicks: '0', frequency: '0' },
    ];
    const result = groupByAdName(rows);
    expect(result[0].ctr).toBe('0');
    expect(result[0].cpc).toBe('0');
    expect(result[0].cpm).toBe('0');
  });

  test('aggregates purchase_count and purchase_value from actions', () => {
    const rows = [
      {
        ad_name: 'Ad A', impressions: '100', clicks: '10', spend: '50', reach: '0', unique_clicks: '0', frequency: '0',
        actions: [{ action_type: 'purchase', value: '3' }],
        action_values: [{ action_type: 'purchase', value: '150.00' }],
      },
      {
        ad_name: 'Ad A', impressions: '100', clicks: '10', spend: '50', reach: '0', unique_clicks: '0', frequency: '0',
        actions: [{ action_type: 'purchase', value: '2' }],
        action_values: [{ action_type: 'purchase', value: '100.00' }],
      },
    ];
    const result = groupByAdName(rows);
    expect(result[0].purchase_count).toBe(5);
    expect(result[0].purchase_value).toBe(250);
  });

  test('computes roas when spend and purchase_value are positive', () => {
    const rows = [
      {
        ad_name: 'Ad A', impressions: '100', clicks: '10', spend: '100', reach: '0', unique_clicks: '0', frequency: '0',
        actions: [{ action_type: 'purchase', value: '5' }],
        action_values: [{ action_type: 'purchase', value: '500.00' }],
      },
    ];
    const result = groupByAdName(rows);
    expect(result[0].roas).toBe(5);
  });

  test('sets roas to 0 when no purchases', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '100', clicks: '10', spend: '50', reach: '0', unique_clicks: '0', frequency: '0' },
    ];
    const result = groupByAdName(rows);
    expect(result[0].roas).toBe(0);
  });

  test('uses "unknown" for rows without ad_name', () => {
    const rows = [
      { impressions: '100', clicks: '10', spend: '5', reach: '0', unique_clicks: '0', frequency: '0' },
    ];
    const result = groupByAdName(rows);
    expect(result[0].ad_name).toBe('unknown');
  });

  test('picks thumbnail_url from the ad with highest spend', () => {
    const rows = [
      { ad_name: 'Ad A', impressions: '100', clicks: '10', spend: '5', reach: '0', unique_clicks: '0', frequency: '0', thumbnail_url: 'low.jpg' },
      { ad_name: 'Ad A', impressions: '200', clicks: '20', spend: '50', reach: '0', unique_clicks: '0', frequency: '0', thumbnail_url: 'high.jpg' },
    ];
    const result = groupByAdName(rows);
    expect(result[0].thumbnail_url).toBe('high.jpg');
  });
});

// ── buildPrimaryTextMap ──────────────────────────────────────────────────────

describe('buildPrimaryTextMap', () => {
  test('extracts primary text from creative asset_feed_spec', () => {
    const allAds = [
      { creative: { id: 'c1', asset_feed_spec: { bodies: [{ text: 'Hello World' }] } } },
      { creative: { id: 'c2', asset_feed_spec: { bodies: [{ text: 'Buy Now' }] } } },
    ];
    const map = buildPrimaryTextMap(allAds);
    expect(map).toEqual({ c1: 'Hello World', c2: 'Buy Now' });
  });

  test('skips ads without creative', () => {
    const allAds = [
      { creative: null },
      { id: '123' },
    ];
    const map = buildPrimaryTextMap(allAds);
    expect(map).toEqual({});
  });

  test('skips ads without asset_feed_spec or bodies', () => {
    const allAds = [
      { creative: { id: 'c1' } },
      { creative: { id: 'c2', asset_feed_spec: {} } },
      { creative: { id: 'c3', asset_feed_spec: { bodies: [] } } },
    ];
    const map = buildPrimaryTextMap(allAds);
    expect(map).toEqual({});
  });

  test('uses only the first body text', () => {
    const allAds = [
      { creative: { id: 'c1', asset_feed_spec: { bodies: [{ text: 'First' }, { text: 'Second' }] } } },
    ];
    const map = buildPrimaryTextMap(allAds);
    expect(map).toEqual({ c1: 'First' });
  });

  test('returns empty object for empty array', () => {
    expect(buildPrimaryTextMap([])).toEqual({});
  });
});

// ── buildSystemPrompt ────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  test('returns base prompt when context is empty', () => {
    const result = buildSystemPrompt({});
    expect(result).toContain('chuyên gia phân tích quảng cáo Meta Ads');
    expect(result).not.toContain('## ADs hiện tại');
    expect(result).not.toContain('## ADs kỳ trước');
    expect(result).not.toContain('## Creatives hiện tại');
    expect(result).not.toContain('## Creatives kỳ trước');
  });

  test('includes current ads section when ads.current is provided', () => {
    const ctx = {
      ads: { current: [{ ad_name: 'Test Ad', spend: '50', impressions: '1000' }] },
      period: { current: { since: '2025-01-01', until: '2025-01-07' } },
    };
    const result = buildSystemPrompt(ctx);
    expect(result).toContain('## ADs hiện tại (2025-01-01');
    expect(result).toContain('Test Ad');
  });

  test('includes previous ads section when ads.previous is provided', () => {
    const ctx = {
      ads: { previous: [{ ad_name: 'Old Ad', spend: '50', impressions: '500' }] },
      period: { previous: { since: '2024-12-25', until: '2024-12-31' } },
    };
    const result = buildSystemPrompt(ctx);
    expect(result).toContain('## ADs kỳ trước');
    expect(result).toContain('Old Ad');
  });

  test('includes creatives sections when provided', () => {
    const ctx = {
      creatives: {
        current: [{ creative_id: 'c1', spend: '50' }],
        previous: [{ creative_id: 'c2', spend: '50' }],
      },
      period: { current: { since: '2025-01-01', until: '2025-01-07' }, previous: { since: '2024-12-25', until: '2024-12-31' } },
    };
    const result = buildSystemPrompt(ctx);
    expect(result).toContain('## Creatives hiện tại');
    expect(result).toContain('## Creatives kỳ trước');
  });

  test('filters out ads with spend <= $10 to save tokens', () => {
    const ctx = {
      ads: {
        current: [
          { ad_name: 'Low Spend', spend: '5' },
          { ad_name: 'High Spend', spend: '50' },
        ],
      },
      period: { current: { since: '2025-01-01', until: '2025-01-07' } },
    };
    const result = buildSystemPrompt(ctx);
    expect(result).toContain('High Spend');
    expect(result).not.toContain('Low Spend');
  });

  test('strips thumbnail_url from context data', () => {
    const ctx = {
      ads: {
        current: [{ ad_name: 'Ad', spend: '50', thumbnail_url: 'http://example.com/img.jpg' }],
      },
      period: { current: { since: '2025-01-01', until: '2025-01-07' } },
    };
    const result = buildSystemPrompt(ctx);
    expect(result).not.toContain('http://example.com/img.jpg');
  });

  test('handles missing period gracefully', () => {
    const ctx = {
      ads: { current: [{ ad_name: 'Ad', spend: '50' }] },
    };
    // Should not throw
    const result = buildSystemPrompt(ctx);
    expect(result).toContain('## ADs hiện tại');
  });
});
