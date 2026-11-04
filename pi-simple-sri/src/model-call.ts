import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import { modelIdentity } from "./evidence.ts";
import type { DirectionalGateDeps, DirectionalGateRequest, DirectionalJudgeFn } from "./gate/directional-flow.ts";
import type { GateDeps, GateRequest } from "./gate/flow.ts";
import { createJudge } from "./gate/judge.ts";
import type { CompleteFn } from "./proposer.ts";
import type { GateTokens, Result } from "./types.ts";
import { toErrorMessage } from "./values.ts";

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
//
// M1c adds a third piece too, and it is the one that keeps the two surfaces of the package from building the gate of the bank
// twice: `wireDirectionalGate` is the request, the seams and the judge of that gate, built once from the session of the run
// the way the proposer and the judge above are built from it.

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
//
// The same rule read the other way is why the abstention carries what the call spent (M1c review, R1): the second
// condition does not stop speaking for free. A reply nobody could read and a provider that failed are both a call the run
// paid for, so the cost of the message travels in the error and the flow adds it to `tokens.judge` -- a record that
// dropped it would underestimate the decision, which is exactly what the comment of tokenTallyOf (src/gate/budget.ts)
// refuses. The cause of a failed call travels too, in `detail`: `createJudge` answers the abstention and forgets the
// exception, so the one place that can still see it is the CompleteFn this wrapper owns.
export function createDirectionalJudge(complete: CompleteFn): DirectionalJudgeFn {
  return async (request) => {
    // The cost of the one call this judgement makes, written by the CompleteFn below and read after the judge answered.
    // A holder and not a local: the assignment happens inside a closure, and the read has to happen after it ran.
    const measured: { usage?: GateTokens } = {};
    // Why the call failed, when it did. Empty for a call that answered a message, whatever the judge made of it.
    const cause: { detail?: string } = {};

    const judge = createJudge(async (context, options) => {
      try {
        const message = await complete(context, options);
        measured.usage = { input: message.usage.input, output: message.usage.output };
        return message;
      } catch (error) {
        // The message of the runtime is the only fact that tells a provider that is down from one that refused the
        // request, so it is kept before the judge turns the error into its abstention.
        cause.detail = toErrorMessage(error);
        throw error;
      }
    });

    const verdict = await judge(request);
    if (!verdict.ok) {
      return {
        ok: false,
        error: {
          error: verdict.error,
          ...(measured.usage === undefined ? {} : { usage: measured.usage }),
          ...(cause.detail === undefined ? {} : { detail: cause.detail }),
        },
      };
    }

    const usage = measured.usage;
    if (usage === undefined) return { ok: false, error: { error: "unavailable" } };

    return { ok: true, value: { verdict: verdict.value.verdict, reason: verdict.value.reason, usage } };
  };
}

// The wiring of the gate of the bank, shared by the two surfaces that can run one (M1c, S10).
//
// A gate of the bank spends the model twice -- one call to replay the cases of the two arms, one to judge what the candidate
// answered (OA5) -- so the surface that runs it builds three things that only make sense together: the request, which adds the
// bank the user wrote and the identity of the session model to the candidate both bases are pointed at; the seams, which add
// the judge to the ones the surface was handed; and the judge itself, which is the second condition over the call above. A
// request without the judge is a gate the flow refuses to run, and a modification of the judge that landed in one surface and
// not in the other would spend a different call for the same decision, which is why they are built here and not twice.
//
// The two surfaces keep what is theirs: the command throws the refusal of a session without a model and the tool returns it as
// a failure with its own vocabulary. The refusal itself is a value, because a session with no model is a fact of the run and
// not an exception of this module.
export interface DirectionalGateContext {
  // The model of the session, already resolved: this module never picks one (see createModelCall above).
  readonly model: Model<Api> | undefined;
  readonly modelRegistry: ModelCallRegistry;
}

export interface DirectionalGateInput {
  context: DirectionalGateContext;
  // The identifier of the session the judge's call belongs to, read once by the surface that has the session manager.
  sessionId: string;
  // The candidate, named the way both bases name it: this function adds the two facts only the bank base has.
  request: GateRequest;
  // The bank that measures this run. A defect names a bank and is measured by the replay base instead (OA11), so the surface
  // decides which flow runs and this function wires the one it was pointed at.
  bankPath: string;
  // The seams the surface already had, passed through untouched; the judge is the one field this function owns.
  gateDeps?: GateDeps;
}

// What the flow of the bank is called with, once the wiring exists.
export interface DirectionalGateRun {
  request: DirectionalGateRequest;
  deps: DirectionalGateDeps;
}

// The wiring, or the one reason it does not exist: a session without a model cannot gate a bank at all.
export type DirectionalGateRunResult = Result<DirectionalGateRun, "no-model">;

export function wireDirectionalGate(input: DirectionalGateInput): DirectionalGateRunResult {
  const model = input.context.model;
  // OA5 read the other way: a model this package cannot identify is no model at all, because every run and the judge itself
  // pin the "provider/model" the record keeps.
  const identity = model === undefined ? undefined : modelIdentity(model.provider, model.id);
  if (model === undefined || identity === undefined) return { ok: false, error: "no-model" };

  return {
    ok: true,
    value: {
      request: { ...input.request, bankPath: input.bankPath, model: identity },
      deps: {
        ...input.gateDeps,
        judge: createDirectionalJudge(
          createModelCall({ registry: input.context.modelRegistry, model, sessionId: input.sessionId }),
        ),
      },
    },
  };
}
