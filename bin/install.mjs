#!/usr/bin/env node
/**
 * Instalador do skill-state nos hosts (global) e genesis-prep (projeto).
 * Zero deps. Idempotente. Não apaga hooks existentes.
 *
 *   node bin/cli.mjs install --global
 *   node bin/cli.mjs install --project [--domain dev|ops|pesquisa]
 *   node bin/cli.mjs install --global --project
 */
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_REL = "skill-state/bin/cli.mjs";
const CMD = (sub) => `node "$HOME/.claude/skills/${CLI_REL}" ${sub}`;
const MARCA = "skill-state/bin/cli.mjs";

const grupo = (matcher, sub) => ({
  matcher,
  hooks: [{ type: "command", command: CMD(sub), timeout: 15 }],
});

const flag = (argv, nome) => {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : undefined;
};
const tem = (argv, nome) => argv.includes(nome);

function log(msg) {
  console.log(msg);
}

function garantirDir(p) {
  mkdirSync(p, { recursive: true });
}

function garantirSymlink(link, alvo) {
  garantirDir(dirname(link));
  const dest = resolve(alvo);
  const st = lstatSync(link, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() || st?.isDirectory() || st?.isFile()) {
    try {
      if (realpathSync(link) === realpathSync(dest)) return "já";
    } catch {
      /* link quebrado: substitui */
    }
    if (st.isSymbolicLink()) unlinkSync(link);
    else return `SKIP ${link} existe e não é symlink para o kit`;
  }
  symlinkSync(dest, link);
  return "criado";
}

function backup(arquivo, home) {
  if (!existsSync(arquivo)) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const dir = join(home, ".skill-state-host-install-backup", stamp);
  garantirDir(dir);
  copyFileSync(arquivo, join(dir, arquivo.split("/").pop()));
}

function lerJson(caminho, fallback) {
  if (!existsSync(caminho)) return fallback;
  return JSON.parse(readFileSync(caminho, "utf8"));
}

