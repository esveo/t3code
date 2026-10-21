import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  clientRpcRequiredScopes,
  FORK_INSTRUCTIONS_WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";

it("reads instruction files with filesystem read and saves them with filesystem write", () => {
  expect(requiredScopeForRpcMethod(FORK_INSTRUCTIONS_WS_METHODS.read)).toBe(
    AuthFilesystemReadScope,
  );
  expect(requiredScopeForRpcMethod(FORK_INSTRUCTIONS_WS_METHODS.write)).toBe(
    AuthFilesystemWriteScope,
  );
  // The client checks the write too, so the Save button can follow the grant.
  expect(clientRpcRequiredScopes(FORK_INSTRUCTIONS_WS_METHODS.write, undefined)).toEqual([
    AuthFilesystemWriteScope,
  ]);
});
