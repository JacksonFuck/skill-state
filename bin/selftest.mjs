/**
 * Selftest do protocolo skill-state — roda os fixtures dourados de scripts/skill-state/fixtures/.
 *
 * Os fixtures são o CONTRATO do protocolo, não exemplos: a futura Camada 2
 * (ex.: uma versão tipada em TS/zod) deve passar exatamente nestes mesmos arquivos — a paridade
 * .mjs↔TS é provada por dados compartilhados, não por código compartilhado.
 *
 * Cobertura, mapeada na taxonomia de erros do paper SKILL.state §5.7:
 *   1. patch válido aplica e bate com o resultado dourado (⊕: merge recursivo, null-deletion,
 *      array como substituição atômica);
 *   2. chave desconhecida  → unknown-key   (typo; o 68% do paper é omissão no merge);
 *   3. tipo incoerente     → type-mismatch (20%);
 *   4. JSON malformado     → malformed     (12%);
 *   5. base_seq velho      → stale-base    (concorrência otimista);
 *   6. delta tocando meta  → forbidden-key (zona do runtime);
 *   7. seq não-contíguo    → invalid-seq   (acima e abaixo de patch_seq+1);
 *   8. cadeia dourada íntegra verifica; cadeia adulterada acusa o elo exato;
 *   9. replay da cadeia dourada reconstrói o estado dourado (Σ é derivável do log);
 *  10. apply rejeitado não grava STATE.json nem patches.jsonl;
 *  11. apply com seq = patch_seq+1 deixa verify verde;
 *  12. envelope: quando ISO-8601, sem chaves extra, autor/motivo não-vazios.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { aplicarMergePatch } from "./merge.mjs";
import { verificarCadeia } from "./chain.mjs";

export async function rodarSelftest({ validarPatch, dirFixtures }) {
  const ler = (nome) => JSON.parse(readFileSync(join(dirFixtures, nome), "utf8"));
  const schema = ler("schema.json");
  const estado = ler("estado-inicial.json");
  const dourado = ler("resultado-dourado.json");
  const resultados = [];
  const caso = (nome, ok, detalhe = "") => resultados.push({ nome, ok, detalhe });

  const semMeta = ({ meta, ...resto }) => resto;

  const valido = await validarPatch(estado, schema, ler("patch-valido.json"));
  caso(
    "patch válido aplica (⊕ + null-deletion + array atômico)",
    valido.issues.length === 0 && JSON.stringify(semMeta(valido.resultado)) === JSON.stringify(semMeta(dourado)),
    JSON.stringify(valido.issues),
  );

  const esperaCodigo = async (nome, arquivo, codigo, pathEsperado) => {
    const r = await validarPatch(estado, schema, ler(arquivo));
    const bate = r.issues.some((i) => i.code === codigo && (!pathEsperado || i.path === pathEsperado));
    caso(nome, r.resultado === null && bate, JSON.stringify(r.issues));
  };
  await esperaCodigo("chave desconhecida rejeita (unknown-key)", "patch-chave-desconhecida.json", "unknown-key");
  await esperaCodigo("tipo incoerente rejeita (type-mismatch)", "patch-tipo-errado.json", "type-mismatch");
  await esperaCodigo("base_seq velho rejeita (stale-base)", "patch-stale.json", "stale-base");
  await esperaCodigo("delta tocando meta rejeita (forbidden-key)", "patch-meta-proibido.json", "forbidden-key");
  await esperaCodigo("seq acima do próximo rejeita (invalid-seq)", "patch-seq-alto.json", "invalid-seq");
  await esperaCodigo("seq abaixo do próximo rejeita (invalid-seq)", "patch-seq-baixo.json", "invalid-seq");
  await esperaCodigo("quando fora de ISO-8601 rejeita (malformed)", "patch-quando-invalido.json", "malformed", "$.quando");
  await esperaCodigo("chave extra no envelope rejeita (unknown-key)", "patch-envelope-extra.json", "unknown-key", "$.foo");
  await esperaCodigo("autor vazio rejeita (malformed)", "patch-autor-vazio.json", "malformed", "$.autor");
  await esperaCodigo("motivo só espaços rejeita (malformed)", "patch-motivo-vazio.json", "malformed", "$.motivo");

  let malformado = false;
  try {
    JSON.parse(readFileSync(join(dirFixtures, "patch-malformado.txt"), "utf8"));
  } catch {
    malformado = true; // no CLI real, este parse error vira {code:"malformed"} com a posição
  }
  caso("JSON malformado rejeita (malformed)", malformado);

  const cadeiaDourada = ler("cadeia-dourada.json");
  const integra = await verificarCadeia(cadeiaDourada);
  caso("cadeia dourada íntegra verifica", integra.ok, JSON.stringify(integra));

  const adulterada = await verificarCadeia(ler("cadeia-adulterada.json"));
  caso("cadeia adulterada acusa o elo exato", adulterada.ok === false && adulterada.quebradaEm === 1, JSON.stringify(adulterada));

  let sigma = {};
  for (const elo of cadeiaDourada) sigma = aplicarMergePatch(sigma, elo.envelope.delta);
  caso(
    "replay da cadeia reconstrói o estado dourado",
    JSON.stringify(sigma) === JSON.stringify(semMeta(dourado)),
  );

  const cli = join(dirFixtures, "..", "bin", "cli.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "skill-state-selftest-"));
  try {
    const dirEstado = join(tmp, ".skill-state");
    mkdirSync(dirEstado);
    copyFileSync(join(dirFixtures, "schema.json"), join(dirEstado, "STATE.schema.json"));
    copyFileSync(join(dirFixtures, "estado-inicial.json"), join(dirEstado, "STATE.json"));
    writeFileSync(join(dirEstado, "patches.jsonl"), `${JSON.stringify(cadeiaDourada[0])}\n`);
    const lerPar = () => ({
      estado: readFileSync(join(dirEstado, "STATE.json"), "utf8"),
      log: existsSync(join(dirEstado, "patches.jsonl")) ? readFileSync(join(dirEstado, "patches.jsonl"), "utf8") : "",
    });
    const antes = lerPar();
    const env = { ...process.env, CLAUDE_PROJECT_DIR: tmp };
    const rodar = (args) => {
      try {
        return { status: 0, stdout: execFileSync("node", [cli, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        return { status: e.status ?? 1, stdout: e.stdout ?? "" };
      }
    };
    const rejeitado = rodar(["apply", "--patch", join(dirFixtures, "patch-seq-alto.json")]);
    const depoisRejeicao = lerPar();
    let applyIssues = [];
    try { applyIssues = JSON.parse(rejeitado.stdout).issues ?? []; } catch { /* stdout inesperado */ }
    caso(
      "apply seq pulado rejeita e não grava",
      rejeitado.status === 1
        && applyIssues.some((i) => i.code === "invalid-seq")
        && depoisRejeicao.estado === antes.estado
        && depoisRejeicao.log === antes.log,
      rejeitado.stdout,
    );
    const recusaSemGravar = (arquivo, codigo) => {
      const r = rodar(["apply", "--patch", join(dirFixtures, arquivo)]);
      const depois = lerPar();
      let issues = [];
      try { issues = JSON.parse(r.stdout).issues ?? []; } catch { /* stdout inesperado */ }
      return {
        ok: r.status === 1 && issues.some((i) => i.code === codigo) && depois.estado === antes.estado && depois.log === antes.log,
        stdout: r.stdout,
      };
    };
    const extra = recusaSemGravar("patch-envelope-extra.json", "unknown-key");
    caso("apply envelope extra rejeita e não grava", extra.ok, extra.stdout);
    const quando = recusaSemGravar("patch-quando-invalido.json", "malformed");
    caso("apply quando inválido rejeita e não grava", quando.ok, quando.stdout);
    const autor = recusaSemGravar("patch-autor-vazio.json", "malformed");
    caso("apply autor vazio rejeita e não grava", autor.ok, autor.stdout);
    const ctx = rodar(["context"]);
    let additional = "";
    try { additional = JSON.parse(ctx.stdout).hookSpecificOutput?.additionalContext ?? ""; } catch { /* stdout inesperado */ }
    caso("context com Σ injeta PRÓXIMO PASSO", ctx.status === 0 && additional.includes("PRÓXIMO PASSO:"), ctx.stdout);
    const aceito = rodar(["apply", "--patch", join(dirFixtures, "patch-valido.json")]);
    const verificado = rodar(["verify"]);
    let applyOk = false;
    let verifyOk = false;
    try { applyOk = JSON.parse(aceito.stdout).ok === true && JSON.parse(aceito.stdout).seq === 2; } catch { /* stdout inesperado */ }
    try { const v = JSON.parse(verificado.stdout); verifyOk = v.ok === true && v.replay_ok === true; } catch { /* stdout inesperado */ }
    caso(
      "apply seq contíguo deixa verify verde",
      aceito.status === 0 && applyOk && verificado.status === 0 && verifyOk,
      `apply=${aceito.stdout} verify=${verificado.stdout}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const vazio = mkdtempSync(join(tmpdir(), "skill-state-selftest-empty-"));
  try {
    const envVazio = { ...process.env, CLAUDE_PROJECT_DIR: vazio };
    let ctxVazio;
    try {
      ctxVazio = { status: 0, stdout: execFileSync("node", [cli, "context"], { env: envVazio, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      ctxVazio = { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
    caso("context sem Σ sai silencioso", ctxVazio.status === 0 && ctxVazio.stdout.trim() === "", ctxVazio.stdout);
  } finally {
    rmSync(vazio, { recursive: true, force: true });
  }

  const raizSkill = join(dirFixtures, "..");
  const textoHooks = readFileSync(join(raizSkill, "templates", "hooks.snippet.json"), "utf8");
  const textoInstall = readFileSync(join(raizSkill, "INSTALL.md"), "utf8");
  caso(
    "hooks oficiais não engolem erro",
    !textoHooks.includes("2>/dev/null || true") && !textoInstall.includes("2>/dev/null || true"),
  );
  const textoSkill = readFileSync(join(raizSkill, "SKILL.md"), "utf8");
  caso("SKILL.md não aponta /tmp/patch.json", !textoSkill.includes("/tmp/patch.json"));

  const estadoCheio = structuredClone(estado);
  estadoCheio.intencao.pendencias = [1, 2, 3, 4, 5].map((n) => ({
    id: `p-${n}`,
    texto: `item ${n}`,
    dono: "agente",
  }));
  const confirmado = await validarPatch(estadoCheio, schema, ler("patch-large-replace-ok.json"));
  caso(
    "large-replace com confirma-lista aplica",
    confirmado.issues.length === 0 && Array.isArray(confirmado.resultado?.intencao?.pendencias) && confirmado.resultado.intencao.pendencias.length === 0,
    JSON.stringify(confirmado.issues),
  );
  // esperaCodigo usa `estado` (1 pendência) — large-replace precisa do estadoCheio
  const wipe = await validarPatch(estadoCheio, schema, ler("patch-large-replace.json"));
  caso(
    "large-replace em lista longa rejeita",
    wipe.resultado === null && wipe.issues.some((i) => i.code === "large-replace" && i.path === "$.intencao.pendencias"),
    JSON.stringify(wipe.issues),
  );

  const tmpStdin = mkdtempSync(join(tmpdir(), "skill-state-selftest-stdin-"));
  try {
    const dirStdin = join(tmpStdin, ".skill-state");
    mkdirSync(dirStdin);
    copyFileSync(join(dirFixtures, "schema.json"), join(dirStdin, "STATE.schema.json"));
    copyFileSync(join(dirFixtures, "estado-inicial.json"), join(dirStdin, "STATE.json"));
    writeFileSync(join(dirStdin, "patches.jsonl"), `${JSON.stringify(cadeiaDourada[0])}\n`);
    const envStdin = { ...process.env, CLAUDE_PROJECT_DIR: tmpStdin };
    let stdinOut;
    try {
      stdinOut = {
        status: 0,
        stdout: execFileSync("node", [cli, "apply", "--patch", "-"], {
          env: envStdin,
          encoding: "utf8",
          input: readFileSync(join(dirFixtures, "patch-valido.json")),
          stdio: ["pipe", "pipe", "pipe"],
        }),
      };
    } catch (e) {
      stdinOut = { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
    let stdinApplyOk = false;
    try { stdinApplyOk = JSON.parse(stdinOut.stdout).ok === true && JSON.parse(stdinOut.stdout).seq === 2; } catch { /* stdout inesperado */ }
    let stdinVerify;
    try {
      stdinVerify = { status: 0, stdout: execFileSync("node", [cli, "verify"], { env: envStdin, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      stdinVerify = { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
    let stdinVerifyOk = false;
    try { const v = JSON.parse(stdinVerify.stdout); stdinVerifyOk = v.ok === true && v.replay_ok === true; } catch { /* stdout inesperado */ }
    caso(
      "apply --patch - (stdin) deixa verify verde",
      stdinOut.status === 0 && stdinApplyOk && stdinVerify.status === 0 && stdinVerifyOk,
      `apply=${stdinOut.stdout} verify=${stdinVerify.stdout}`,
    );
  } finally {
    rmSync(tmpStdin, { recursive: true, force: true });
  }

  for (const r of resultados) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.nome}${r.ok ? "" : ` — ${r.detalhe}`}`);
  }
  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(falhas === 0 ? `selftest: ${resultados.length}/${resultados.length} verdes` : `selftest: ${falhas} FALHA(S)`);
  return falhas === 0 ? 0 : 1;
}
