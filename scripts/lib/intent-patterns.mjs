/**
 * Intent classification patterns for agent-olympus Intent Gate
 * Supports English, Korean, Japanese, and Chinese pattern matching
 */

/**
 * Intent category definitions with regex patterns, keyword lists, and weights.
 * Higher weight = stronger signal when matched.
 */
export const INTENT_CATEGORIES = {
  'visual-engineering': {
    patterns: [
      /\b(css|style|ui|ux|design|layout|responsive|color|colour|font|button|modal|navbar|sidebar|card|component|tailwind|shadcn|flex|grid|animation|transition|hover|focus|media\s*query|breakpoint|palette|typography|icon|image|banner|hero|footer|header)\b/i,
      /\b(react|vue|svelte|angular|nextjs|nuxtjs|astro|remix|solid|qwik)\b/i,
      /\b(html|jsx|tsx|template|markup|dom|shadow\s*dom|web\s*component)\b/i,
      /\b(dark\s*mode|light\s*mode|theme|theming|brand|branding)\b/i,
      // Korean: CSS, UI, 스타일, 디자인, 레이아웃, 컴포넌트
      /(?:CSS|UI|UX|스타일|디자인|레이아웃|반응형|컬러|폰트|버튼|모달|네비게이션|사이드바|카드|컴포넌트|애니메이션)/u,
      // Japanese: スタイル, デザイン, レイアウト, コンポーネント
      /(?:スタイル|デザイン|レイアウト|レスポンシブ|カラー|フォント|ボタン|モーダル|コンポーネント|アニメーション)/u,
      // Chinese: 样式, 设计, 布局, 组件, 响应式
      /(?:样式|設計|设计|布局|響應式|响应式|顏色|颜色|字體|字体|按鈕|按钮|組件|组件|動畫|动画)/u,
    ],
    keywords: [
      'frontend', 'front-end', 'react', 'vue', 'svelte', 'html', 'animation',
      'dark mode', 'theme', 'pixel', 'wireframe', 'prototype', 'figma', 'sketch',
      'styled-components', 'emotion', 'sass', 'scss', 'less', 'postcss',
      'accessibility', 'a11y', 'aria', 'wcag',
    ],
    weight: 1.0,
  },

  'design-review': {
    patterns: [
      /\b(design\s*critique|design\s*review|ui\s*review|ux\s*review|a11y\s*audit|accessibility\s*audit|design\s*system\s*audit|ux\s*copy|copy\s*review|microcopy\s*review)\b/i,
      /\b(nielsen|heuristic\s*evaluation|gestalt|wcag\s*audit|usability\s*review|visual\s*regression)\b/i,
      /\b(token\s*leak|hardcoded\s*color|design\s*debt|component\s*consistency)\b/i,
      // Korean: 디자인 리뷰, 접근성 검사, UX 카피
      /(?:디자인\s*리뷰|디자인\s*비평|접근성\s*검사|접근성\s*감사|카피\s*리뷰|디자인\s*시스템\s*검사|UI\s*리뷰)/u,
      // Japanese: デザインレビュー, アクセシビリティ監査
      /(?:デザインレビュー|アクセシビリティ監査|デザインシステム監査|UXコピー)/u,
    ],
    keywords: [
      'design critique', 'design review', 'ui review', 'a11y audit',
      'accessibility audit', 'design system audit', 'ux copy review',
      'heuristic evaluation', 'usability review', 'token leak',
    ],
    weight: 1.2,
  },

  'deep': {
    patterns: [
      /\b(architect|refactor|redesign|optimize|optimise|performance|migration|migrate|scale|scaling|infrastructure|distributed|microservice|monolith|system\s*design)\b/i,
      /\b(overhaul|rewrite|rearchitect|restructure|consolidate|decouple|modular|modularize)\b/i,
      /\b(database|schema|sql|nosql|orm|query\s*plan|index|caching|redis|postgres|mysql|mongodb)\b/i,
      /\b(security|auth|authentication|authorization|oauth|jwt|rbac|acl|encryption|zero\s*trust)\b/i,
      /\b(ci[\/\s]?cd|pipeline|deployment|kubernetes|k8s|docker|terraform|ansible|helm)\b/i,
      /\b(complexity|trade.?off|bottleneck|throughput|latency|concurrency|race\s*condition|deadlock)\b/i,
      // Korean: 아키텍처, 리팩토링, 최적화, 마이그레이션, 보안
      /(?:아키텍처|리팩토링|최적화|마이그레이션|인프라|보안|인증|데이터베이스)/u,
      // Japanese: アーキテクチャ, リファクタリング, 最適化, マイグレーション
      /(?:アーキテクチャ|リファクタリング|最適化|マイグレーション|インフラ|セキュリティ|データベース)/u,
      // Chinese: 架构, 重构, 优化, 迁移, 安全, 数据库
      /(?:架構|架构|重構|重构|優化|优化|遷移|迁移|基礎設施|基础设施|安全|數據庫|数据库)/u,
    ],
    keywords: [
      'complex', 'system', 'overhaul', 'rewrite', 'database', 'security', 'auth',
      'scalability', 'distributed', 'microservices', 'event-driven', 'domain-driven',
      'ddd', 'cqrs', 'event sourcing', 'saga', 'circuit breaker',
    ],
    weight: 1.0,
  },

  'quick': {
    patterns: [
      /\b(fix|typo|rename|add\s+comment|simple|small|minor|tweak|patch|hotfix|quick)\b/i,
      /\b(one.?liner|trivial|straightforward|easy|fast|rapid|snippet|tiny|minimal)\b/i,
      /\b(missing|forgot|oops|wrong|incorrect|off.?by.?one|null.?check|guard)\b/i,
      // Korean: 수정, 간단, 빠른, 작은
      /(?:빠른\s*수정|간단한|작은\s*변경|오타\s*수정|단순한)/u,
      // Japanese: 修正, 簡単, 素早い, 小さな
      /(?:簡単な|素早い|小さな|軽微な修正|タイポ修正)/u,
      // Chinese: 简单, 快速, 小修改, 错别字
      /(?:簡單|简单|快速|小修改|錯別字|错别字|輕微|轻微)/u,
    ],
    keywords: [
      'quick', 'easy', 'straightforward', 'one-liner', 'simple change',
      'small fix', 'minor update', 'just need to', 'just change', 'just add',
    ],
    weight: 0.8,
  },

  'writing': {
    patterns: [
      /\b(document|readme|docs|comment|explain|description|changelog|release\s*notes|migration\s*guide)\b/i,
      /\b(jsdoc|typedoc|swagger|openapi|postman|api\s*docs|api\s*reference)\b/i,
      /\b(tutorial|guide|walkthrough|how.?to|getting\s*started|onboarding)\b/i,
      /\b(prose|paragraph|essay|article|blog|post|summary|abstract)\b/i,
      /\b(markdown|rst|asciidoc|wiki|confluence|notion|obsidian)\b/i,
      // Korean: 문서, 주석, 설명, 가이드, 튜토리얼
      /(?:문서화|주석|설명|가이드|튜토리얼|사용법|리드미)/u,
      // Japanese: ドキュメント, コメント, 説明, ガイド
      /(?:ドキュメント|コメント|説明|ガイド|チュートリアル|リードミー)/u,
      // Chinese: 文档, 注释, 说明, 指南, 教程
      /(?:文檔|文档|注釋|注释|說明|说明|指南|教程|說明書|说明书)/u,
    ],
    keywords: [
      'write', 'documentation', 'api docs', 'jsdoc', 'tutorial', 'document this',
      'add comments', 'explain this', 'describe', 'annotate', 'docstring',
    ],
    weight: 0.9,
  },

  'artistry': {
    patterns: [
      /\b(creative|generative|art|visualization|visualize|visualise|diagram|chart|graph|canvas|svg|d3|three.?js|webgl)\b/i,
      /\b(shader|particle|fluid|simulation|procedural|fractal|noise|perlin)\b/i,
      /\b(data.?viz|infographic|dashboard|heatmap|treemap|sankey|sunburst)\b/i,
      /\b(aesthetic|beautiful|elegant|stunning|gorgeous|artistic|visual)\b/i,
      // Korean: 창의적, 예술, 시각화, 다이어그램
      /(?:창의적|예술적|시각화|다이어그램|차트|그래프|캔버스)/u,
      // Japanese: クリエイティブ, アート, 可視化, ダイアグラム
      /(?:クリエイティブ|アート|可視化|ビジュアライゼーション|ダイアグラム|チャート)/u,
      // Chinese: 创意, 艺术, 可视化, 图表
      /(?:創意|创意|藝術|艺术|可視化|可视化|圖表|图表|圖形|图形)/u,
    ],
    keywords: [
      'beautiful', 'aesthetic', 'creative', 'artistic', 'generative art',
      'data visualization', 'interactive', 'animate', 'render', 'draw',
    ],
    weight: 0.7,
  },

  'planning': {
    patterns: [
      /\b(plan|strategy|design|approach|architecture|roadmap|spec|specification|blueprint|proposal)\b/i,
      /\b(think\s+through|think\s+about|figure\s+out|work\s+out|map\s+out|lay\s+out)\b/i,
      /\b(steps?|phases?|milestone|epic|story|backlog|sprint|agile|scrum|kanban)\b/i,
      /\b(brainstorm|explore|consider|evaluate|compare|tradeoff|trade.?off|pros?\s+and\s+cons?)\b/i,
      /\b(before\s+(we|i)\s+(start|begin|code|implement)|help\s+me\s+(plan|think|design))\b/i,
      // Korean: 계획, 전략, 설계, 접근법, 로드맵
      /(?:계획|전략|설계|접근법|로드맵|명세|사양|청사진)/u,
      // Japanese: 計画, 戦略, 設計, アプローチ, ロードマップ
      /(?:計画|戦略|設計|アプローチ|ロードマップ|仕様|ブレインストーミング)/u,
      // Chinese: 计划, 策略, 设计, 路线图, 规划
      /(?:計劃|计划|策略|規劃|规划|路線圖|路线图|方案|藍圖|蓝图)/u,
    ],
    keywords: [
      'plan', 'strategy', 'design', 'think through', 'approach',
      'roadmap', 'architecture plan', 'how should we', 'what would be the best way',
      'let\'s figure out', 'help me plan', 'brainstorm',
    ],
    weight: 0.9,
  },
};

