import { INITIATIVES_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

/** Fork: initiatives. The server sends the full list or detail again on every change. */
export const initiativesEnvironment = {
  list: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:list",
    tag: INITIATIVES_WS_METHODS.subscribeList,
    idleTtlMs: 30_000,
  }),
  detail: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:detail",
    tag: INITIATIVES_WS_METHODS.subscribeDetail,
    idleTtlMs: 30_000,
  }),
  /** What waits on the user across every initiative. */
  inbox: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:inbox",
    tag: INITIATIVES_WS_METHODS.subscribeInbox,
    idleTtlMs: 30_000,
  }),
  /** A thread's approval requests with the preflight's verdicts, while one waits. */
  threadPreflight: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:thread-preflight",
    tag: INITIATIVES_WS_METHODS.subscribeThreadPreflight,
    idleTtlMs: 10_000,
  }),
  preflightReport: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:preflight-report",
    tag: INITIATIVES_WS_METHODS.preflightReport,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
  }),
  /** Earlier sessions per source and folder; reads local files, so only on request. */
  importCatalog: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:import-catalog",
    tag: INITIATIVES_WS_METHODS.importCatalog,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
  }),
  /** Reading usage scans transcripts on the server, so it is cached for minutes. */
  usage: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:usage",
    tag: INITIATIVES_WS_METHODS.usage,
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  }),
  /** One brain page with its history; refreshed when the page's last commit moves. */
  brainPage: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:brain-page",
    tag: INITIATIVES_WS_METHODS.brainRead,
    idleTtlMs: 60_000,
  }),
  /** Measured sessions beside their estimates, and the quota shares; refreshed on request. */
  statsReport: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:stats-report",
    tag: INITIATIVES_WS_METHODS.statsReport,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
  }),
  statsEstimate: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:initiatives:stats-estimate",
    tag: INITIATIVES_WS_METHODS.statsEstimate,
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 60_000,
  }),
  act: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:initiatives:act",
    tag: INITIATIVES_WS_METHODS.act,
  }),
};
