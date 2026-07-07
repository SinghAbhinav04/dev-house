---
name: squad-memory
description: Record a durable fact for the rest of the team, or look up the full detail behind a line in the team memory index. Use when you decide something non-obvious, discover a gotcha, or need the reasoning behind an existing memory line.
---

# Team memory

You are one of several members working on this project, each in a separate
session. You cannot see anyone else's conversation. Team memory is the only way
what you learn survives past your own turn.

## Reading

Your prompt already includes the memory **index** — one line per established
fact, like:

```
[m17] decision · auth · Sessions are JWT, not DB-backed · src/lib/auth.ts
```

That line is usually enough. When you need the reasoning behind one, read the
entry:

```
.squad/memory/entries/m17.md
```

Treat indexed facts as established. Do not re-derive or contradict one without
checking the entry first — and if you find it is now wrong, record a correction
rather than silently working around it.

## Writing

Record something when it is **durable and non-obvious**: a decision and why, a
non-local flow, a gotcha that cost you time, an interface contract another
member must honour.

Do **not** record: what the code plainly says, restatements of the plan,
progress narration ("finished the API"), or anything true only for this turn.
Every line you add is re-read by every member on every later turn, so a
low-value line is a permanent tax.

To record, write a new file into the inbox — this is the one place every member
can write, including read-only ones:

```
.squad/memory/inbox/<your-member-id>-<timestamp>.md
```

with this shape:

```markdown
---
kind: decision
claim: Sessions are JWT-based, not database-backed
tags: auth, sessions
files: src/lib/auth.ts
---

Chose JWT over DB sessions because the deploy target has no persistent
store. Trade-off: revocation needs a short TTL plus a refresh endpoint.
```

- `kind` — one of `decision`, `flow`, `gotcha`, `fact`, `interface`
- `claim` — **one sentence**, under 120 characters. This is what everyone sees;
  make it assertive and specific. "Sessions are JWT-based" beats "auth stuff".
- `tags` — up to 3
- `files` — up to 3 paths the claim is about
- body — the reasoning, the trade-off, the thing that would not be obvious later

Write one file per fact. Do not edit existing inbox files, do not touch
`index.md` or `entries/` — the orchestrator folds the inbox into the index
between turns and will reject duplicates.
