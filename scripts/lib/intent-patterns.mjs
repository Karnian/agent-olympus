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

  // Selected only by the provider-aware Claude review override below. A
  // generic code review must not become mutation-capable merely because the
  // requested reviewer is the host model rather than an external provider.
  'code-review': {
    patterns: [],
    keywords: [],
    weight: 1.3,
  },

  // These specialist categories are selected by exact action overrides below.
  // Keeping them in the score map makes persisted intent state and routing
  // configuration share one complete category vocabulary.
  'security-review': {
    patterns: [
      /\b(?:security\s+(?:review|audit|assessment)|threat\s+model(?:ing|ling)?\s+(?:review|audit))\b/i,
      /(?:보안\s*(?:리뷰|검토|감사|점검|평가)|위협\s*모델링\s*(?:리뷰|검토|감사))/u,
    ],
    keywords: ['security review', 'security audit', '보안 리뷰', '보안 검토'],
    weight: 1.3,
  },

  'test-authoring': {
    patterns: [
      /\b(?:write|add|create|implement|generate)\s+(?:the\s+|an?\s+)?(?:(?:unit|integration|end[- ]to[- ]end|e2e|regression)\s+)?tests?\b/i,
      /(?:테스트|시험)(?:를|을)?\s*(?:작성|추가|구현|생성|만들)/u,
    ],
    keywords: ['write tests', 'add tests', 'unit tests', 'integration tests', '테스트 작성'],
    weight: 1.3,
  },

  'product-planning': {
    patterns: [
      /\b(?:prd|product\s+(?:requirements?\s+document|spec(?:ification)?)|reverse\s+(?:spec|specification|prd))\b/i,
      /(?:PRD|제품\s*(?:요구사항|명세)|역기획)/iu,
    ],
    keywords: ['prd', 'product spec', 'product requirements document', 'reverse spec', '역기획'],
    weight: 1.3,
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
      /(?:아키텍처|리팩(?:토|터)링|최적화|마이그레이션|인프라|보안|인증|데이터베이스)/u,
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

  // Selected by the explicit mutation override below when a deep technical
  // subject is paired with an implementation verb. The ordinary `deep` route
  // remains read-only architecture analysis.
  'deep-mutation': {
    patterns: [],
    keywords: [],
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

  'external-model': {
    patterns: [
      // Direct model references
      /\b(ask\s+codex|codex\s*(한테|에게|로|로\s*해|에)\s*물어|codex\s+(review|check|analyze|verify|look\s+at))\b/i,
      /\b(ask\s+gemini|gemini\s*(한테|에게|로|로\s*해|에)\s*물어|gemini\s+(review|check|analyze|verify|look\s+at))\b/i,
      /\b(cross.?review|cross.?validate|second\s+opinion|다른\s*모델|외부\s*모델)\b/i,
      /\b(codex\s*로\s*(검토|분석|리뷰|확인)|gemini\s*로\s*(검토|분석|리뷰|확인))\b/i,
      // Korean: 코덱스한테 물어봐, 제미니한테 물어봐, 교차 리뷰, 상호 리뷰
      /(?:코덱스|codex)\s*(?:한테|에게|로|와|과)?\s*(?:물어|질문|리뷰|검토|분석|확인)/u,
      /(?:제미니|gemini)\s*(?:한테|에게|로|와|과)?\s*(?:물어|질문|리뷰|검토|분석|확인)/u,
      /(?:교차\s*(?:리뷰|검토|검증)|상호\s*(?:리뷰|검토|검증)|크로스\s*(?:리뷰|체크))/u,
      // Japanese: Codexに聞いて, Geminiに聞いて, クロスレビュー (case-insensitive for Latin)
      /(?:codex|コデックス)(?:に|で)(?:聞|確認|レビュー|分析)/iu,
      /(?:gemini|ジェミニ)(?:に|で)(?:聞|確認|レビュー|分析)/iu,
      /(?:クロスレビュー|相互レビュー|セカンドオピニオン)/u,
      // Korean: broader patterns for 다른 모델에게 물어봐, 외부 모델로 확인해줘
      /(?:다른\s*모델|외부\s*모델)\s*(?:한테|에게|로|에서)?\s*(?:물어|질문|확인|검토|분석)/u,
    ],
    keywords: [
      'ask codex', 'ask gemini', 'codex review', 'gemini review',
      'cross-review', 'cross review', 'cross-validate', 'second opinion',
      'codex한테', 'gemini한테', '코덱스', '제미니', '교차 리뷰', '상호 리뷰',
      'codex로 검토', 'gemini로 분석', 'another model', 'different model',
    ],
    weight: 1.5,
  },
};

const EXTERNAL_PROVIDER_REVIEW_ACTIONS = Object.freeze([
  /\b(?:(?:codex|gemini)\s+(?:and|&)\s+claude(?:\s+code)?|claude(?:\s+code)?\s+(?:and|&)\s+(?:codex|gemini))\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:ask|consult)\s+(?:the\s+)?(?:codex|gemini)\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /(?:^|[.!?;]\s*)(?:please\s+)?use\s+(?:the\s+)?(?:codex|gemini)\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?use\s+(?:the\s+)?(?:codex|gemini)\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:want|need)\s+(?:you\s+)?to\s+use\s+(?:the\s+)?(?:codex|gemini)\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:codex|gemini)\b\s*(?:,|:|-)?\s*(?:please\s+)?(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b[^.!?\n]{0,60}\b(?:with|using|via|as)\s+(?:the\s+)?(?:codex|gemini)\b/i,
  /\b(?:with|using|via|as)\s+(?:the\s+)?(?:codex|gemini)\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:have|get)\b[^.!?\n]{0,60}\b(?:reviewed|checked|analy[sz]ed|verified)\s+by\s+(?:the\s+)?(?:codex|gemini)\b/i,
  /(?:코덱스|codex|제미니|gemini)(?:를|을)?\s*(?:로|에게|한테|와|과|랑|이랑|가|이)[^.!?\n]{0,40}(?:교차\s*(?:리뷰|검토|검증)|리뷰|검토|검증|분석|확인)/iu,
  /(?:교차\s*(?:리뷰|검토|검증)|리뷰|검토|검증|분석|확인)[^.!?\n]{0,40}(?:코덱스|codex|제미니|gemini)(?:를|을)?\s*(?:로|에게|한테)/iu,
]);

