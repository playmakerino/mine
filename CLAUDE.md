# Meta Ads Dashboard

## Overview
Dashboard phân tích quảng cáo Meta (Facebook/Instagram) với AI chat tích hợp Claude API.

## Tech Stack
- **Backend:** Node.js + Express (server.js - ~550 lines)
- **Frontend:** Vanilla HTML/CSS/JS SPA, tách file:
  - `public/index.html` - HTML structure
  - `public/style.css` - CSS styles (~180 lines)
  - `public/app.js` - JavaScript logic (~600 lines)
- **APIs:** Meta Graph API v22.0, Anthropic Claude API
- **Testing:** Jest (server.test.js - 34 tests)
- **Deploy:** Render.com (render.yaml)
- **No build process** - không dùng bundler

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **GET /api/config** - trả về status config (có token chưa)
- **GET /api/dashboard** - SSE stream, fetch data từ Meta API (async report → poll → paginate)
  - Params: `days` (1-90, default 7), `refresh` (force reload)
  - Pipeline: fetch insights → fetch creative info → fetch HD thumbnails → group & build response
  - Input validation: token regex `[A-Za-z0-9_-]`, accountId chỉ số, days clamp 1-90
- **POST /api/chat** - Claude AI streaming chat, model `claude-sonnet-4-5-20250929`
  - System prompt tiếng Việt, phân tích ads
  - Lọc ads spend > $10, strip thumbnail/image URLs để tiết kiệm token
  - Retry 3 lần với exponential backoff (handle 529)
- **Error handling:** detect Meta token expiry (code 190), rate limit (code 4/17) với message rõ ràng
- **Async file writes:** `saveCacheAsync()` dùng `fs.writeFile` callback, không block event loop
- Exports utility functions cho testing (`require.main === module` guard)

### Caching (4 layers)
| Layer | File | TTL | Mục đích |
|---|---|---|---|
| Insights | `.cache-insights.json` | Until force refresh | Insights data (current + previous periods) |
| Creatives | `.cache-creatives.json` | 30 ngày | Creative info (name, type, primary_text, object_story_spec) |
| HD Thumbs | `.cache-hd-thumbs.json` | 7 ngày | HD thumbnail URLs (480px, fetched by creative ID) |
| Browser | localStorage | Until force refresh | Full result cho instant load |

### Frontend (app.js)
- 3 pages: Ad Performance, Creative Performance, AI Chat
- State management bằng plain object
- SSE streaming cho cả dashboard load và chat
- **Tables:** sortable, text/select/metric range filters, search
  - Filter trước → paginate sau (100 rows/page, "Show more" button)
  - Total row tính trên ALL filtered rows (không chỉ page hiện tại)
  - Sticky first column (thumb) với white background
- **Thumbnail preview:** hover hiện ảnh HD 240×240 (position:fixed)
  - HD thumbnails fetched riêng bằng creative ID với `thumbnail_width=480`
  - Catalog/DPA ads: không có hover preview (Meta không cung cấp ảnh lớn)
- Delta indicators (% thay đổi so với kỳ trước)
- **AI Chat:** markdown rendering (bold, italic, code blocks, lists, headers)
- Token estimation và cost tracking
- Mobile responsive (sidebar collapse ở 768px)
- Global error boundary (window.onerror + unhandledrejection → toast)
- Custom CSS tooltip cho nút Load Data

## Key Metrics
- Standard: impressions, clicks, spend, reach, CTR, CPC, CPM
- Derived: ROAS (purchase_value/spend), CPR (spend/purchases), AOV (value/purchases)

## Environment Variables (trong .env)
- `META_ACCESS_TOKEN` - Meta API token
- `META_AD_ACCOUNT_ID` - Ad account ID
- `ANTHROPIC_API_KEY` - Claude API key
- `PORT` - Server port (default 3000)

## Commands
- `npm start` - chạy production
- `npm run dev` - chạy với nodemon (auto-reload)
- `npm test` - chạy Jest tests (34 tests cho utility functions)

## Conventions
- Ngôn ngữ giao diện và system prompt: Tiếng Việt
- File cache: `.cache-creatives.json`, `.cache-insights.json`, `.cache-hd-thumbs.json` (gitignored)
- Không có TypeScript, ESLint, hay formatter config
