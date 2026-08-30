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
 *   2. chave desconhecida  → unknown-key   (68% dos erros observados no paper);
 *   3. tipo incoerente     → type-mismatch (20%);
 *   4. JSON malformado     → malformed     (12%);
 *   5. base_seq velho      → stale-base    (concorrência otimista);
 *   6. delta tocando meta  → forbidden-key (zona do runtime);
 *   7. cadeia dourada íntegra verifica; cadeia adulterada acusa o elo exato;
 *   8. replay da cadeia dourada reconstrói o estado dourado (Σ é derivável do log).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  const esperaCodigo = async (nome, arquivo, codigo) => {
    const r = await validarPatch(estado, schema, ler(arquivo));
    caso(nome, r.resultado === null && r.issues.some((i) => i.code === codigo), JSON.stringify(r.issues));
  };
  await esperaCodigo("chave desconhecida rejeita (unknown-key)", "patch-chave-desconhecida.json", "unknown-key");
  await esperaCodigo("tipo incoerente rejeita (type-mismatch)", "patch-tipo-errado.json", "type-mismatch");
  await esperaCodigo("base_seq velho rejeita (stale-base)", "patch-stale.json", "stale-base");
  await esperaCodigo("delta tocando meta rejeita (forbidden-key)", "patch-meta-proibido.json", "forbidden-key");

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

  for (const r of resultados) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.nome}${r.ok ? "" : ` — ${r.detalhe}`}`);
  }
  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(falhas === 0 ? `selftest: ${resultados.length}/${resultados.length} verdes` : `selftest: ${falhas} FALHA(S)`);
  return falhas === 0 ? 0 : 1;
}
