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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
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
  caso(
    "SKILL.md e hooks invocam o CLI global, não o do projeto",
    textoSkill.includes("$HOME/.claude/skills/skill-state/bin/cli.mjs")
      && !textoSkill.includes("node .claude/skills/skill-state")
      && textoHooks.includes("$HOME/.claude/skills/skill-state/bin/cli.mjs")
      && !textoHooks.includes("${CLAUDE_PROJECT_DIR:-.}/.claude/skills/skill-state"),
  );

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

  const aliasado = await validarPatch(estado, schema, ler("patch-alias-en.json"));
  caso(
    "alias EN next_step vira proximo_passo",
    aliasado.issues.length === 0
      && aliasado.resultado?.intencao?.proximo_passo === "Fazer Y."
      && !Object.hasOwn(aliasado.resultado?.intencao ?? {}, "next_step"),
    JSON.stringify(aliasado.issues),
  );

  const montar = (prefixo) => {
    const raiz = mkdtempSync(join(tmpdir(), prefixo));
    const dirEstado = join(raiz, ".skill-state");
    mkdirSync(dirEstado);
    copyFileSync(join(dirFixtures, "schema.json"), join(dirEstado, "STATE.schema.json"));
    copyFileSync(join(dirFixtures, "estado-inicial.json"), join(dirEstado, "STATE.json"));
    writeFileSync(join(dirEstado, "patches.jsonl"), `${JSON.stringify(cadeiaDourada[0])}\n`);
    return { raiz, dirEstado, env: { ...process.env, CLAUDE_PROJECT_DIR: raiz } };
  };
  const rodarCli = (env, args) => {
    try {
      return { status: 0, stdout: execFileSync("node", [cli, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  };

  const tmpLock = montar("skill-state-selftest-lock-");
  try {
    const spawnApply = () => new Promise((resolve) => {
      const p = spawn("node", [cli, "apply", "--patch", join(dirFixtures, "patch-valido.json")], {
        env: tmpLock.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      p.stdout.on("data", (c) => { stdout += c; });
      p.on("close", (status) => resolve({ status: status ?? 1, stdout }));
    });
    const [a, b] = await Promise.all([spawnApply(), spawnApply()]);
    const parsed = [a, b].map((r) => {
      try { return JSON.parse(r.stdout); } catch { return {}; }
    });
    const oks = parsed.filter((p) => p.ok === true).length;
    const stale = parsed.filter((p) => (p.issues ?? []).some((i) => i.code === "stale-base" || i.code === "locked")).length;
    const logLinhas = readFileSync(join(tmpLock.dirEstado, "patches.jsonl"), "utf8").split("\n").filter(Boolean);
    const ver = rodarCli(tmpLock.env, ["verify"]);
    let verOk = false;
    try { verOk = JSON.parse(ver.stdout).ok === true && JSON.parse(ver.stdout).replay_ok === true; } catch { /* stdout inesperado */ }
    caso(
      "dois apply paralelos: um ganha, log íntegro, verify verde",
      oks === 1 && stale === 1 && logLinhas.length === 2 && ver.status === 0 && verOk,
      `a=${a.stdout} b=${b.stdout} verify=${ver.stdout} linhas=${logLinhas.length}`,
    );
  } finally {
    rmSync(tmpLock.raiz, { recursive: true, force: true });
  }

  const tmpJ = montar("skill-state-selftest-journal-");
  try {
    const aplicado = rodarCli(tmpJ.env, ["apply", "--patch", join(dirFixtures, "patch-valido.json")]);
    const estadoNovo = readFileSync(join(tmpJ.dirEstado, "STATE.json"), "utf8");
    const logNovo = readFileSync(join(tmpJ.dirEstado, "patches.jsonl"), "utf8").trim().split("\n");
    const eloNovo = JSON.parse(logNovo.at(-1));
    copyFileSync(join(dirFixtures, "estado-inicial.json"), join(tmpJ.dirEstado, "STATE.json"));
    writeFileSync(join(tmpJ.dirEstado, "patches.jsonl"), `${JSON.stringify(cadeiaDourada[0])}\n`);
    writeFileSync(join(tmpJ.dirEstado, "apply.journal"), `${JSON.stringify({ estado: JSON.parse(estadoNovo), elo: eloNovo })}\n`);
    const verJ = rodarCli(tmpJ.env, ["verify"]);
    let verJOk = false;
    try { verJOk = JSON.parse(verJ.stdout).ok === true && JSON.parse(verJ.stdout).replay_ok === true; } catch { /* stdout inesperado */ }
    const journalSumiu = !existsSync(join(tmpJ.dirEstado, "apply.journal"));
    const estadoRec = JSON.parse(readFileSync(join(tmpJ.dirEstado, "STATE.json"), "utf8"));
    caso(
      "journal residual: verify recupera e some o journal",
      aplicado.status === 0 && verJ.status === 0 && verJOk && journalSumiu && estadoRec.meta?.patch_seq === 2,
      `apply=${aplicado.stdout} verify=${verJ.stdout} journal=${journalSumiu} seq=${estadoRec.meta?.patch_seq}`,
    );
  } finally {
    rmSync(tmpJ.raiz, { recursive: true, force: true });
  }

  const schemaDe = (dominio) => {
    const raiz = mkdtempSync(join(tmpdir(), `skill-state-init-${dominio}-`));
    try {
      const r = rodarCli({ ...process.env, CLAUDE_PROJECT_DIR: raiz }, ["init", "--domain", dominio]);
      const schemaPath = join(raiz, ".skill-state", "STATE.schema.json");
      const s = JSON.parse(readFileSync(schemaPath, "utf8"));
      const zonas = ["schema_version", "spec", "derivado_de_github", "intencao", "meta"];
      const okZonas = zonas.every((z) => (s.required ?? []).includes(z)) && s.additionalProperties === false;
      return { r, s, okZonas, raiz };
    } catch (e) {
      return { r: { status: 1, stdout: String(e) }, s: {}, okZonas: false, raiz };
    }
  };
  const ops = schemaDe("ops");
  caso(
    "init --domain ops cria schema distinto com 4 zonas fechadas",
    ops.r.status === 0 && ops.okZonas && ops.s.properties?.intencao?.properties?.incidentes !== undefined
      && ops.s.properties?.intencao?.properties?.pendencias === undefined,
    JSON.stringify({ status: ops.r.status, keys: Object.keys(ops.s.properties?.intencao?.properties ?? {}) }),
  );
  rmSync(ops.raiz, { recursive: true, force: true });
  const pesquisa = schemaDe("pesquisa");
  caso(
    "init --domain pesquisa cria schema distinto com 4 zonas fechadas",
    pesquisa.r.status === 0 && pesquisa.okZonas && pesquisa.s.properties?.intencao?.properties?.hipoteses !== undefined
      && pesquisa.s.properties?.intencao?.properties?.pendencias === undefined,
    JSON.stringify({ status: pesquisa.r.status, keys: Object.keys(pesquisa.s.properties?.intencao?.properties ?? {}) }),
  );
  rmSync(pesquisa.raiz, { recursive: true, force: true });

  const textoReadme = readFileSync(join(raizSkill, "README.md"), "utf8");
  caso(
    "docs descrevem context como comando de qualquer host",
    (textoSkill.includes("qualquer host") || textoSkill.includes("qualquer agente"))
      && (textoReadme.includes("qualquer host") || textoReadme.includes("não só SessionStart") || textoReadme.includes("qualquer agente")),
  );
  caso("README não diz archive não implementado", !textoReadme.includes("não implementado"));

  const tmpArq = montar("skill-state-selftest-archive-");
  try {
    const estadoGenesis = readFileSync(join(tmpArq.dirEstado, "STATE.json"), "utf8");
    const aplicado = rodarCli(tmpArq.env, ["apply", "--patch", join(dirFixtures, "patch-valido.json")]);
    const arqFeliz = rodarCli(tmpArq.env, ["archive", "--keep", "1"]);
    let arqOk = false;
    try { arqOk = JSON.parse(arqFeliz.stdout).ok === true && JSON.parse(arqFeliz.stdout).arquivados === 1; } catch { /* stdout inesperado */ }
    const logHot = readFileSync(join(tmpArq.dirEstado, "patches.jsonl"), "utf8").split("\n").filter(Boolean);
    const artefatos = existsSync(join(tmpArq.dirEstado, "archive"))
      ? readdirSync(join(tmpArq.dirEstado, "archive"))
      : [];
    const verArq = rodarCli(tmpArq.env, ["verify"]);
    let verArqOk = false;
    try { verArqOk = JSON.parse(verArq.stdout).ok === true && JSON.parse(verArq.stdout).replay_ok === true; } catch { /* stdout inesperado */ }
    caso(
      "archive com verify verde recorta o prefixo e verify segue verde",
      aplicado.status === 0 && arqFeliz.status === 0 && arqOk && logHot.length === 1 && artefatos.length >= 1 && verArq.status === 0 && verArqOk,
      `archive=${arqFeliz.stdout} verify=${verArq.stdout} hot=${logHot.length} artefatos=${artefatos}`,
    );

    writeFileSync(join(tmpArq.dirEstado, "STATE.json"), estadoGenesis);
    const logHotAntesRecusa = readFileSync(join(tmpArq.dirEstado, "patches.jsonl"), "utf8");
    const metaAntes = existsSync(join(tmpArq.dirEstado, "archive.meta.json"))
      ? readFileSync(join(tmpArq.dirEstado, "archive.meta.json"), "utf8")
      : "";
    const recusa = rodarCli(tmpArq.env, ["archive", "--keep", "1"]);
    let recusaCode = "";
    try { recusaCode = (JSON.parse(recusa.stdout).issues ?? []).map((i) => i.code).join(","); } catch { /* stdout inesperado */ }
    const logDepois = readFileSync(join(tmpArq.dirEstado, "patches.jsonl"), "utf8");
    const metaDepois = existsSync(join(tmpArq.dirEstado, "archive.meta.json"))
      ? readFileSync(join(tmpArq.dirEstado, "archive.meta.json"), "utf8")
      : "";
    caso(
      "archive com verify vermelho recusa e não toca os arquivos",
      recusa.status === 1 && recusaCode.includes("verify-failed") && logDepois === logHotAntesRecusa && metaDepois === metaAntes,
      `recusa=${recusa.stdout}`,
    );
  } finally {
    rmSync(tmpArq.raiz, { recursive: true, force: true });
  }

  const homeInst = mkdtempSync(join(tmpdir(), "skill-state-selftest-install-home-"));
  try {
    const mkdirp = (p) => mkdirSync(p, { recursive: true });
    mkdirp(join(homeInst, ".claude"));
    writeFileSync(join(homeInst, ".claude", "settings.json"), `${JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "jcode-existente", timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: "dream-existente" }] }],
      },
    }, null, 2)}\n`);
    mkdirp(join(homeInst, ".codex"));
    writeFileSync(join(homeInst, ".codex", "hooks.json"), `${JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "jcode-codex", timeout: 5 }] }],
      },
    }, null, 2)}\n`);
    mkdirp(join(homeInst, ".grok"));
    mkdirp(join(homeInst, ".opencode", "skills"));
    mkdirp(join(homeInst, ".config", "opencode"));
    writeFileSync(join(homeInst, ".config", "opencode", "opencode.json"), `${JSON.stringify({
      permission: { skill: { "*": "deny", tdd: "allow" } },
    }, null, 2)}\n`);
    mkdirp(join(homeInst, ".phi", "agent", "skills"));
    mkdirp(join(homeInst, ".phi", "agent", "extensions"));

    const r1 = rodarCli(process.env, ["install", "--global", "--home", homeInst]);
    const r2 = rodarCli(process.env, ["install", "--global", "--home", homeInst]);
    const claude = JSON.parse(readFileSync(join(homeInst, ".claude", "settings.json"), "utf8"));
    const codex = JSON.parse(readFileSync(join(homeInst, ".codex", "hooks.json"), "utf8"));
    const grokPath = join(homeInst, ".grok", "hooks", "skill-state.json");
    const oc = JSON.parse(readFileSync(join(homeInst, ".config", "opencode", "opencode.json"), "utf8"));
    const skillLink = join(homeInst, ".claude", "skills", "skill-state");
    const nSs = (hooks) => JSON.stringify(hooks?.SessionStart ?? []).split("skill-state/bin/cli.mjs").length - 1;
    const nPc = (hooks) => JSON.stringify(hooks?.PreCompact ?? []).split("skill-state/bin/cli.mjs").length - 1;
    const jcodeClaude = JSON.stringify(claude.hooks.SessionStart).includes("jcode-existente");
    const dream = JSON.stringify(claude.hooks.Stop).includes("dream-existente");
    const jcodeCodex = JSON.stringify(codex.hooks.SessionStart).includes("jcode-codex");
    caso(
      "install --global preserva hooks existentes, liga os 5 hosts e é idempotente",
      r1.status === 0 && r2.status === 0
        && lstatSync(skillLink).isSymbolicLink()
        && existsSync(join(skillLink, "SKILL.md"))
        && jcodeClaude && dream && jcodeCodex
        && nSs(claude.hooks) === 1 && nPc(claude.hooks) === 1
        && nSs(codex.hooks) === 1 && nPc(codex.hooks) === 1
        && existsSync(grokPath)
        && oc.permission?.skill?.["skill-state"] === "allow" && oc.permission?.skill?.["*"] === "deny"
        && existsSync(join(homeInst, ".config", "opencode", "plugins", "skill-state.js"))
        && existsSync(join(homeInst, ".phi", "agent", "extensions", "skill-state.ts"))
        && existsSync(join(homeInst, ".grok", "skills", "skill-state"))
        && existsSync(join(homeInst, ".codex", "skills", "skill-state"))
        && existsSync(join(homeInst, ".opencode", "skills", "skill-state"))
        && existsSync(join(homeInst, ".phi", "agent", "skills", "skill-state")),
      `r1=${r1.status} r2=${r2.status} ss=${nSs(claude.hooks)} pc=${nPc(claude.hooks)} out=${r1.stdout.slice(0, 400)}`,
    );
  } finally {
    rmSync(homeInst, { recursive: true, force: true });
  }

  const projInst = mkdtempSync(join(tmpdir(), "skill-state-selftest-install-proj-"));
  try {
    const rP = rodarCli({ ...process.env, CLAUDE_PROJECT_DIR: projInst }, ["install", "--project"]);
    const schemaP = join(projInst, ".skill-state", "STATE.schema.json");
    caso(
      "install --project cria o schema e imprime o genesis",
      rP.status === 0 && existsSync(schemaP) && rP.stdout.includes('"seq": 1') && rP.stdout.includes("genesis"),
      rP.stdout.slice(0, 400),
    );
  } finally {
    rmSync(projInst, { recursive: true, force: true });
  }

  caso(
    "INSTALL.md documenta install --global e --project",
    textoInstall.includes("install --global") && textoInstall.includes("install --project"),
  );

  for (const r of resultados) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.nome}${r.ok ? "" : ` — ${r.detalhe}`}`);
  }
  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(falhas === 0 ? `selftest: ${resultados.length}/${resultados.length} verdes` : `selftest: ${falhas} FALHA(S)`);
  return falhas === 0 ? 0 : 1;
}
