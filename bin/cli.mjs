#!/usr/bin/env node
/**
 * CLI do protocolo skill-state — runtime determinístico de Σ (estado) + ΔΣ (patches).
 * Kit portátil: zero dependências npm; requer Node ≥ 20 (WebCrypto global).
 *
 * Subcomandos:
 *   init         → cria o diretório de estado + STATE.schema.json (--domain dev|ops|pesquisa)
 *   context      → injeta Σ resumido (qualquer host no resume; Claude Code via SessionStart)
 *   flush-check  → aviso best-effort p/ PreCompact (Σ possivelmente não flushado)
 *   validate     → valida um patch SEM aplicar (--patch <arquivo>)
 *   apply        → valida e aplica atômico (--patch <arquivo> [--dry-run])
 *   verify       → cadeia de hash íntegra + replay == STATE.json + staleness vs ref base
 *   archive      → recorta o prefixo do log (--keep N, default 50) se verify verde
 *   install      → liga skill+hooks nos hosts (--global) e/ou init no projeto (--project)
 *   selftest     → roda os fixtures dourados (contrato do protocolo)
 *
 * Configuração (todas opcionais):
 *   --dir <pasta>            diretório com STATE.json/STATE.schema.json/patches.jsonl
 *   --domain <dev|ops|pesquisa>  schema do init (default: dev)
 *   SKILL_STATE_DIR          idem, via ambiente (default: .skill-state)
 *   CLAUDE_PROJECT_DIR       raiz do projeto (default: diretório de trabalho atual)
 *   SKILL_STATE_BASE_REF     ref git p/ staleness (default: origin/main)
 */
import {
  readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, statSync, mkdirSync, copyFileSync,
  openSync, closeSync, unlinkSync, fsyncSync, writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { aplicarMergePatch, contarDelecoes } from "./merge.mjs";
import { validarContraSchema, validarRegrasDoProtocolo } from "./schema.mjs";
import { GENESIS_HASH, encadear, verificarCadeia } from "./chain.mjs";
import { rodarSelftest } from "./selftest.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url)); // .../skill-state/bin
const RAIZ = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const REF_BASE = process.env.SKILL_STATE_BASE_REF ?? "origin/main";
// Caminho deste CLI como o usuário deve invocá-lo: relativo à raiz do projeto quando instalado
// nela; absoluto quando instalado globalmente (~/.claude/skills) — as mensagens ficam corretas
// nos dois modos de instalação.
const doProjeto = (absoluto) => {
  const rel = relative(RAIZ, absoluto);
  return rel.startsWith("..") || isAbsolute(rel) ? absoluto : rel;
};
const CLI_CANONICO = doProjeto(join(AQUI, "cli.mjs"));
const SKILL_CANONICA = doProjeto(join(AQUI, "..", "SKILL.md"));
const args = process.argv.slice(2);
const comando = args[0];
const flag = (nome) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
};
const dirRelativo = flag("--dir") ?? process.env.SKILL_STATE_DIR ?? ".skill-state";
const dir = join(RAIZ, dirRelativo);
const caminhos = {
  estado: join(dir, "STATE.json"),
  schema: join(dir, "STATE.schema.json"),
  log: join(dir, "patches.jsonl"),
  journal: join(dir, "apply.journal"),
  lock: join(dir, "apply.lock"),
  archiveMeta: join(dir, "archive.meta.json"),
  archiveDir: join(dir, "archive"),
};

