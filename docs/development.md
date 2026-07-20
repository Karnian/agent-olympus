# Development
> Moved from CLAUDE.md.

## How to Add a New Agent

1. Create `agents/<name>.md` with frontmatter:
   ```yaml
   ---
   model: sonnet  # haiku | sonnet | opus
   description: One-line description
   ---
   ```
2. Write the persona prompt below the frontmatter
3. Reference it in skills as `agent-olympus:<name>`

## How to Add a New Skill

1. Create `skills/<name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: <name>
   description: One-line description (include key trigger keywords for discoverability)
   ---
   ```
2. Write the workflow steps
3. Reference agents via `Task(subagent_type="agent-olympus:<agent>", model="<tier>", prompt="...")`

## How to Add a New Hook

1. Create `scripts/<hook-name>.mjs` following the fail-safe pattern:
   ```javascript
   import { readStdin } from './lib/stdin.mjs';
   async function main() {
     try {
       const raw = await readStdin(3000);
       const data = JSON.parse(raw);
       // ... hook logic ...
       process.stdout.write(JSON.stringify({ /* output */ }));
     } catch {
       process.stdout.write('{}');
     }
     process.exit(0);
   }
   main();
   ```
2. Register in `hooks/hooks.json` under the appropriate event
3. Use `run.cjs` as the command wrapper for version-safe resolution

### schemaVersion Convention (v1.0.2+)

Every persisted format carries an independently versioned `schemaVersion`:
- **JSON files**: top-level field (`{ "schemaVersion": 1, ... }`)
- **JSONL files**: per-line field (`{"schemaVersion":1,"id":"..."}`)
- **Loader rule**: loaders must explicitly define their unknown-version policy. Non-authoritative caches may return an empty default with a diagnostic; authorization, permission, locking, and admission state must preserve the artifact and fail closed when its semantics are unknown.
- **Writer rule**: writers emit the format's current exported schema constant rather than assuming every format remains at version 1.
- **Migration policy**: a version increment requires an explicit migration path for supported older versions or a clear upgrade message. Never silently reinterpret an unknown future version.

The concurrency ledger is `schemaVersion: 2`. Version 2 makes its recovery
barrier part of the compatibility boundary so a v1 reader rejects it instead
of discarding admission-critical metadata. The v2 loader durably migrates a
valid ordinary v1 ledger; unknown versions and v1 artifacts containing
unpublished recovery metadata remain unchanged and block admission. Legacy
defaults apply only to absent fields, never explicit nulls. Recovery quarantine
preserves original bytes, recovery expiry re-scans late durable team state, and
compact canonical writes are size-checked before atomic replacement.

### Hardened Append-Only Artifact Policy (v1.5.0+)

Run and phase artifacts must use the shared primitives in
`scripts/lib/hardened-fs.mjs`; do not create a parallel no-follow/TOCTOU layer.
Creation and finalization paths require private `0700` directories. A read-only
audit of a pre-hardening artifact may opt into legacy directory modes, but it
must still bind and revalidate trusted ancestry without following symlinks.
Regular artifacts are bounded, single-link `0600` files opened with
`O_NOFOLLOW` where the platform supports it.

Callers select the generation policy explicitly: phase artifacts retain their
historical `object-size` compatibility check, while terminal run finalization
uses the stricter `full` identity/mode/size/time check. This policy difference
is intentional and documented in the module JSDoc.

Operational `events.jsonl` recovery readers skip malformed or torn records and
preserve every valid record around them. An invalid record cannot exact-match a
normal event, so ignoring it does not change the ensure-event idempotency count.
The phase/finalization ensure paths opt into missing-LF repair and verify the
exact appended byte range instead of reparsing the complete bounded log. Other
JSONL artifacts retain their caller-specific policy; notably, eval attestation
rejects any malformed production event.
