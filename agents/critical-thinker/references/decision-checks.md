# Decision checks — detection vocabulary

## Status

This file is a LOCAL addition to the critical-thinker agent (do not sync upstream with pi-subagents).

- **Role**: detection vocabulary for the decision-consistency function (oracle of the inherited context). It is NOT a text-evaluation pipeline.
- The procedural apparatus of the source catalogs (5-step procedure, severity ratings, verdicts, report format, verification checklists) is EXCLUDED. Only the concepts and signals adapted here are used.
- Labeling describes reasoning mechanisms. The validity of a move is decided against the inherited contract, not against the label. Labeling a fallacy is NOT a veto of the move.
- Hierarchy: fallacy and epistemic defect are MECHANISM DESCRIPTORS attached to the oracle's native categories (drift / contradiction / hidden assumption / pivot risk). They do not compete with them.

Each entry has: one-line definition, diagnostic question (in decision domain, not textual), adapted detection signals, and source reference (`falacias.md` = fallacies catalog, `defectos-epistemicos.md` = epistemic defects catalog). Examples from the catalogs are NOT copied; signals are rewritten for agent decisions.

---

## 1. Equivocación / Hombre de paja (Equivocation / Straw man) — source: falacias.md #15, #2

**Definition**: A key term or position of an inherited decision is used with a shifted meaning, or the inherited position is distorted (simplified, exaggerated, or replaced) to make its dismissal easier. Equivocation operates at the term level; straw man at the position level; both are the most common drift modes when citing the contract.

**Diagnostic questions**: Does the key term keep the same scope in the inherited decision and in the current trajectory? Is the position attributed to the contract the position the contract actually holds?

**Signals**:
- The same decision term subtly changes scope between the forked context and the current proposal.
- The trajectory attributes an extreme or simplified position to a prior decision that the context does not support ("the prior decision said X" when it said Y).
- The contract is reformulated in absolute terms right before proposing its dismissal.

**Native category**: drift / contradiction.

---

## 2. Petición de principio (Begging the question) — source: falacias.md #8

**Definition**: A move's justification assumes exactly what must be demonstrated against the contract.

**Diagnostic question**: Is the key premise of the justification a restatement of the conclusion in other words?

**Signals**:
- Justifications cite the move itself as its own evidence.
- The consistency of a pivot is taken for granted without anchoring it to contract nodes.
- A prior decision is defended only because it exists ("it was decided, therefore it stands").

**Native category**: hidden assumption.

---

## 3. Apelación a la ignorancia / Inversión de carga de la prueba (Appeal to ignorance / Burden of proof shift) — source: falacias.md #4, #19

**Definition**: Absence of contradiction in the context is treated as established consistency; proof of inconsistency is demanded from whoever objects instead of resting on whoever proposes the move.

**Diagnostic questions**: Is "nothing in the contract forbids it" being treated as "the contract permits it"? On whom does the burden of demonstrating the pivot's consistency fall?

**Signals**:
- "No part of the context contradicts it" as the only support for a move.
- The burden of proving consistency is shifted to the objector.

**Native category**: hidden assumption / drift.

---

## 4. Falso dilema (False dilemma) — source: falacias.md #6

**Definition**: A decision is framed as having only two options (e.g., "contract or rewrite") when intermediate or additional alternatives exist.

**Diagnostic question**: Are more options available than the ones actually evaluated? Does the framing exclude intermediate positions without justification?

**Signals**:
- "Either X or Y" framing in decision outlines.
- Language that denies a middle ground ("there is no other option") without exploring alternatives.

**Native category**: pivot risk.

---

## 5. Pendiente resbaladiza (Slippery slope) — source: falacias.md #7

**Definition**: A move is said to lead inevitably to a chain of undesirable consequences without evidence for the intermediate links.

**Diagnostic question**: Are all links between the decision and the feared outcome justified?

**Signals**:
- Causal chains without evidence between links.
- Language of inevitability ("will lead to", "will end in").
- Escalation from minor to major consequences without intermediate argumentation.
- Watch both the main agent's reasoning AND the oracle's own alarms (must not reject a move with an unjustified cascade).

**Native category**: pivot risk (over-alarming).

---

## 6. Non sequitur (Non sequitur) — source: falacias.md #16

**Definition**: The recommended conclusion does not follow from the contract decisions and constraints cited to support it.

**Diagnostic question**: Does the recommendation derive from the cited premises, or is there a jump?

**Signals**:
- Abrupt jumps between diagnosis and recommendation.
- Recommendations with no evident connection to the inherited decisions cited.

**Native category**: drift / contradiction.

---

## 7. Generalización apresurada (Hasty generalization) — source: falacias.md #9

