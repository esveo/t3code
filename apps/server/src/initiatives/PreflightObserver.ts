/**
 * Fork: feeds the preflight from server start: every provider event (for
 * request.opened and request.resolved) and the user's approval clicks.
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { Initiatives } from "./Initiatives.ts";
import { requestOpenedOf } from "./Preflight.ts";

/** Listens to the provider stream and the user's approval clicks, from server start. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const initiatives = yield* Initiatives;
    const providerService = yield* ProviderService;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const preflight = initiatives.preflight;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const onRuntime = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        const opened = requestOpenedOf(event);
        if (opened) {
          yield* preflight.observeOpened(opened);
          return;
        }
        if (event.type === "request.resolved" && event.requestId) {
          const decision = event.payload.decision ?? null;
          yield* preflight.observeResolution({
            threadId: event.threadId,
            requestId: event.requestId,
            by: decision === null || decision === "cancel" ? "expired" : "provider-auto",
            decision,
            at: event.createdAt,
          });
        }
      }).pipe(Effect.ignoreCause({ log: true }));
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, onRuntime).pipe(
        Effect.ignoreCause({ log: true }),
      ),
    );
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.approval-response-requested"
          ? Effect.gen(function* () {
              yield* preflight.observeResolution({
                threadId: event.payload.threadId,
                requestId: event.payload.requestId,
                by: "person",
                decision: event.payload.decision,
                at: event.payload.createdAt ?? (yield* nowIso),
              });
            }).pipe(Effect.ignoreCause({ log: true }))
          : Effect.void,
      ).pipe(Effect.ignoreCause({ log: true })),
    );
  }),
);