const lerJson = (caminho) => JSON.parse(readFileSync(caminho, "utf8"));
const lerLog = () =>
  existsSync(caminhos.log)
    ? readFileSync(caminhos.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/** Pipeline validate: parse → base_seq → seq contíguo → envelope fechado → ⊕ dry-run → schema no RESULTADO → regras do protocolo. */
function validarPatch(estado, schema, envelope) {
  const issues = [];
  const seqAtual = estado?.meta?.patch_seq ?? 0;
  if (envelope?.base_seq !== seqAtual) {
    issues.push({
      path: "$.base_seq",
      code: "stale-base",
      message: `base_seq=${envelope?.base_seq} mas o estado está em patch_seq=${seqAtual} — releia Σ e re-proponha`,
    });
    return { issues, resultado: null };
  }
  for (const campo of ["seq", "autor", "quando", "motivo", "delta"]) {
    if (envelope[campo] === undefined) {
      issues.push({ path: `$.${campo}`, code: "malformed", message: "campo obrigatório do envelope ausente" });
    }
  }
  if (issues.length > 0) return { issues, resultado: null };
  if (!Number.isInteger(envelope.seq) || envelope.seq !== seqAtual + 1) {
    issues.push({
      path: "$.seq",
      code: "invalid-seq",
      message: `seq=${envelope.seq} mas o próximo é ${seqAtual + 1} — seq deve ser exatamente patch_seq+1`,
    });
    return { issues, resultado: null };
  }
  const CHAVES_ENVELOPE = new Set(["seq", "base_seq", "autor", "quando", "motivo", "delta"]);
  for (const chave of Object.keys(envelope)) {
    if (!CHAVES_ENVELOPE.has(chave)) {
      issues.push({
        path: `$.${chave}`,
        code: "unknown-key",
        message: "chave desconhecida no envelope",
      });
    }
  }
  if (issues.length > 0) return { issues, resultado: null };
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
  if (typeof envelope.quando !== "string" || !ISO_UTC.test(envelope.quando) || !Number.isFinite(Date.parse(envelope.quando))) {
    issues.push({
      path: "$.quando",
      code: "malformed",
      message: "quando deve ser ISO-8601 UTC (ex.: 2026-08-30T00:10:00Z)",
    });
    return { issues, resultado: null };
  }
  for (const campo of ["autor", "motivo"]) {
    if (typeof envelope[campo] !== "string" || envelope[campo].trim() === "") {
      issues.push({
        path: `$.${campo}`,
        code: "malformed",
        message: `${campo} deve ser string não-vazia`,
      });
    }
  }
  if (issues.length > 0) return { issues, resultado: null };
  const alias = reescreverAliases(envelope.delta, "$.delta");
  issues.push(...alias.issues);
  if (issues.length > 0) return { issues, resultado: null };
  envelope = { ...envelope, delta: alias.delta };
  issues.push(...validarRegrasDoProtocolo(null, envelope.delta).filter(
    // no bootstrap (seq 0→1) o delta PRECISA criar spec/schema_version; meta segue proibida
    (p) => seqAtual !== 0 || p.path === "$.meta",
  ));
  if (issues.length > 0) return { issues, resultado: null };
  const resultado = aplicarMergePatch(estado ?? {}, envelope.delta);
  resultado.meta = estado?.meta ?? { patch_seq: 0, ultimo_hash: GENESIS_HASH, atualizado_em: envelope.quando };
  issues.push(...validarContraSchema(resultado, schema));
  issues.push(...validarRegrasDoProtocolo(resultado, {}));
  if (issues.length === 0) issues.push(...validarLargeReplace(estado, resultado, envelope));
  return { issues, resultado: issues.length === 0 ? resultado : null, envelope };
}

const ALIASES_EN = {
  next_step: "proximo_passo",
  pending_items: "pendencias",
  blockers: "bloqueios",
  operational_warnings: "avisos_operacionais",
  verified_at: "verificado_em",
  incidents: "incidentes",
  hypotheses: "hipoteses",
};

/** Expande aliases EN no delta para chaves canônicas; não traduz Σ já gravado. */
function reescreverAliases(delta, caminho) {
  const issues = [];
  const walk = (obj, path) => {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
    const saida = {};
    for (const [chave, valor] of Object.entries(obj)) {
      const canon = ALIASES_EN[chave] ?? chave;
      if (canon !== chave && Object.hasOwn(obj, canon)) {
        issues.push({ path: `${path}.${chave}`, code: "malformed", message: `alias ${chave} colide com ${canon}` });
        continue;
      }
      if (Object.hasOwn(saida, canon) && canon !== chave) {
        issues.push({ path: `${path}.${chave}`, code: "malformed", message: `alias ${chave} colide com ${canon}` });
        continue;
      }
      saida[canon] = walk(valor, `${path}.${canon}`);
    }
    return saida;
  };
  return { delta: walk(delta, caminho), issues };
}

const LISTAS_PROTEGIDAS = [
  ["intencao", "pendencias"],
  ["intencao", "bloqueios"],
  ["intencao", "avisos_operacionais"],
  ["derivado_de_github", "fases"],
];

/** Substituição atômica que apaga >3 itens exige `confirma-lista` no motivo. */
function validarLargeReplace(estado, resultado, envelope) {
  if (typeof envelope.motivo === "string" && envelope.motivo.includes("confirma-lista")) return [];
  const issues = [];
  const delta = envelope.delta;
  for (const [zona, chave] of LISTAS_PROTEGIDAS) {
    if (!Array.isArray(delta?.[zona]?.[chave])) continue;
    const antes = Array.isArray(estado?.[zona]?.[chave]) ? estado[zona][chave].length : 0;
    const depois = Array.isArray(resultado?.[zona]?.[chave]) ? resultado[zona][chave].length : 0;
    if (antes - depois > 3) {
      issues.push({
        path: `$.${zona}.${chave}`,
        code: "large-replace",
        message: `lista perdeu ${antes - depois} itens (>3) — inclua confirma-lista no motivo para confirmar`,
      });
    }
  }
  return issues;
}

function pidVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Lock exclusivo no dir de estado. Processo morto libera (PID no arquivo). */
function adquirirLock() {
  mkdirSync(dir, { recursive: true });
  const inicio = Date.now();
  while (Date.now() - inicio < 10000) {
    try {
      const fd = openSync(caminhos.lock, "wx");
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
      return fd;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = NaN;
      try {
        pid = Number.parseInt(readFileSync(caminhos.lock, "utf8").trim(), 10);
      } catch {
        pid = NaN;
      }
      if (!Number.isInteger(pid) || !pidVivo(pid)) {
        try { unlinkSync(caminhos.lock); } catch { /* corrida */ }
        continue;
      }
      dormir(40);
    }
  }
  return null;
}

function soltarLock(fd) {
  if (fd !== null && fd !== undefined) {
    try { closeSync(fd); } catch { /* já fechado */ }
  }
  try { unlinkSync(caminhos.lock); } catch { /* já sumiu */ }
}

function gravarFsync(caminho, texto) {
  const tmp = `${caminho}.tmp`;
  const fd = openSync(tmp, "w");
  writeSync(fd, texto);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, caminho);
}

