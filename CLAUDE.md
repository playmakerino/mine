# Meta Ads Dashboard

## Overview
Dashboard phân tích quảng cáo Meta (Facebook/Instagram) với AI chat tích hợp Claude API.

## Tech Stack
- **Backend:** Node.js + Express (server.js - ~407 lines)
- **Frontend:** Vanilla HTML/CSS/JS SPA (public/index.html - ~870 lines)
- **APIs:** Meta Graph API v21.0, Anthropic Claude API
- **Deploy:** Render.com (render.yaml)
- **No build process** - không dùng bundler

## Architecture

### Backend (server.js)
- Express server port 3000, serve static `public/`
- **GET /api/config** - trả về status config (có token chưa)
- **GET /api/dashboard** - SSE stream, fetch data từ Meta API (async report → poll → paginate)
  - Params: `days` (7/14/30), `refresh` (force reload)
  - 3-layer cache: in-memory insights, file-based creatives (.cache-creatives.json, 30d TTL), browser localStorage
- **POST /api/chat** - Claude AI streaming chat, model `claude-sonnet-4-5-20250929`
  - System prompt tiếng Việt, phân tích ads
  - Lọc ads spend > $10 để tiết kiệm token
  - Retry 3 lần với exponential backoff (handle 529)

### Frontend (public/index.html)
- 3 pages: Ad Performance, Creative Performance, AI Chat
- State management bằng plain object
- SSE streaming cho cả dashboard load và chat
- Sortable tables, text/numeric filters, search
- Delta indicators (% thay đổi so với kỳ trước)
- Token estimation và cost tracking cho chat
- Mobile responsive (sidebar collapse ở 768px)
- Global error boundary (window.onerror + unhandledrejection → toast)

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

## Conventions
- Ngôn ngữ giao diện và system prompt: Tiếng Việt
- File cache: `.cache-creatives.json` (gitignored)
- Không có test suite
- Không có TypeScript, ESLint, hay formatter config
