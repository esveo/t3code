import { ESVEO_NOTION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

/** Fork: the Notion page viewer's calls; the environment's server does every Notion request. */
export const esveoNotionEnvironment = {
  status: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:esveo-notion:status",
    tag: ESVEO_NOTION_WS_METHODS.status,
  }),
  connect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:esveo-notion:connect",
    tag: ESVEO_NOTION_WS_METHODS.connect,
  }),
  disconnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:esveo-notion:disconnect",
    tag: ESVEO_NOTION_WS_METHODS.disconnect,
  }),
  page: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:esveo-notion:page",
    tag: ESVEO_NOTION_WS_METHODS.page,
  }),
  pageRefs: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:esveo-notion:page-refs",
    tag: ESVEO_NOTION_WS_METHODS.pageRefs,
  }),
  fileUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:esveo-notion:file-url",
    tag: ESVEO_NOTION_WS_METHODS.fileUrl,
  }),
};
