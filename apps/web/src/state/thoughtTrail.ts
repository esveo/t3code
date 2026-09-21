import { createThoughtTrailEnvironmentAtoms } from "@t3tools/client-runtime/state/thought-trail";

import { connectionAtomRuntime } from "../connection/runtime";

export const thoughtTrailEnvironment = createThoughtTrailEnvironmentAtoms(connectionAtomRuntime);
