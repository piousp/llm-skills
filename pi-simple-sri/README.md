# pi-simple-sri

A self-improvement loop for pi skills, with the audit trail built first.

Self-recursive improvement, SRI for short, names a system that improves the procedure producing its
own improvements instead of only improving outputs. In this package the artifact is text: a `SKILL.md`
and the lessons stored beside it. A lesson is a short procedural note recording what a failure
taught, so the next run of that skill does not repeat it.

This release is the first half of the loop. It collects a failure, drafts a lesson and stages it with
a decision record. It does not touch the skill yet: accepting a lesson requires a paired replay that
shows the lesson helps, and that gate arrives in the next milestone. Call it gated iterative
self-improvement; the recursive step, where the generator itself is versioned and evaluated, is not
built.

The design follows the 2026 literature on skill self-improvement. [REFERENCES.md](REFERENCES.md)
lists the papers behind each rule, with their identifiers and what each one supports.

## Install

```bash
pi install npm:pi-simple-sri
```

Needs pi 1.4 or newer. To load the working copy instead:

```bash
cd pi-simple-sri && pi -e .
```

## Use it

Start in a session that already has a failure in it. The loop reads the current branch of the
session, so a fresh session has nothing to improve.

1. Something breaks. For example, ask for a file that is not there:
   `read /tmp/report.pdf and tell me what page 4 says`.
2. Optionally correct it: `no, the file is in ~/Descargas/report.pdf`.
3. Ask for a lesson for the skill involved:

```
/skill-improve pdf-tools
```

The command prints the path of the staged candidate. A hint after the skill name lands in the
decision record:

```
/skill-improve pdf-tools merged cells lose their column order
```

The model can run the same pipeline through a tool. `diagnose` reads only; `propose` writes the
staged candidate:

```
skill_improve {action: "diagnose", skill: "pdf-tools"}
skill_improve {action: "propose", skill: "pdf-tools", focus: "merged cells"}
```

Neither surface accepts a lesson. Acceptance belongs to the command, and it is not implemented yet.

## What counts as a failure

| Signal | When it is recorded |
|---|---|
| Tool error | A tool result comes back with `isError` |
| User correction | The user replies after a tool error, before another tool result |
| Retry loop | The same tool runs three or more times with the same arguments, successful or not |

Each signal becomes an evidence item with a deterministic id, a hash of its canonical arguments and
the assistant cycle it belongs to. Repeated evidence is deduplicated by that id.

A diagnosis needs at least one replayable item: one with the user prompt that led to it and a
predicate the gate can test. An item without a prompt, or a tool failure without a tool name, is not
replayable and does not displace one that is.

## The loop

1. Read `settings.json` and the skill inventory. A skill is eligible unless the configuration says
   otherwise.
2. Derive the evidence from the current branch.
3. Diagnose: failure signature, replay items, predicates.
4. Draft the lesson with one model call. The skill text and the evidence travel in delimited blocks
   marked as data, and the prompt says that tool output is not instructions. Markers are escaped so
   a value cannot close its own block.
5. Validate the draft with the same rules used to read it back. An empty body, a bad date or a body
   over 8192 bytes is rejected before anything is written.
6. Write the candidate to `staging/`, append a line to the audit index, and record a session entry.

If the index cannot be written, the candidate is removed and the error names both paths. A staged
candidate never exists without its index line.

## What lands on disk

```
staging/<timestamp>/<skill>/
├── lessons/<slug>.md        the candidate, with frontmatter
└── decision.json            evidence, diagnosis, gate block, outcome
state/attempts.jsonl         one event per line, append only
```

`decision.json` follows [schemas/decision.schema.json](schemas/decision.schema.json). The index
events today are `proposed`, `no-evidence`, `not-eligible` and `no-model`; M1 adds `accepted`,
`gate-rejected` and `gate-abstained`.

The session entry appears in `/tree` under the type `skill-improvement`. It stays out of the model
context.

## Configuration

Skills are eligible by default. To restrict them, add a top-level key to `~/.pi/agent/settings.json`:

```json
{
  "pi-simple-sri": {
    "skills": {
      "allow": ["pdf-tools"],
      "deny": ["system-config"]
    }
  }
}
```

Names are exact, not globs. `deny` wins over `allow`, and an empty or missing `allow` means every
skill is eligible. A skill is checked under both of its names, the frontmatter `name` and the
directory name, because pi accepts that the two differ. The file is only read.

## Safety

- The loop writes inside the package's `staging/` and `state/` directories. In this release it never
  writes inside a skill.
- Every write goes through one chokepoint: the target is checked against the write perimeter with
  resolved paths, written to a temporary file, renamed, then read back and compared byte by byte.
- Writes to the same file are serialized inside the process, and a file that is a symlink is written
  through the link instead of being replaced by a regular file.
- Without a model, or with an aborted signal, nothing is written.
- JSON and print modes have no UI, so the result goes through the session message channel instead of
  a notification.

## Limits

- A new session has no evidence, so the command reports that there is nothing to improve. The
  failure has to happen in the current branch.
- Standalone `.md` skills cannot be improved. They have no directory of their own for `lessons/`.
- No lesson is accepted in this release. Staging is the end of the line.
- The audit index is per installation, and its append is a read-modify-write inside one process. Two
  pi sessions writing to the same installation in the same second can lose one line.
- The proposal is one model call capped at 2048 tokens. A longer lesson fails validation instead of
  arriving truncated.

## Roadmap

- M1: paired replay gate, acceptance, version history inside the skill, and the reference line in
  `SKILL.md`.
- M2: reload after acceptance so the new lesson is active in the same session.
- M3: automatic evidence collection, typed diagnosis, and acceptance, rejection and regression
  metrics.

## More

- [DEVELOPER.md](DEVELOPER.md): layout, tests and the rules that came out of the design.
- [REFERENCES.md](REFERENCES.md): the papers the design draws on.
- [CHANGELOG.md](CHANGELOG.md).
- [schemas/decision.schema.json](schemas/decision.schema.json).

## License

MIT
