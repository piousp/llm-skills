import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import type { DirectionalJudgeFn } from "./gate/directional-flow.ts";
import { createJudge } from "./gate/judge.ts";
import type { CompleteFn } from "./proposer.ts";
import type { GateTokens } from "./types.ts";

// The construction of the one model call this package makes (M1c, S5).
//
// The call itself is `CompleteFn` (src/proposer.ts): the model is bound by the caller, which keeps the modules that
// use it free of the registry and keeps a test fake free of a provider. What every caller of this package shares is
// not the wiring but the two rules the call obeys, and they are wired once, here:
//
//   maxTokens  is a required option of CompleteFn, so no call of this package is unbounded. Each caller passes its
//              own budget -- PROPOSAL_MAX_TOKENS for a lesson, JUDGE_MAX_TOKENS for a verdict -- and this module never
//              invents one.
//   sessionId  travels with every request, not only with the session's own turns: the registry resolves credentials
//              and forwards the options untouched, and the routing header of a session-affine provider is built from
//              this field alone. A provider that routes by session refuses a request without it (the opencode-go
//              provider answers 400 MissingSessionID), and pi's own agent loop passes it on every request, so a call
//              made outside that loop has to pass it too.
//
// Until M1c this wiring was private to src/improve-flow.ts and the proposer was its only user. The judge of the
// directional gate (src/gate/judge.ts) is the second one, so it moved here: two copies of "one call, bounded, with
// the session on it" would be two places for the next caller to get it wrong. The construction is the whole of what
// moved -- no caller changed what it sends.
//
// M1c adds the second construction of this module and no new rule: `createDirectionalJudge` wraps a CompleteFn built by
// `createModelCall` with the judge of the bank base, which is the same call with the same budget and the same session,
// read one step closer so that the cost of the judgement can travel with the verdict.

// The one method of pi's ModelRegistry this package calls, typed exactly after it: a ModelRegistry satisfies this
// interface without a conversion, and a test fake only has to provide one method.
export interface ModelCallRegistry {
  complete(
    model: Model<Api>,
    context: Context,
    options?: ModelsApiStreamOptions<Api>,
  ): Promise<AssistantMessage>;
}

export interface ModelCallInput {
  // The registry credentials are resolved through. It is the only member of pi's context this seam needs.
  registry: ModelCallRegistry;
  // The model of the run, already resolved by the caller: this module never picks one. The choice belongs to the
  // caller, which is also the one that records it -- the diagnosis pins it on every replay item, and the judge
  // records it as judge.model (OA5).
  model: Model<Api>;
  // The identifier of the session the call belongs to, read once. A session has one id for its whole life, so
  // reading it when the call is built and reading it per request name the same session.
  sessionId: string;
  // What the caller aborts with, used only for a call that carries no signal of its own: pi aborts the signal of a
  // tool call it cancels, and a command has nothing to abort with. The per-call signal wins, so a caller that hands
  // out one CompleteFn can still abort a single call of it.
  signal?: AbortSignal;
}

// One CompleteFn, bound to the registry, the model and the session. The per-call options still decide the budget and
// may add their own signal, so whoever makes the call keeps control of what each call spends and of what it aborts.
export function createModelCall(input: ModelCallInput): CompleteFn {
  return (context, options) => {
    const signal = options.signal ?? input.signal;
    return input.registry.complete(input.model, context, {
      ...options,
      sessionId: input.sessionId,
      ...(signal === undefined ? {} : { signal }),
    });
  };
}

// The judge of the directional gate, over a CompleteFn of this module (M1c, S10).
//
// `createJudge` answers what a reply said and nothing about what it cost (src/gate/judge.ts), because the module that reads
// a reply is not the module that pays for it. The record of the bank keeps the cost of every call it made -- the usage of
// each judgement and the total of the second condition (OA10) -- so the seam the flow spends (`DirectionalJudgeFn`) answers
// a verdict WITH its cost, and this is the one place that can measure it: the message the call answered passes through here
// and nowhere else.
//
// The judge is built per call and not once per construction: the cost of a judgement is the cost of one message, and a judge
// shared between two calls of the seam would be a variable the two of them could overwrite. Building one costs a closure.
//
// A verdict whose message cannot be priced -- a seam built by someone else, a call that answered nothing -- leaves as the
// abstention of the second condition instead of as a verdict with an invented zero: the gate cannot accept on a cost it
// could not record.
export function createDirectionalJudge(complete: CompleteFn): DirectionalJudgeFn {
  return async (request) => {
    // The cost of the one call this judgement makes, written by the CompleteFn below and read after the judge answered.
    // A holder and not a local: the assignment happens inside a closure, and the read has to happen after it ran.
    const measured: { usage?: GateTokens } = {};

    const judge = createJudge(async (context, options) => {
      const message = await complete(context, options);
      measured.usage = { input: message.usage.input, output: message.usage.output };
      return message;
    });

    const verdict = await judge(request);
    if (!verdict.ok) return verdict;

    const usage = measured.usage;
    if (usage === undefined) return { ok: false, error: "unavailable" };

    return { ok: true, value: { verdict: verdict.value.verdict, reason: verdict.value.reason, usage } };
  };
}