**Definition**: A single contract node or isolated data point is elevated to a general rule that supports a move.

**Diagnostic question**: Does the cited context node represent the whole relevant contract?

**Signals**:
- Universal quantifiers ("the context decided", "everything indicates") based on a single node.
- Categorical claims about inherited intentions without coverage in the fork.

**Native category**: hidden assumption / drift.

---

## 8. Selección selectiva (Cherry picking) — source: falacias.md #20

**Definition**: Only contract passages that favor the current move are cited; passages that contradict it are omitted.

**Diagnostic question**: Is the cited context evidence the whole pertinent context, or a favoring subset?

**Signals**:
- Favorable passages presented without mentioning contradicting passages from the same period.
- Systematic omission of nodes that qualify the cited decision.

**Native category**: contradiction / hidden assumption.

---

## 9. Falacia del falacista (Fallacy fallacy) — source: falacias.md #17

**Definition**: An inherited decision is dismissed because the reasoning that produced it was defective, without examining whether the decision stands on other grounds.

**Diagnostic question**: Is the inherited decision inconsistent with the contract, or merely defective in its original justification?

**Signals**:
- Rejection of an inherited decision based solely on flaws in its original argument.
- Dismissing a move by pointing at fallacies without checking it against the contract.
- Applies to the oracle's own self-control: a weak original justification is not, by itself, grounds for a pivot.

**Native category**: pivot risk (self-control).

---

## 10. Aserción sin anclaje (Unanchored assertion) — source: defectos-epistemicos.md #1

**Definition**: A finding (the oracle's or the main agent's) asserts what the contract decides without referencing a verifiable node of the fork.

**Diagnostic question**: Where and when does this decision appear in the inherited context? Every finding requires a fork citation.

**Signals**:
- Claims about "the context" or "what was decided" without a location.
- Conclusions presented as contract facts that cannot be traced to a node.

**Native category**: output discipline / hidden assumption.

---

## 11. Desajuste de certeza (Certainty mismatch) — source: defectos-epistemicos.md #3

**Definition**: Absolute-certainty language ("this violates D", "this is drift") is used when the context only supports partial or probable conclusions ("may qualify", "suggests").

**Diagnostic question**: Does the confidence of the language match the weight of the fork evidence?

**Signals**:
- Certainty verbs ("violates", "contradicts", "proves") applied to inferences drawn from compressed or partial context.
- Findings without coarse confidence qualifications (high / low).

**Native category**: output discipline.

---

## 12. Atribución difusa (Diffuse attribution) — source: defectos-epistemicos.md #9

**Definition**: The contract is reconstructed as a block ("the inherited decisions") without specifying which node holds each decision.

**Diagnostic question**: Can every reconstructed decision be attributed to a specific node (turn, file, explicit decision) of the fork?

**Signals**:
- Collective subjects without breakdown ("the context", "the conversation").
- Decisions from different moments grouped without one-to-one correspondence.

**Native category**: contract-reconstruction discipline.

---

## 13. Posición no diferenciada / Escalera de inferencia oculta (Undifferentiated position / Hidden inference ladder) — source: defectos-epistemicos.md #10

**Definition**: A conclusion sits several inferential steps above the cited contract nodes without showing the intermediate steps; contract reporting and the oracle's own interpretation are mixed without markers.

**Diagnostic questions**: What are the steps between the fork evidence and the conclusion? Can the reader tell what the contract says from what the oracle infers?

**Signals**:
- Broad conclusions about the trajectory drawn from local decisions.
- Unmarked transitions between contract reporting and own analysis ("this suggests", "in the oracle's judgment").
- Passages where it is unclear what belongs to the contract and what to inference.

**Native category**: output discipline / drift.

---

## 14. Vacío de contexto vs. vacuidad de hecho (Context gap vs. fact gap) — source: defectos-epistemicos.md #8

**Definition**: Absence of X in the inherited context (a fork possibly degraded by compression or context rot) is treated as proof that X was not considered; or, inversely, absence of a mention in the contract is treated as proof the decision never existed.

**Diagnostic questions**: Is the absence in the fork (possibly truncated) or is it positively known that the event did not occur? Does "nothing in the context says X" distinguish not-documented from not-done?

**Signals**:
- "Nothing in the context says X" without distinguishing not-documented from not-realized.
- Conjectures about the contract based on the fork's silence.
- Claims that a topic was never decided when the fork may have been truncated.
- Native purpose of the oracle: exploit the clean forked context against the main agent's context rot — and conversely, never treat the fork's silence as the contract's nonexistent decision.

**Native category**: context rot / contract-reconstruction discipline.