function appendFsync(caminho, texto) {
  appendFileSync(caminho, texto);
  const fd = openSync(caminho, "r+");
  fsyncSync(fd);
  closeSync(fd);
}

function completarJournal() {
  if (!existsSync(caminhos.journal)) return;
  let jornal;
  try {
    jornal = JSON.parse(readFileSync(caminhos.journal, "utf8"));
  } catch {
    throw new Error("journal inválido");
  }
  if (!jornal?.estado?.meta || !jornal?.elo?.hash) throw new Error("journal inválido");
  gravarFsync(caminhos.estado, `${JSON.stringify(jornal.estado, null, 2)}\n`);
  const elos = lerLog();
  if (!elos.some((e) => e.hash === jornal.elo.hash)) {
    appendFsync(caminhos.log, `${JSON.stringify(jornal.elo)}\n`);
  }
  unlinkSync(caminhos.journal);
}

async function aplicar({ dryRun }) {
  const arquivoPatch = flag("--patch");
  if (!arquivoPatch) return falha([{ path: "$", code: "malformed", message: "faltou --patch <arquivo>" }]);
  let envelope;
  try {
    envelope = arquivoPatch === "-"
      ? JSON.parse(readFileSync(0, "utf8"))
      : lerJson(arquivoPatch);
  } catch (e) {
    return falha([{ path: "$", code: "malformed", message: `JSON inválido: ${e.message}` }]);
  }
  if (!existsSync(caminhos.schema)) {
    return falha([{ path: "$", code: "schema-error", message: `sem ${caminhos.schema} — rode '${CLI_CANONICO} init' primeiro` }]);
  }
  if (dryRun) {
    const estado = existsSync(caminhos.estado) ? lerJson(caminhos.estado) : null;
    const schema = lerJson(caminhos.schema);
    const { issues, resultado } = validarPatch(estado, schema, envelope);
    if (issues.length > 0) return falha(issues);
    console.log(JSON.stringify({ ok: true, dry_run: true, delecoes: contarDelecoes(envelope.delta) }));
    return 0;
  }
  const fd = adquirirLock();
  if (fd === null) {
    return falha([{ path: "$", code: "locked", message: "dir de estado ocupado — outro apply em curso; tente de novo" }]);
  }
  try {
    try {
      completarJournal();
    } catch (e) {
      return falha([{ path: "$", code: "journal-error", message: e.message }]);
    }
    const estado = existsSync(caminhos.estado) ? lerJson(caminhos.estado) : null;
    const schema = lerJson(caminhos.schema);
    const { issues, resultado, envelope: envCanon } = validarPatch(estado, schema, envelope);
    if (issues.length > 0) return falha(issues);
    const env = envCanon ?? envelope;
    const elo = await encadear(estado?.meta?.ultimo_hash ?? GENESIS_HASH, env);
    resultado.meta = { patch_seq: env.seq, ultimo_hash: elo.hash, atualizado_em: env.quando };
    gravarFsync(caminhos.journal, `${JSON.stringify({ estado: resultado, elo })}\n`);
    gravarFsync(caminhos.estado, `${JSON.stringify(resultado, null, 2)}\n`);
    appendFsync(caminhos.log, `${JSON.stringify(elo)}\n`);
    unlinkSync(caminhos.journal);
    console.log(JSON.stringify({ ok: true, seq: envelope.seq, hash: elo.hash }));
    return 0;
  } finally {
    soltarLock(fd);
  }
}

