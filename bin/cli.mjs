#!/usr/bin/env node
/**
 * CLI do protocolo skill-state — runtime determinístico de Σ (estado) + ΔΣ (patches).
 * Kit portátil: zero dependências npm; requer Node ≥ 20 (WebCrypto global).
 *
 * Subcomandos:
 *   init         → cria o diretório de estado + STATE.schema.json do template e imprime o genesis a preencher
 *   context      → emite hookSpecificOutput p/ SessionStart (injeta Σ resumido no contexto)
 *   flush-check  → aviso best-effort p/ PreCompact (Σ possivelmente não flushado)
 *   validate     → valida um patch SEM aplicar (--patch <arquivo>)
 *   apply        → valida e aplica atômico (--patch <arquivo> [--dry-run])
 *   verify       → cadeia de hash íntegra + replay == STATE.json + staleness vs ref base
 *   selftest     → roda os fixtures dourados (contrato do protocolo)
 *
 * Configuração (todas opcionais):
 *   --dir <pasta>            diretório com STATE.json/STATE.schema.json/patches.jsonl
 *   SKILL_STATE_DIR          idem, via ambiente (default: .skill-state)
 *   CLAUDE_PROJECT_DIR       raiz do projeto (default: diretório de trabalho atual)
 *   SKILL_STATE_BASE_REF     ref git p/ staleness (default: origin/main)
 */
import {
  readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, statSync, mkdirSync, copyFileSync,
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
};

const lerJson = (caminho) => JSON.parse(readFileSync(caminho, "utf8"));
const lerLog = () =>
  existsSync(caminhos.log)
    ? readFileSync(caminhos.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/** Pipeline validate: parse → base_seq → ⊕ dry-run → schema no RESULTADO → regras do protocolo. */
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
  issues.push(...validarRegrasDoProtocolo(null, envelope.delta).filter(
    // no bootstrap (seq 0→1) o delta PRECISA criar spec/schema_version; meta segue proibida
    (p) => seqAtual !== 0 || p.path === "$.meta",
  ));
  if (issues.length > 0) return { issues, resultado: null };
  const resultado = aplicarMergePatch(estado ?? {}, envelope.delta);
  resultado.meta = estado?.meta ?? { patch_seq: 0, ultimo_hash: GENESIS_HASH, atualizado_em: envelope.quando };
  issues.push(...validarContraSchema(resultado, schema));
  issues.push(...validarRegrasDoProtocolo(resultado, {}));
  return { issues, resultado: issues.length === 0 ? resultado : null };
}

async function aplicar({ dryRun }) {
  const arquivoPatch = flag("--patch");
  if (!arquivoPatch) return falha([{ path: "$", code: "malformed", message: "faltou --patch <arquivo>" }]);
  let envelope;
  try {
    envelope = lerJson(arquivoPatch);
  } catch (e) {
    return falha([{ path: "$", code: "malformed", message: `JSON inválido: ${e.message}` }]);
  }
  if (!existsSync(caminhos.schema)) {
    return falha([{ path: "$", code: "schema-error", message: `sem ${caminhos.schema} — rode '${CLI_CANONICO} init' primeiro` }]);
  }
  const estado = existsSync(caminhos.estado) ? lerJson(caminhos.estado) : null;
  const schema = lerJson(caminhos.schema);
  const { issues, resultado } = validarPatch(estado, schema, envelope);
  if (issues.length > 0) return falha(issues);
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dry_run: true, delecoes: contarDelecoes(envelope.delta) }));
    return 0;
  }
  const elo = await encadear(estado?.meta?.ultimo_hash ?? GENESIS_HASH, envelope);
  resultado.meta = { patch_seq: envelope.seq, ultimo_hash: elo.hash, atualizado_em: envelope.quando };
  const temp = `${caminhos.estado}.tmp`;
  writeFileSync(temp, `${JSON.stringify(resultado, null, 2)}\n`);
  appendFileSync(caminhos.log, `${JSON.stringify(elo)}\n`);
  renameSync(temp, caminhos.estado); // atômico: o log ganha o elo antes de o snapshot trocar
  console.log(JSON.stringify({ ok: true, seq: envelope.seq, hash: elo.hash }));
  return 0;
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

async function verificar() {
  const elos = lerLog();
  const cadeia = await verificarCadeia(elos);
  const estado = existsSync(caminhos.estado) ? lerJson(caminhos.estado) : null;
  let replayOk = false;
  if (estado && cadeia.ok) {
    let sigma = {};
    for (const elo of elos) sigma = aplicarMergePatch(sigma, elo.envelope.delta);
    const { meta: _ignorada, ...semMeta } = estado;
    replayOk =
      JSON.stringify(sigma) === JSON.stringify(semMeta) &&
      estado.meta.patch_seq === elos.length &&
      estado.meta.ultimo_hash === (elos.at(-1)?.hash ?? GENESIS_HASH);
  }
  const shaRemoto = shaRefBase();
  const shaEstado = estado?.derivado_de_github?.main_sha ?? null;
  const stale = shaRemoto !== null && shaEstado !== null ? shaRemoto !== shaEstado : null;
  const ok = cadeia.ok && replayOk;
  console.log(JSON.stringify({ ok, cadeia, replay_ok: replayOk, stale, ref_base: REF_BASE, main_sha_estado: shaEstado, main_sha_ref: shaRemoto }));
  return ok ? 0 : 1;
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
    `Protocolo: ${SKILL_CANONICA} — mudou algo relevante? proponha ΔΣ via 'node ${CLI_CANONICO} apply --patch <arquivo>'.`,
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
  mkdirSync(dir, { recursive: true });
  if (!existsSync(caminhos.schema)) {
    copyFileSync(join(AQUI, "..", "templates", "STATE.schema.template.json"), caminhos.schema);
    console.log(`criado: ${caminhos.schema} (edite o schema para o seu domínio antes do genesis, se quiser)`);
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
  selftest: () => rodarSelftest({ validarPatch, dirFixtures: join(AQUI, "..", "fixtures") }),
};

if (!rotas[comando]) {
  console.error(`uso: cli.mjs <${Object.keys(rotas).join("|")}> [--dir <pasta>] [--patch <arquivo>] [--dry-run]`);
  process.exit(2);
}
process.exit(await rotas[comando]());
