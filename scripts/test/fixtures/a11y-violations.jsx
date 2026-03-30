/**
 * Seeded a11y violation fixture for testing Aphrodite's accessibility audit.
 * Each violation is annotated with the expected WCAG criterion.
 *
 * This file is intentionally NOT valid production code.
 * It exists solely as a test fixture for the a11y-audit skill.
 */

// VIOLATION 1: img without alt (WCAG 1.1.1)
const BadImage = () => <img src="/hero.png" />;

// VIOLATION 2: div with onClick instead of button (WCAG 4.1.2)
const BadButton = () => (
  <div onClick={() => alert('clicked')} style={{ cursor: 'pointer' }}>
    Click me
  </div>
);

// VIOLATION 3: form input without label (WCAG 1.3.1)
const BadForm = () => (
  <form>
    <input type="email" placeholder="Enter email" />
    <input type="password" />
  </form>
);

// VIOLATION 4: heading hierarchy skip h1 → h3 (WCAG 1.3.1)
const BadHeadings = () => (
  <div>
    <h1>Main Title</h1>
    <h3>Skipped h2</h3>
    <h5>Skipped h4</h5>
  </div>
);

// VIOLATION 5: outline:none without replacement (WCAG 2.4.7)
const BadFocus = () => (
  <button style={{ outline: 'none' }}>No Focus Ring</button>
);

// VIOLATION 6: color as sole indicator (WCAG 1.4.1)
const BadColorOnly = () => (
  <span style={{ color: 'red' }}>Error occurred</span>
);

// VIOLATION 7: non-descriptive link text (WCAG 2.4.4)
const BadLink = () => (
  <div>
    <a href="/docs">click here</a>
    <a href="/more">read more</a>
  </div>
);

// VIOLATION 8: tabindex > 0 (WCAG anti-pattern)
const BadTabIndex = () => (
  <div>
    <input tabIndex={3} />
    <input tabIndex={1} />
    <input tabIndex={2} />
  </div>
);

// VIOLATION 9: missing aria-label on icon button (WCAG 4.1.2)
const BadIconButton = () => (
  <button>
    <svg viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2z" /></svg>
  </button>
);

// VIOLATION 10: missing lang on html (WCAG 3.1.1)
// (would be in HTML document, represented as comment)
// <html> without lang attribute

// VIOLATION 11: auto-playing animation without prefers-reduced-motion (WCAG 2.3.1)
const BadAnimation = () => (
  <div style={{ animation: 'spin 1s infinite' }}>Loading...</div>
);

// VIOLATION 12: small touch target (WCAG 2.5.8)
const BadTouchTarget = () => (
  <button style={{ width: '20px', height: '20px', padding: 0 }}>X</button>
);

// VIOLATION 13: missing aria-live on dynamic content (WCAG 4.1.3)
const BadLiveRegion = ({ message }) => (
  <div id="status-message">{message}</div>
);

// VIOLATION 14: missing page title (WCAG 2.4.2)
// (document-level, not component — represented as comment)

// VIOLATION 15: hardcoded low contrast (WCAG 1.4.3)
const BadContrast = () => (
  <p style={{ color: '#aaaaaa', backgroundColor: '#ffffff' }}>
    Light gray on white
  </p>
);

export {
  BadImage, BadButton, BadForm, BadHeadings, BadFocus,
  BadColorOnly, BadLink, BadTabIndex, BadIconButton,
  BadAnimation, BadTouchTarget, BadLiveRegion, BadContrast,
};
