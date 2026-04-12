---
name: resume-handoff
description: Read persisted browser handoff state and confirm manual resume point — thin state-reader, no auto-resume
---

<Resume_Handoff_Skill>

## Purpose

After autonomous browser-based QA pauses at a CAPTCHA, auth gate, or MFA prompt,
the orchestrator writes the current URL and a sanitized breadcrumb to
`.ao/state/browser-handoff.json`.

`/resume-handoff` is the human-facing half of this protocol. It:
1. Reads `.ao/state/browser-handoff.json`
2. Prints the persisted URL + breadcrumb
3. Asks the user to confirm the new starting state after they complete the manual step
4. Records the resume event in the run artifact

**NO deterministic auto-resume** — UA/TLS fingerprint persistence is deferred
to v1.0.3. This skill only handles the manual confirmation step.

## Use_When

- The orchestrator paused at an auth gate and notified you to complete a step manually
- You want to check what URL and breadcrumb state were persisted before the pause
- You are ready to confirm a new starting state and continue the QA flow

## Do_Not_Use_When

- No handoff state exists (skill will report "no pending handoff")
- You want the orchestrator to automatically resume from the persisted state (v1.0.3)

## Workflow

### Step 1 — Read handoff state

```javascript
import { readHandoff, isHandoffStale } from './scripts/lib/browser-handoff.mjs';

const state = await readHandoff({
  stateDir: '.ao/state',
  includeStale: true, // so we can show stale info and warn
});
```

If no state file exists:
```
No pending browser handoff found. The orchestrator has not paused at an auth gate,
or the handoff state was already cleared.
```

If state is stale (older than 24h):
```
⚠️  Browser handoff state is STALE (created more than 24h ago).
You must restart the QA flow from the beginning.

Last persisted URL: <url>
Created at: <timestamp>
```

### Step 2 — Display URL and breadcrumb

```
## Browser Handoff Resumed

The orchestrator paused at an authentication gate.

**Session ID**: <sessionId>
**Paused at URL**: <sanitized url>
**Last step**: <breadcrumb.step>
**Last clicked**: <breadcrumb.lastClickedSelector>
**Screenshot**: <breadcrumb.screenshotPath or 'none'>
**Paused at**: <createdAt>

---

The URL above is the page where the orchestrator was blocked.
Please open this URL in your browser and complete the manual step
(CAPTCHA, login, MFA, or other auth gate).
```

### Step 3 — Prompt for confirmation

```
After completing the manual step, enter the new starting state:

  New URL (after auth, leave blank to use same URL):
  > _

  Confirmation token (optional, for audit):
  > _
```

Record the user's confirmed state. This is NOT used for automatic navigation —
it is stored as a resume event in the run artifact for the orchestrator to
reference when it continues.

### Step 4 — Record resume event in run artifact

```javascript
// Record the resume event
const runId = state.runId || String(Date.now());
const artifactDir = `.ao/artifacts/runs/${runId}`;
await fs.mkdir(artifactDir, { recursive: true });
await fs.appendFile(
  `${artifactDir}/browser-handoff-events.jsonl`,
  JSON.stringify({
    type: 'handoff_resumed',
    sessionId: state.sessionId,
    pausedUrl: state.url,
    confirmedUrl: userConfirmedUrl || state.url,
    breadcrumb: state.breadcrumb,
    pausedAt: state.createdAt,
    resumedAt: new Date().toISOString(),
  }) + '\n',
);
```

### Step 5 — Report to user

```
## Handoff Confirmed

Resume event recorded.

The orchestrator can now continue from the confirmed starting state.
Invoke /atlas, /athena, or the relevant workflow to continue execution.

Note: The orchestrator will NOT automatically navigate to the confirmed URL.
You must restart the relevant workflow task manually for v1.0.2.
Deterministic auto-resume (UA/TLS fingerprint persistence) is planned for v1.0.3.
```

## Output Format

```
## Browser Handoff State

| Field | Value |
|-------|-------|
| Session ID | <sessionId> |
| Paused URL | <url> |
| Last step | <step> |
| Last clicked | <selector> |
| Paused at | <timestamp> |
| Status | active / STALE |

### Next Steps

1. Open the URL above in your browser
2. Complete the manual auth/CAPTCHA step
3. Confirm the new starting state when prompted
4. Re-invoke the orchestrator workflow

⚠️  Note: v1.0.2 does NOT auto-resume. You must manually restart the relevant task.
```

## Iron Laws

1. **No auto-resume** — DO NOT attempt to navigate the browser automatically
2. **Read-only state** — this skill reads handoff state, it does not create it
3. **Warn on stale** — always warn if state is older than 24h
4. **Record resume event** — always write the resume event to the run artifact
5. **Show sanitized URL only** — never display raw unsanitized URLs (they are stored sanitized)

## Spec Note

Per spec.md: "Deterministic exact-resume (UA/TLS fingerprint persistence) is
DEFERRED to v1.0.3." This skill is the manual confirmation step only.

</Resume_Handoff_Skill>