function falha(issues) {
  console.log(JSON.stringify({ ok: false, issues }));
  return 1;
}

function shaRefBase() {
  try {
    return execFileSync("git", ["rev-parse", REF_BASE], {
      cwd: RAIZ,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // sem git/sem ref não é erro — não polua o stderr
    }).trim();
  } catch {
    return null; // sem git/sem a ref — staleness fica indeterminada, não é erro
  }
}

function lerArquivo() {
  if (!existsSync(caminhos.archiveMeta)) {
    return { ate_seq: 0, hash_continuidade: GENESIS_HASH, snapshot: {} };
  }
  return lerJson(caminhos.archiveMeta);
}

async function avaliarIntegridade() {
  const arq = lerArquivo();
  const elos = lerLog();
  const cadeia = await verificarCadeia(elos, arq.hash_continuidade);
  const estado = existsSync(caminhos.estado) ? lerJson(caminhos.estado) : null;
  let replayOk = false;
  if (estado && cadeia.ok) {
    let sigma = structuredClone(arq.snapshot);
    for (const elo of elos) sigma = aplicarMergePatch(sigma, elo.envelope.delta);
    const { meta: _ignorada, ...semMeta } = estado;
    replayOk =
      JSON.stringify(sigma) === JSON.stringify(semMeta) &&
      estado.meta.patch_seq === arq.ate_seq + elos.length &&
      estado.meta.ultimo_hash === (elos.at(-1)?.hash ?? arq.hash_continuidade);
  }
  const shaRemoto = shaRefBase();
  const shaEstado = estado?.derivado_de_github?.main_sha ?? null;
  const stale = shaRemoto !== null && shaEstado !== null ? shaRemoto !== shaEstado : null;
  const ok = cadeia.ok && replayOk;
  return { ok, cadeia, replay_ok: replayOk, stale, ref_base: REF_BASE, main_sha_estado: shaEstado, main_sha_ref: shaRemoto };
}