const CLAUDE_REVIEW_ACTIONS = Object.freeze([
  /\bask\s+claude(?:\s+code)?\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\bclaude(?:\s+code)?\b\s*(?:,|:|-)?\s*(?:please\s+)?(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b[^.!?\n]{0,60}\b(?:with|using|via|as)\s+claude(?:\s+code)?\b/i,
  /\b(?:with|using|via|as)\s+claude(?:\s+code)?\b[^.!?\n]{0,60}\b(?:review|check|analy[sz]e|verify|cross[ -]?(?:review|validate|check))\b/i,
  /\b(?:have|get)\b[^.!?\n]{0,60}\b(?:reviewed|checked|analy[sz]ed|verified)\s+by\s+claude(?:\s+code)?\b/i,
  /(?:클로드|claude)(?:를|을)?(?:\s*코드)?\s*(?:로|에게|한테|가|이)[^.!?\n]{0,40}(?:교차\s*(?:리뷰|검토|검증)|리뷰|검토|검증|분석|확인)/iu,
  /(?:교차\s*(?:리뷰|검토|검증)|리뷰|검토|검증|분석|확인)[^.!?\n]{0,40}(?:클로드|claude)(?:\s*코드)?(?:를|을)?\s*(?:로|에게|한테)/iu,
]);

// A provider name may describe where an artifact or earlier finding came
// from, rather than who should perform the next action. Keep those provenance
// forms out of provider routing so a local review stays read-only and a request
// to apply existing findings remains mutation-capable.
const PROVIDER_REVIEW_PROVENANCE = Object.freeze([
  /\b(?:from|in|per|according\s+to|based\s+on)\s+(?:the\s+)?(?:claude|codex|gemini)(?:'s)?\s+(?:review|findings?|feedback|recommendations?)\b/i,
  /\b(?:claude|codex|gemini)(?:'s)?\s+(?:review|findings?|feedback|recommendations?)\b[^.!?\n]{0,40}\b(?:found|identified|reported|recommended|suggested|noted|says?)\b/i,
  /\b(?:found|identified|reported|recommended|suggested|noted)\s+by\s+(?:the\s+)?(?:claude|codex|gemini)(?:'s)?\s+(?:review|reviewer)?\b/i,
  /\b(?:authored|generated|produced|written|created|made|suggested|recommended|reviewed|checked|analy[sz]ed|verified)\s+by\s+(?:the\s+)?(?:claude|codex|gemini)\b/i,
  /\b(?:patch|output|result|code|change|suggestion|recommendation|feedback|artifact)\b[^.!?\n]{0,30}\bby\s+(?:the\s+)?(?:claude|codex|gemini)\b/i,
  /\b(?:we|i)\s+use\s+(?:the\s+)?(?:claude|codex|gemini)\b/i,
  /(?:클로드|claude|코덱스|codex|제미니|gemini)(?:가|이)\s*(?:리뷰|검토|검증|분석|확인)(?:한|했던)/iu,
  /(?:클로드|claude|코덱스|codex|제미니|gemini)(?:의)?\s*(?:리뷰|검토|검증|분석|확인)\s*(?:결과|내용|피드백|권고|에서)/iu,
  /(?:클로드|claude|코덱스|codex|제미니|gemini)(?:를|을)?\s*(?:로|가|이)\s*(?:만든|생성한|작성한|구현한|제안한)/iu,
]);

const PROVIDER_PROVENANCE_MUTATION_ACTIONS = Object.freeze([
  /(?:^|[.!?]\s*)\s*(?:please\s+)?(?:fix|implement|apply|update|address|resolve|rewrite|change)\b/i,
  /[,;]\s*(?:then\s+)?(?:please\s+)?(?:fix|implement)\b/i,
  /\b(?:and|then)\s+(?:please\s+)?(?:fix|implement|apply|update|address|resolve|rewrite|change)\b/i,
  /\bplease\s+(?:fix|implement|apply|update|address|resolve|rewrite|change)\b/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:fix|implement|apply|update|address|resolve|rewrite|change)\b/i,
  /\b(?:want|need)\s+(?:you\s+)?to\s+(?:fix|implement|apply|update|address|resolve|rewrite|change)\b/i,
  /^(?:ask\s+)?(?:claude|codex|gemini)(?:\s+code)?\s*(?:,|:|-)?\s*(?:to\s+)?(?:please\s+)?(?:fix|implement|apply|update|address|resolve|rewrite|change)\b/i,
  /(?:수정|변경|구현|반영|적용|해결)(?:해|하|해줘|해주세요|해\s*줘|하고|하여|해서)|고쳐/u,
]);

const GENERIC_REVIEW_ACTIONS = Object.freeze([
  /\b(?:review|check|analy[sz]e|verify)\b/i,
  /(?:리뷰|검토|검증|분석|확인)(?:을|를|해|하|해줘|해주세요)?/u,
]);

// Exact review verbs outrank broad visual nouns ("UI", "design"). Keep this
// narrow so implementation requests such as "build a UI" remain visual work.
const DESIGN_REVIEW_OVERRIDES = Object.freeze([
  /\b(?:ui|ux|design)\s*(?:review|critique|audit)\b/i,
  /\b(?:review|critique|audit)\s+(?:the\s+)?(?:ui|ux|design)\b/i,
  /(?:UI|UX|디자인)\s*(?:리뷰|검토|비평|감사)(?:해\s*줘|해주세요|해줘|해|하자)?/iu,
]);

const DEEP_REVIEW_OVERRIDES = Object.freeze([
  /\b(?:architecture|system\s+design)\s*(?:review|audit|assessment)\b/i,
  /\b(?:review|audit|assess)\s+(?:the\s+)?(?:architecture|system\s+design)\b/i,
  /(?:아키텍처|시스템\s*설계)\s*(?:리뷰|검토|감사|평가)/u,
]);

const SECURITY_REVIEW_OVERRIDES = Object.freeze([
  /\b(?:security\s+(?:review|audit|assessment)|(?:review|audit|assess)\s+(?:the\s+)?(?:security|threat\s+model))\b/i,
  /(?:보안|위협\s*모델링)\s*(?:리뷰|검토|감사|점검|평가)/u,
]);

const TEST_AUTHORING_OVERRIDES = Object.freeze([
  /\b(?:write|add|create|implement|generate)\s+(?:the\s+|an?\s+)?(?:(?:unit|integration|end[- ]to[- ]end|e2e|regression)\s+)?tests?\b/i,
  /(?:테스트|시험)(?:를|을)?\s*(?:작성|추가|구현|생성|만들)/u,
]);

const PRODUCT_PLANNING_OVERRIDES = Object.freeze([
  /\b(?:write|create|draft|prepare|generate)\s+(?:the\s+|an?\s+)?(?:prd|product\s+(?:requirements?\s+document|spec(?:ification)?))\b/i,
  /\b(?:reverse[- ]engineer|derive|reconstruct)\s+(?:the\s+|an?\s+)?(?:prd|product\s+spec(?:ification)?|spec(?:ification)?)\b/i,
  /\breverse\s+(?:spec|specification|prd)\b/i,
  /(?:PRD|제품\s*(?:요구사항|명세))(?:를|을)?\s*(?:작성|만들|생성|기획)|역기획|(?:^|\s)기획(?:해\s*줘|해주세요|해줘|하자|을\s*해\s*줘)/u,
]);

const DEEP_MUTATION_OVERRIDES = Object.freeze([
  /\b(?:refactor|migrate|optimi[sz]e|rewrite|rearchitect|restructure|implement|change|update|fix)\b/i,
  /(?:리팩(?:토|터)링|마이그레이션|최적화|재작성|재설계|구현|수정|변경)(?:을|를|해|하|해줘|해주세요)?/u,
]);

// Action-led requests carry more intent than a pile of technical subject
// nouns. Keep these patterns narrow: they exist to stop words such as
// "database" and "security" from turning an explicit docs/UI/art request into
// a read-only architecture task.
const WRITING_ACTION_OVERRIDES = Object.freeze([
  /\b(?:write|create|add|update|draft|generate)\s+(?:the\s+|an?\s+)?(?:documentation|docs?|readme|api\s+(?:documentation|docs?|reference)|guide|tutorial|changelog|release\s+notes?|comments?|jsdoc)\b/i,
  /\b(?:document|explain|describe|annotate)\b/i,
  /(?:문서화|문서(?:를|을)?\s*(?:작성|추가|갱신|업데이트)|가이드(?:를|을)?\s*(?:작성|추가)|설명해\s*줘)/u,
]);

const PLAN_EXECUTION_OVERRIDES = Object.freeze([
  /\b(?:implement|execute|apply|code|build)\s+(?:the\s+)?plan\b/i,
  /\bwrite\s+(?:the\s+)?code\b/i,
  /(?:계획(?:을|를)?\s*(?:구현|실행)|코드(?:를|을)?\s*(?:작성|구현))/u,
]);

const PLANNING_ACTION_OVERRIDES = Object.freeze([
  /(?:^|[.!?]\s*)\s*(?:please\s+)?(?:plan|strategize|brainstorm)\b/i,
  /\b(?:create|make|write|draft|prepare|outline)\s+(?:the\s+|an?\s+)?(?:plan|strategy|roadmap|specification|spec|proposal|blueprint)\b/i,
  /\b(?:help\s+me|let'?s)\s+(?:plan|strategize|brainstorm)\b/i,
  /(?:계획(?:을|를)?\s*(?:세워|세우|짜|작성|만들)|전략(?:을|를)?\s*(?:세워|세우|짜|작성)|로드맵(?:을|를)?\s*(?:작성|만들))/u,
]);

const ARTISTRY_ACTION_OVERRIDES = Object.freeze([
  /\b(?:create|build|generate|draw|render|make|design)\b[^.!?\n]{0,100}\b(?:generative|svg|visuali[sz]ation|canvas|diagram|chart|graph|infographic|heatmap|treemap|sankey|sunburst)\b/i,
  /(?:만들|생성|그려|제작)[^.!?\n]{0,60}(?:시각화|다이어그램|차트|그래프|캔버스)/u,
]);

const VISUAL_IMPLEMENTATION_OVERRIDES = Object.freeze([
  /\b(?:build|create|implement|develop|code|make|design)\b[^.!?\n]{0,100}\b(?:ui|ux|interface|front[ -]?end|responsive|dashboard|component|page|screen|modal|navbar|sidebar|button|css|html|react|vue|svelte)\b/i,
  /(?:구현|만들|개발|작성)[^.!?\n]{0,60}(?:UI|UX|인터페이스|프론트엔드|반응형|대시보드|컴포넌트|페이지|화면|모달|버튼)/iu,
  /(?:UI|UX|인터페이스|프론트엔드|반응형|대시보드|컴포넌트|페이지|화면|모달|버튼)[^.!?\n]{0,60}(?:구현|만들|개발|작성)/iu,
]);

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

  const hasExternalProviderReviewAction = EXTERNAL_PROVIDER_REVIEW_ACTIONS
    .some(pattern => pattern.test(clean));
  const hasClaudeReviewAction = CLAUDE_REVIEW_ACTIONS.some(pattern => pattern.test(clean));
  const hasProviderReviewProvenance = PROVIDER_REVIEW_PROVENANCE
    .some(pattern => pattern.test(clean));
  const hasProvenanceMutationAction = PROVIDER_PROVENANCE_MUTATION_ACTIONS
    .some(pattern => pattern.test(clean));
  const hasGenericReviewAction = GENERIC_REVIEW_ACTIONS.some(pattern => pattern.test(clean));

  if ((hasProviderReviewProvenance
      || hasExternalProviderReviewAction
      || hasClaudeReviewAction)
    && hasProvenanceMutationAction) {
    scores['external-model'] = 0;
    scores['code-review'] = 0;
    return {
      category: scores.deep > 0 ? 'deep-mutation' : 'quick',
      confidence: 0.7,
      scores,
    };
  }

  if (hasProviderReviewProvenance && hasGenericReviewAction) {
    scores['external-model'] = 0;
    scores['code-review'] = Math.max(scores['code-review'], INTENT_CATEGORIES['code-review'].weight);
    return { category: 'code-review', confidence: 0.7, scores };
  }

  // Claude is the host model, not an external /ask provider. Keep Claude-only
  // review requests on a read-only in-process reviewer. An explicit Codex or
  // Gemini actor always wins for mixed-provider requests.
  if (!hasExternalProviderReviewAction && hasClaudeReviewAction) {
    scores['external-model'] = 0;
    scores['code-review'] = Math.max(scores['code-review'], INTENT_CATEGORIES['code-review'].weight);
    return { category: 'code-review', confidence: 0.7, scores };
  }

  // Hard override: explicit external-model requests always win. Providerless
  // cross-review keeps the historical external-model default.
  // "ask codex to review this complex auth refactor" should route to /ask,
  // not to 'deep' because 'auth refactor' scored higher in that bucket.
  if (scores['external-model'] > 0 || hasExternalProviderReviewAction) {
    return {
      category: 'external-model',
      // Explicit provider syntax is decisive even when many technical nouns
      // dilute score-ratio confidence.
      confidence: 0.7,
      scores,
    };
  }

  if (SECURITY_REVIEW_OVERRIDES.some(pattern => pattern.test(clean))) {
    return { category: 'security-review', confidence: 0.7, scores };
  }

  if (TEST_AUTHORING_OVERRIDES.some(pattern => pattern.test(clean))) {
    return { category: 'test-authoring', confidence: 0.7, scores };
  }

  if (DEEP_REVIEW_OVERRIDES.some(pattern => pattern.test(clean))) {
    return {
      category: 'deep',
      confidence: 0.7,
      scores,
    };
  }

  if (DESIGN_REVIEW_OVERRIDES.some(pattern => pattern.test(clean))) {
    return {
      category: 'design-review',
      // Explicit review syntax is stronger than surrounding visual nouns.
      confidence: 0.7,
      scores,
    };
  }

  if (PRODUCT_PLANNING_OVERRIDES.some(pattern => pattern.test(clean))) {
    return { category: 'product-planning', confidence: 0.7, scores };
  }

  if (WRITING_ACTION_OVERRIDES.some(pattern => pattern.test(clean))) {
    return { category: 'writing', confidence: 0.7, scores };
  }

  const executesExistingPlan = PLAN_EXECUTION_OVERRIDES.some(pattern => pattern.test(clean));
  if (!executesExistingPlan && PLANNING_ACTION_OVERRIDES.some(pattern => pattern.test(clean))) {
    return { category: 'planning', confidence: 0.7, scores };
  }

  if (executesExistingPlan) {
    return {
      category: scores.deep > 0 ? 'deep-mutation' : 'quick',
      confidence: 0.7,
      scores,
    };
  }

  if (ARTISTRY_ACTION_OVERRIDES.some(pattern => pattern.test(clean))) {
    return { category: 'artistry', confidence: 0.7, scores };
  }

  if (VISUAL_IMPLEMENTATION_OVERRIDES.some(pattern => pattern.test(clean))) {
    return { category: 'visual-engineering', confidence: 0.7, scores };
  }

  if (scores.deep > 0 && DEEP_MUTATION_OVERRIDES.some(pattern => pattern.test(clean))) {
    return {
      category: 'deep-mutation',
      confidence: 0.7,
      scores,
    };
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
