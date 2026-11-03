# References

The design of this package follows the 2026 literature on skill self-improvement, and the milestone
plan cites those papers for each non-obvious rule. This file lists the works, the identifier used in
the design notes, and what each one supports here.

Provenance: the corpus was selected from arXiv submissions between 2026-01-01 and 2026-11-02, with
the queries and the inclusion criteria recorded in the research report. The 22 identifiers below are
the ones that report used; their DataCite records were checked against title on 2026-11-02. arXiv
registers the DOI `10.48550/arXiv.<identifier>` for its papers, which is the form listed here. Version
suffixes are the ones the report pinned.

## Mechanisms and evaluation frameworks

| Reference | Identifier | DOI | What it supports here |
|---|---|---|---|
| MetaSkill-Evolve | arXiv:2607.05297v1 | 10.48550/arXiv.2607.05297 | The recursive object is the procedure, not only the skill; gains survive with a frozen model |
| Skill∞ | arXiv:2610.35434v1 | 10.48550/arXiv.2610.35434 | An optimization procedure written as a skill can be applied to itself |
| R² Flow | arXiv:2609.33867v3 | 10.48550/arXiv.2609.33867 | Acceptance signal must not be the same signal that guides the proposal |
| SELM | arXiv:2610.24630v1 | 10.48550/arXiv.2610.24630 | The validation gate is the single component with the largest effect; retirement is part of the loop |
| SkillApt | arXiv:2609.26863v3 | 10.48550/arXiv.2609.26863 | Fix the endpoint and the evidence budget before seeing results |
| HMED | arXiv:2610.07979v1 | 10.48550/arXiv.2610.07979 | Compare from the same restored starting state, one review at a time |
| RSIFlow | arXiv:2610.21791v1 | 10.48550/arXiv.2610.21791 | A gate on training batches does not extend to the evaluation set |
| VERSE | arXiv:2610.02616v1 | 10.48550/arXiv.2610.02616 | Without verification during evolution, no round beat the initial round |
| SkillCompiler | arXiv:2610.39508v1 | 10.48550/arXiv.2610.39508 | Text reread at every use carries avoidable variance; programs are verifiable |
| Compile Once, Run Cheap | arXiv:2610.25114v1 | 10.48550/arXiv.2610.25114 | Preregister the acceptance threshold and declare the minimum detectable effect |

## Validity of the evidence

| Reference | Identifier | DOI | What it supports here |
|---|---|---|---|
| Auditing the Product, Not the Recursion | arXiv:2610.27610v1 | 10.48550/arXiv.2610.27610 | Claims need the evaluation design that would falsify them; few studies audit two or more full loop repetitions |
| SAGE | arXiv:2609.36043v1 | 10.48550/arXiv.2609.36043 | A paired per-item test with abstention replaces an average gate and removes regressions |
| Who Verifies the Verifier | arXiv:2610.11464v1 | 10.48550/arXiv.2610.11464 | In open tasks the verifier is not given, so it becomes part of what evolves |
| RSIGym | arXiv:2610.10310v1 | 10.48550/arXiv.2610.10310 | Reproducing a loop needs shared budget and permissions across train and eval |
| EvoPathBench | arXiv:2609.24663v1 | 10.48550/arXiv.2609.24663 | Separate generalization, retention and adaptation when measuring a loop |

## Failure modes

| Reference | Identifier | DOI | What it supports here |
|---|---|---|---|
| Skill misevolution | arXiv:2608.12851v2 | 10.48550/arXiv.2608.12851 | Every agent and method combination wrote unsafe skills; verifying at write and at retrieval is what cuts the damage |
| SkillPoison | arXiv:2610.07645v1 | 10.48550/arXiv.2610.07645 | Do not trust successful trajectories as proof of correctness |
| Indirect injection under skill evolution | arXiv:2610.39122v1 | 10.48550/arXiv.2610.39122 | Skill evolution raises indirect injection success; the prompt must treat tool output as data |
| Co-evolution trap | arXiv:2610.20845v1 | 10.48550/arXiv.2610.20845 | Measure drift cost, not only the peak |
| Error reproduction | arXiv:2610.27406v1 | 10.48550/arXiv.2610.27406 | Stored abstractions reproduce the original error; rebuilding on demand beats replaying abstractions |
| Skill retention | arXiv:2609.39148v2 | 10.48550/arXiv.2609.39148 | Badly written descriptions degrade retention in ways no write-time metric detects |
| Compositional safety | arXiv:2609.33123v3 | 10.48550/arXiv.2609.33123 | Individually safe components compose into unsafe behaviour; runtime monitoring is the only place it shows |

## How the references map to this code

| Rule in this package | Reference |
|---|---|
| Evidence is derived from the session branch and deduplicated by id | 10.48550/arXiv.2609.24663 |
| The proposal never becomes an accepted change on its own | 10.48550/arXiv.2610.24630 |
| Acceptance needs a paired replay from the same starting state, two repetitions, a preregistered threshold and abstention | 10.48550/arXiv.2609.36043, 10.48550/arXiv.2610.07979, 10.48550/arXiv.2610.25114 |
| The acceptance signal is not the signal that guided the proposal | 10.48550/arXiv.2609.33867 |
| Tool output, including error excerpts, travels delimited as data | 10.48550/arXiv.2610.39122 |
| Successful tool calls are not treated as proof that a lesson is good | 10.48550/arXiv.2610.07645 |
| Writes are verified on write, and retrieval revalidates what it reads | 10.48550/arXiv.2608.12851 |
| Every decision is recorded with its evidence, so a later audit can ask what would have falsified it | 10.48550/arXiv.2610.27610 |
| Retirement by merit and drift measurement are part of the loop, not extra features | 10.48550/arXiv.2610.24630, 10.48550/arXiv.2610.20845 |
| The recursive step is described as out of scope until the generator is versioned and evaluated the same way | 10.48550/arXiv.2607.05297, 10.48550/arXiv.2610.35434 |

## pi documentation

The extension is built against the pi 1.4 API and cites it per call site in the design notes:

- `docs/extensions.md`: factory, command and tool registration, `appendEntry`, `sendUserMessage`, `reload` scope.
- `docs/skills.md`: skill discovery, frontmatter requirements, reload after editing.
- `docs/packages.md`: host-provided packages, peer dependencies and the `pi-package` keyword.
- `docs/sdk.md` and `examples/sdk/04-skills.ts`: session creation and `skillsOverride`, used by the M1 gate design.
- `examples/extensions/reload-runtime.ts`: the reload pattern that M2 follows.