/**
 * Sanitize text before intent classification.
 * Strips code blocks, URLs, and file paths to reduce false-positive matches.
 * @param {string} text
 * @returns {string}
 */
function sanitizeText(text) {
  return text
    // Strip fenced code blocks (```...```)
    .replace(/```[\s\S]*?```/g, ' ')
    // Strip inline code (`...`)
    .replace(/`[^`]+`/g, ' ')
    // Strip URLs
    .replace(/https?:\/\/[^\s)>\]]+/g, ' ')
    // Strip file paths (/foo/bar or ./foo/bar)
    .replace(/(?:^|(?<=[\s"'`(]))(?:\.\/|\.\.\/|\/)?(?:[\w.-]+\/)+[\w.-]+/gm, ' ')
    // Strip XML/HTML tags
    .replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, ' ')
    .replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify the intent of a user prompt.
 * @param {string} text - Raw user prompt text
 * @returns {{ category: string, confidence: number, scores: Record<string, number> }}
 */
export function classifyIntent(text) {
  if (!text || typeof text !== 'string') {
    return { category: 'unknown', confidence: 0, scores: {} };
  }

  const clean = sanitizeText(text);
  const lower = clean.toLowerCase();

  /** @type {Record<string, number>} */
  const scores = {};

  for (const [category, def] of Object.entries(INTENT_CATEGORIES)) {
    let score = 0;

    // Pattern matches: each pattern hit contributes 1.0 * weight
    for (const pattern of def.patterns) {
      if (pattern.test(clean)) {
        score += def.weight;
      }
    }

    // Keyword matches: each keyword present contributes 0.5 * weight
    for (const keyword of def.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        score += def.weight * 0.5;
      }
    }

    scores[category] = Math.round(score * 100) / 100;
  }

  // Find highest-scoring category
  let topCategory = 'unknown';
  let topScore = 0;
  let totalScore = 0;

  for (const [category, score] of Object.entries(scores)) {
    totalScore += score;
    if (score > topScore) {
      topScore = score;
      topCategory = category;
    }
  }

  // Confidence: ratio of top score to total score, clamped to [0, 1]
  const confidence = totalScore > 0
    ? Math.min(1, Math.round((topScore / Math.max(totalScore, topScore)) * 100) / 100)
    : 0;

  return {
    category: topScore > 0 ? topCategory : 'unknown',
    confidence,
    scores,
  };
}
