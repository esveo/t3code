/**
 * Fork: the ChatGPT login a voice call runs on is the Codex login of the
 * default Codex instance. It is read fresh for every call and never written:
 * Codex owns refreshing it.
 */
import {
  CodexSettings,
  ProviderInstanceId,
  type ServerSettings,
  type VoiceCallUnavailableReason,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import type { RealtimeAuth } from "./RealtimeCallClient.ts";

const CodexAuthFile = Schema.Struct({
  auth_mode: Schema.optional(Schema.NullOr(Schema.String)),
  tokens: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        access_token: Schema.optional(Schema.String),
        account_id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeCodexAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(CodexAuthFile));
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeCodexSettingsSync = Schema.decodeSync(CodexSettings);
const defaultCodexSettings = () => decodeCodexSettingsSync({});

/** A token about to expire would end the call mid-sentence; ask for a fresh login instead. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export type VoiceCallAuthResult =
  | { readonly _tag: "ready"; readonly auth: RealtimeAuth }
  | {
      readonly _tag: "unavailable";
      readonly availability: {
        readonly available: false;
        readonly reason: VoiceCallUnavailableReason;
        readonly message: string;
      };
    };

const unavailable = (reason: VoiceCallUnavailableReason, message: string): VoiceCallAuthResult => ({
  _tag: "unavailable",
  availability: { available: false, reason, message },
});

const jwtClaims = (token: string): unknown => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

export const jwtExpiresAtMs = (token: string): number | null => {
  const claims = jwtClaims(token);
  return typeof claims === "object" &&
    claims !== null &&
    "exp" in claims &&
    typeof claims.exp === "number"
    ? claims.exp * 1000
    : null;
};

const decodePlanClaims = Schema.decodeUnknownOption(
  Schema.Struct({
    "https://api.openai.com/auth": Schema.Struct({ chatgpt_plan_type: Schema.String }),
  }),
);

/** Only the plan claim leaves here, never a token. */
export const codexPlanTypeFromFile = (contents: string): string | null => {
  const file = Option.getOrNull(decodeCodexAuthFile(contents));
  const accessToken = file?.tokens?.access_token;
  if (file?.auth_mode !== "chatgpt" || !accessToken) return null;
  return Option.getOrNull(
    Option.map(
      decodePlanClaims(jwtClaims(accessToken)),
      (claims) => claims["https://api.openai.com/auth"].chatgpt_plan_type,
    ),
  );
};

export const codexAuthFromFile = (contents: string, nowMs: number): VoiceCallAuthResult => {
  const file = decodeCodexAuthFile(contents);
  if (Option.isNone(file)) {
    return unavailable(
      "codex-not-logged-in",
      "Log in to Codex with ChatGPT to start a voice call.",
    );
  }
  const accessToken = file.value.tokens?.access_token;
  const accountId = file.value.tokens?.account_id;
  if (file.value.auth_mode !== "chatgpt" || !accessToken || !accountId) {
    return unavailable(
      "codex-api-key",
      "Voice calls need Codex logged in with ChatGPT, not an API key.",
    );
  }
  const expiresAtMs = jwtExpiresAtMs(accessToken);
  if (expiresAtMs !== null && expiresAtMs - nowMs < EXPIRY_MARGIN_MS) {
    return unavailable(
      "codex-login-expired",
      "The Codex login has expired. Run a Codex turn or `codex login` to renew it.",
    );
  }
  return { _tag: "ready", auth: { accessToken, accountId } };
};

/** Follows how the Codex driver finds its home: instance setting, then CODEX_HOME, then ~/.codex. */
const codexAuthPath = Effect.fn("VoiceCallAuth.codexAuthPath")(function* (
  settings: ServerSettings,
) {
  const path = yield* Path.Path;
  const instance = settings.providerInstances[ProviderInstanceId.make("codex")];
  const config = Option.getOrElse(
    decodeCodexSettings(instance?.config ?? {}),
    defaultCodexSettings,
  );
  const environmentHome = (
    instance?.environment?.findLast((variable) => variable.name === "CODEX_HOME")?.value ??
    process.env.CODEX_HOME
  )?.trim();
  const layout = yield* resolveCodexHomeLayout(
    !config.homePath.trim() && !config.shadowHomePath.trim() && environmentHome
      ? { ...config, homePath: environmentHome }
      : config,
  );
  return path.join(layout.effectiveHomePath ?? layout.sharedHomePath, "auth.json");
});

/** Unlike the login itself, the plan is still worth showing once the token has expired. */
export const readVoiceCallPlanType = Effect.fn("VoiceCallAuth.readPlanType")(function* (
  settings: ServerSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(yield* codexAuthPath(settings)).pipe(Effect.option);
  return Option.isNone(contents) ? null : codexPlanTypeFromFile(contents.value);
});

export const readVoiceCallAuth = Effect.fn("VoiceCallAuth.read")(function* (
  settings: ServerSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const authPath = yield* codexAuthPath(settings);
  const contents = yield* fs.readFileString(authPath).pipe(Effect.option);
  if (Option.isNone(contents)) {
    return unavailable(
      "codex-not-logged-in",
      "Log in to Codex with ChatGPT to start a voice call.",
    );
  }
  return codexAuthFromFile(contents.value, yield* Clock.currentTimeMillis);
});