async function verificar() {
  const fd = adquirirLock();
  if (fd === null) {
    console.log(JSON.stringify({ ok: false, cadeia: { ok: false }, replay_ok: false, stale: null, locked: true }));
    return 1;
  }
  try {
    try {
      completarJournal();
    } catch (e) {
      console.log(JSON.stringify({ ok: false, cadeia: { ok: false }, replay_ok: false, stale: null, journal_error: e.message }));
      return 1;
    }
    const r = await avaliarIntegridade();
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  } finally {
    soltarLock(fd);
  }
}

async function arquivar() {
  const keepBruto = flag("--keep") ?? "50";
  const keep = Number(keepBruto);
  if (!Number.isInteger(keep) || keep < 1) {
    return falha([{ path: "$", code: "malformed", message: "--keep deve ser inteiro ≥ 1 (default 50)" }]);
  }
  const fd = adquirirLock();
  if (fd === null) {
    return falha([{ path: "$", code: "locked", message: "dir de estado ocupado — outro apply em curso; tente de novo" }]);
  }
  try {
    try {
      completarJournal();
    } catch (e) {
      return falha([{ path: "$", code: "journal-error", message: e.message }]);
    }
    const integridade = await avaliarIntegridade();
    if (!integridade.ok) {
      return falha([{ path: "$", code: "verify-failed", message: "archive exige verify verde — nada foi tocado" }]);
    }
    const elos = lerLog();
    if (elos.length <= keep) {
      return falha([{ path: "$", code: "nada-a-arquivar", message: `log tem ${elos.length} elo(s); --keep ${keep} não recorta nada` }]);
    }
    const prefixo = elos.slice(0, elos.length - keep);
    const resto = elos.slice(elos.length - keep);
    const arq = lerArquivo();
    let snapshot = structuredClone(arq.snapshot);
    for (const elo of prefixo) snapshot = aplicarMergePatch(snapshot, elo.envelope.delta);
    const meta = {
      ate_seq: arq.ate_seq + prefixo.length,
      hash_continuidade: prefixo.at(-1).hash,
      snapshot,
    };
    mkdirSync(caminhos.archiveDir, { recursive: true });
    const artefato = join(caminhos.archiveDir, `prefix-${meta.ate_seq}.jsonl`);
    gravarFsync(artefato, `${prefixo.map((e) => JSON.stringify(e)).join("\n")}\n`);
    gravarFsync(caminhos.archiveMeta, `${JSON.stringify(meta, null, 2)}\n`);
    gravarFsync(caminhos.log, `${resto.map((e) => JSON.stringify(e)).join("\n")}\n`);
    console.log(JSON.stringify({ ok: true, arquivados: prefixo.length, keep, ate_seq: meta.ate_seq, artefato }));
    return 0;
  } finally {
    soltarLock(fd);
  }
}

