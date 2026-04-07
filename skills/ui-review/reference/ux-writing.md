---
schemaVersion: 1
module: ux-writing
---

# UX Writing — reference module

## Domain

Microcopy, error messages, empty states, button labels, form hints, and the
voice & tone that runs through every surface. Covers plain-language rules,
actionable phrasing, and the difference between explaining and apologizing.

## Top 5 principles

1. **Verbs over nouns on actions.** "Save draft" > "Draft". "Delete account" > "Account deletion".
2. **Tell the user what to do, not what went wrong.** "Add a street number" beats "Invalid address".
3. **Front-load the important word.** "Paid — $42" reads faster than "You were charged $42".
4. **Write like a thoughtful colleague.** Not a lawyer, not a marketer, not a robot.
5. **Consistency beats cleverness.** Pick one word for each concept (Save, Submit, Send)
   and never substitute.

## Top 5 anti-patterns

1. **"Oops! Something went wrong."** Tells the user nothing actionable.
   Replace with the actual problem and a path to recovery.
2. **Empty states that just say "No items".** A wasted opportunity to explain
   what this screen will hold once populated and how to create the first item.
3. **Passive voice in errors.** "The field was not filled in" → "Add your email".
4. **Button labels that are generic ("OK", "Submit").** Say what the click does:
   "Send message", "Confirm deletion".
5. **Tone whiplash.** Marketing-cheerful in onboarding, corporate-cold in errors.
   Pick a voice and hold it everywhere.

## Worked example

```tsx
/* Bad — vague, passive, marketer-cheerful next to nothing-to-see */
<Empty title="Hooray!" body="No items yet." />
<Error message="Oops! Something went wrong. Please try again." />
<Button>OK</Button>

/* Good — actionable, human, consistent voice */
<Empty
  title="Your projects will live here"
  body="Create a project to start tracking tasks and sharing updates with your team."
  action={<Button>New project</Button>}
/>
<Error
  title="We couldn't save your changes"
  body="Your network dropped mid-save. Your draft is still on this device."
  action={<Button>Retry save</Button>}
/>
<Button>Send invitation</Button>
```
