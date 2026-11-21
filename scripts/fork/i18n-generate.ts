#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-shot generator; synchronous Node APIs keep it small.
// Fork: writes the web app's fork-only strings to apps/web/src/i18n/fork/[locale].json, which
// load on top of upstream's catalogs, so upstream's catalog files never carry fork keys.
// Run after wrapping fork copy: `vp run i18n:generate:fork`, then translate new keys.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type Catalog = Record<string, unknown>;
const readJson = (file: string): Catalog => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const writeJson = (file: string, catalog: Catalog) =>
  NodeFS.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);

const appDir = NodePath.resolve(import.meta.dirname, "../../apps/web");
const config = readJson(NodePath.join(appDir, "gt.config.json")) as {
  defaultLocale: string;
  locales: string[];
  files: { gt: { output: string } };
};
const upstreamDir = NodePath.join(appDir, NodePath.dirname(config.files.gt.output));
const forkDir = NodePath.join(appDir, "src/i18n/fork");

// Same scan as `vp run i18n:generate`, written to a temp dir so upstream's catalogs stay as they are.
const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-i18n-"));
let generated: Catalog;
try {
  const tmpConfig = NodePath.join(tmp, "gt.config.json");
  NodeFS.writeFileSync(
    tmpConfig,
    JSON.stringify({ ...config, locales: [], files: { gt: { output: `${tmp}/[locale].json` } } }),
  );
  // One command string: Windows runs the .bin shim through a shell.
  const gt = NodeChildProcess.spawnSync(`gt generate --config ${JSON.stringify(tmpConfig)}`, {
    cwd: appDir,
    encoding: "utf8",
    shell: true,
    env: {
      ...process.env,
      PATH: `${NodePath.join(appDir, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH}`,
    },
  });
  if (gt.status !== 0) throw new Error(`gt generate failed\n${gt.stdout}${gt.stderr}`);
  generated = readJson(NodePath.join(tmp, `${config.defaultLocale}.json`));
} finally {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
}

const upstream = readJson(NodePath.join(upstreamDir, `${config.defaultLocale}.json`));
const source = Object.fromEntries(Object.entries(generated).filter(([key]) => !(key in upstream)));
NodeFS.mkdirSync(forkDir, { recursive: true });
writeJson(NodePath.join(forkDir, `${config.defaultLocale}.json`), source);

for (const locale of config.locales) {
  const file = NodePath.join(forkDir, `${locale}.json`);
  const existing = NodeFS.existsSync(file) ? readJson(file) : {};
  // Like `gt generate`: a new key starts as English, a dropped key goes.
  writeJson(
    file,
    Object.fromEntries(Object.entries(source).map(([key, text]) => [key, existing[key] ?? text])),
  );
}
console.log(
  `${Object.keys(source).length} fork strings in ${NodePath.relative(process.cwd(), forkDir)}.`,
);