function contexto() {
  if (!existsSync(caminhos.estado)) return 0; // sem Σ, sem contexto — silencioso por design
  const estado = lerJson(caminhos.estado);
  const shaRemoto = shaRefBase();
  const stale = shaRemoto !== null && estado.derivado_de_github?.main_sha !== shaRemoto;
  const linhas = [
    `skill-state Σ (${dirRelativo}/STATE.json, patch_seq=${estado.meta?.patch_seq}, atualizado ${estado.meta?.atualizado_em}):`,
    `PRÓXIMO PASSO: ${estado.intencao?.proximo_passo ?? "(vazio)"}`,
    ...(estado.intencao?.bloqueios ?? []).map((b) => `BLOQUEIO [${b.id}]: ${b.texto}`),
    ...(estado.intencao?.pendencias ?? []).slice(0, 5).map((p) => `pendência [${p.id}] (${p.dono}): ${p.texto}`),
    ...(estado.intencao?.avisos_operacionais ?? []).map((a) => `aviso: ${a}`),
    stale
      ? `⚠ derivado_de_github STALE (estado=${estado.derivado_de_github?.main_sha?.slice(0, 7)} ≠ ${REF_BASE}=${shaRemoto.slice(0, 7)}, verificado_em=${estado.derivado_de_github?.verificado_em}) — re-derive da fonte antes de confiar.`
      : `derivado_de_github verificado_em=${estado.derivado_de_github?.verificado_em}${shaRemoto === null ? " (staleness indeterminada — sem git)" : " (base ok)"}`,
    `Protocolo: ${SKILL_CANONICA} — mudou algo relevante? proponha ΔΣ via 'node ${CLI_CANONICO} apply --patch -'.`,
  ];
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: linhas.join("\n") } }));
  return 0;
}

function checarFlush() {
  if (!existsSync(caminhos.estado)) return 0;
  const idadeMin = Math.round((Date.now() - statSync(caminhos.estado).mtimeMs) / 60000);
  if (idadeMin > 30) {
    console.log(
      `skill-state: Σ não recebe patch há ${idadeMin}min e o contexto vai compactar — se algo relevante mudou (passo concluído, bloqueio, decisão), flush ΔΣ AGORA: node ${CLI_CANONICO} apply --patch <arquivo>`,
    );
  }
  return 0;
}

function iniciar() {
  const dominio = flag("--domain") ?? "dev";
  const arquivos = {
    dev: "STATE.schema.template.json",
    ops: "STATE.schema.ops.json",
    pesquisa: "STATE.schema.pesquisa.json",
  };
  if (!arquivos[dominio]) {
    console.error("uso: cli.mjs init [--domain dev|ops|pesquisa] [--dir <pasta>]");
    return 2;
  }
  mkdirSync(dir, { recursive: true });
  if (!existsSync(caminhos.schema)) {
    copyFileSync(join(AQUI, "..", "templates", arquivos[dominio]), caminhos.schema);
    console.log(`criado: ${caminhos.schema} (domínio ${dominio}; edite o schema antes do genesis, se quiser)`);
  } else {
    console.log(`já existe: ${caminhos.schema}`);
  }
  if (existsSync(caminhos.estado)) {
    console.log(`já existe: ${caminhos.estado} — nada a fazer (use apply para evoluir o estado)`);
    return 0;
  }
  const template = readFileSync(join(AQUI, "..", "templates", "genesis.template.json"), "utf8");
  console.log(
    `\nPróximo passo — preencha o genesis (template abaixo), salve num arquivo temporário e aplique:\n` +
      `  node ${CLI_CANONICO} apply --patch /tmp/genesis.json --dir ${dirRelativo}\n\n${template}`,
  );
  return 0;
}

const rotas = {
  init: () => iniciar(),
  context: () => contexto(),
  "flush-check": () => checarFlush(),
  validate: () => aplicar({ dryRun: true }),
  apply: () => aplicar({ dryRun: args.includes("--dry-run") }),
  verify: () => verificar(),
  archive: () => arquivar(),
  install: () => import("./install.mjs").then((m) => m.main(args.slice(1))),
  selftest: () => rodarSelftest({ validarPatch, dirFixtures: join(AQUI, "..", "fixtures") }),
};

if (!rotas[comando]) {
  console.error(`uso: cli.mjs <${Object.keys(rotas).join("|")}> [--dir <pasta>] [--patch <arquivo>|-] [--domain dev|ops|pesquisa] [--keep N] [--dry-run] [--global] [--project] [--home <dir>]`);
  process.exit(2);
}
process.exit(await rotas[comando]());
