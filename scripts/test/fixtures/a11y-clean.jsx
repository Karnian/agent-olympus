/**
 * Clean a11y fixture — this component has ZERO accessibility violations.
 * Used as a negative test case for the a11y-audit skill.
 */

const GoodImage = () => (
  <img src="/hero.png" alt="Product hero banner showing the dashboard" />
);

const GoodButton = () => (
  <button type="button" onClick={() => alert('clicked')}>
    Click me
  </button>
);

const GoodForm = () => (
  <form>
    <label htmlFor="email-input">Email address</label>
    <input id="email-input" type="email" aria-describedby="email-help" />
    <span id="email-help">We will never share your email.</span>

    <label htmlFor="pw-input">Password</label>
    <input id="pw-input" type="password" aria-describedby="pw-help" />
    <span id="pw-help">Must be at least 8 characters.</span>
  </form>
);

const GoodHeadings = () => (
  <div>
    <h1>Main Title</h1>
    <h2>Section</h2>
    <h3>Subsection</h3>
  </div>
);

const GoodFocus = () => (
  <button
    type="button"
    style={{ outline: 'none', boxShadow: '0 0 0 3px #4A90D9' }}
  >
    Custom Focus Ring
  </button>
);

const GoodLink = () => (
  <a href="/documentation">Read the full documentation</a>
);

const GoodIconButton = () => (
  <button type="button" aria-label="Open menu">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 18h18v-2H3v2z" />
    </svg>
  </button>
);

const GoodLiveRegion = ({ message }) => (
  <div id="status-message" role="status" aria-live="polite">
    {message}
  </div>
);

const GoodTouchTarget = () => (
  <button
    type="button"
    style={{ minWidth: '44px', minHeight: '44px', padding: '8px' }}
  >
    X
  </button>
);

export {
  GoodImage, GoodButton, GoodForm, GoodHeadings, GoodFocus,
  GoodLink, GoodIconButton, GoodLiveRegion, GoodTouchTarget,
};