function gravarJson(caminho, obj) {
  garantirDir(dirname(caminho));
  const tmp = `${caminho}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, caminho);
}

function temMarca(obj) {
  return JSON.stringify(obj ?? {}).includes(MARCA);
}

function mesclarHooks(doc, arquivo, home) {
  const hooks = (doc.hooks ??= {});
  let mudou = false;
  const ss = (hooks.SessionStart ??= []);
  if (!temMarca(ss)) {
    ss.push(grupo("startup|resume|compact", "context"));
    mudou = true;
  }
  const pc = (hooks.PreCompact ??= []);
  if (!temMarca(pc)) {
    pc.push(grupo("auto|manual", "flush-check"));
    mudou = true;
  }
  if (mudou) {
    backup(arquivo, home);
    gravarJson(arquivo, doc);
    return "ligado";
  }
  return "já";
}

function instalarClaude(home) {
  const raiz = join(home, ".claude");
  if (!existsSync(raiz)) garantirDir(raiz);
  const skill = garantirSymlink(join(raiz, "skills", "skill-state"), KIT);
  const settings = join(raiz, "settings.json");
  const doc = lerJson(settings, { hooks: {} });
  const hooks = mesclarHooks(doc, settings, home);
  return `skill=${skill} hooks=${hooks}`;
}

function instalarCodex(home) {
  const raiz = join(home, ".codex");
  if (!existsSync(raiz)) return "pulado (sem ~/.codex)";
  const skill = garantirSymlink(join(raiz, "skills", "skill-state"), KIT);
  const arquivo = join(raiz, "hooks.json");
  const doc = lerJson(arquivo, { hooks: {} });
  const hooks = mesclarHooks(doc, arquivo, home);
  return `skill=${skill} hooks=${hooks} — confie as entradas novas em /hooks`;
}

function instalarGrok(home) {
  const raiz = join(home, ".grok");
  if (!existsSync(raiz)) return "pulado (sem ~/.grok)";
  const skill = garantirSymlink(join(raiz, "skills", "skill-state"), KIT);
  const arquivo = join(raiz, "hooks", "skill-state.json");
  if (existsSync(arquivo) && temMarca(lerJson(arquivo, {}))) {
    return `skill=${skill} hooks=já`;
  }
  garantirDir(dirname(arquivo));
  gravarJson(arquivo, {
    hooks: {
      SessionStart: [grupo("startup|resume|compact", "context")],
      PreCompact: [grupo("auto|manual", "flush-check")],
    },
  });
  return `skill=${skill} hooks=ligado`;
}

function instalarOpenCode(home) {
  const skillRoot = join(home, ".opencode");
  const cfgRoot = join(home, ".config", "opencode");
  if (!existsSync(skillRoot) && !existsSync(cfgRoot)) return "pulado (sem OpenCode)";
  const partes = [];
  if (existsSync(skillRoot) || existsSync(cfgRoot)) {
    garantirDir(join(skillRoot, "skills"));
    partes.push(`skill=${garantirSymlink(join(skillRoot, "skills", "skill-state"), KIT)}`);
  }
  if (existsSync(cfgRoot)) {
    const cfg = join(cfgRoot, "opencode.json");
    if (existsSync(cfg)) {
      const doc = lerJson(cfg, {});
      const skillPerm = ((doc.permission ??= {}).skill ??= {});
      if (skillPerm["skill-state"] !== "allow") {
        backup(cfg, home);
        skillPerm["skill-state"] = "allow";
        gravarJson(cfg, doc);
        partes.push("allow=ligado");
      } else partes.push("allow=já");
    }
    const pluginSrc = join(KIT, "templates", "hosts", "opencode-plugin.js");
    const pluginDst = join(cfgRoot, "plugins", "skill-state.js");
    garantirDir(dirname(pluginDst));
    if (!existsSync(pluginDst)) {
      copyFileSync(pluginSrc, pluginDst);
      partes.push("plugin=criado");
    } else partes.push("plugin=já");
  }
  return partes.join(" ") || "pulado";
}

function instalarPhi(home) {
  const raiz = join(home, ".phi", "agent");
  if (!existsSync(raiz)) return "pulado (sem ~/.phi/agent)";
  const skill = garantirSymlink(join(raiz, "skills", "skill-state"), KIT);
  const dst = join(raiz, "extensions", "skill-state.ts");
  garantirDir(dirname(dst));
  if (!existsSync(dst)) {
    copyFileSync(join(KIT, "templates", "hosts", "phi-extension.ts"), dst);
    return `skill=${skill} extension=criado`;
  }
  return `skill=${skill} extension=já`;
}

function instalarGlobal(home) {
  log(`kit: ${KIT}`);
  log(`claude: ${instalarClaude(home)}`);
  log(`codex:  ${instalarCodex(home)}`);
  log(`grok:   ${instalarGrok(home)}`);
  log(`opencode: ${instalarOpenCode(home)}`);
  log(`phi:    ${instalarPhi(home)}`);
  log("sem .skill-state/STATE.json no projeto os hooks saem em silêncio.");
  log("próximo: cd <repo> && node bin/cli.mjs install --project");
}

function instalarProjeto(argv) {
  const cli = join(KIT, "bin", "cli.mjs");
  const extra = [];
  const domain = flag(argv, "--domain");
  const dir = flag(argv, "--dir");
  if (domain) extra.push("--domain", domain);
  if (dir) extra.push("--dir", dir);
  const out = execFileSync(process.execPath, [cli, "init", ...extra], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(out);
}

export async function main(argv) {
  const global = tem(argv, "--global");
  const project = tem(argv, "--project");
  if (!global && !project) {
    console.error("uso: cli.mjs install --global|--project [--domain dev|ops|pesquisa] [--dir <pasta>] [--home <dir>]");
    return 2;
  }
  const home = resolve(flag(argv, "--home") ?? homedir());
  if (global) instalarGlobal(home);
  if (project) instalarProjeto(argv);
  return 0;
}

const este = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === este) {
  process.exit(await main(process.argv.slice(2)));
}
