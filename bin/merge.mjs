/**
 * Operador ⊕ do protocolo skill-state (ver references/patch-format.md).
 *
 * Semântica: RFC 7386 (JSON Merge Patch) **restrito** — mapeia 1:1 a null-deletion do paper
 * SKILL.state (arXiv:2608.26263 §3.2), com duas restrições deliberadas que o RFC não tem:
 *
 * 1. Arrays são SUBSTITUIÇÃO ATÔMICA (o delta traz a lista inteira). Nada de append nem índice
 *    posicional — determinístico e imune à duplicação silenciosa que um merge de listas criaria.
 * 2. O merge é puro e não conhece schema: quem rejeita chave desconhecida/tipo errado é o
 *    validador (schema.mjs), sempre sobre o RESULTADO Σ⊕ΔΣ — nunca só sobre o delta.
 *
 * Função pura, sem I/O: é a mesma tabela-verdade que qualquer reimplementação tipada
 * deverá reproduzir — a paridade é provada pelos fixtures dourados, não por compartilhar código.
 */

function ehObjetoPlano(valor) {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/**
 * Aplica um JSON Merge Patch restrito: objeto = merge recursivo, `null` deleta a chave,
 * escalar/array substituem. Não muta os argumentos; devolve sempre estrutura nova.
 */
export function aplicarMergePatch(estado, delta) {
  if (!ehObjetoPlano(delta)) {
    // RFC 7386: patch não-objeto substitui o alvo inteiro. No protocolo skill-state isso
    // nunca é desejável no topo (apagaria Σ) — o validador rejeita antes; aqui mantemos a
    // semântica do RFC para os níveis internos (escalar/array substituem).
    return delta;
  }
  const base = ehObjetoPlano(estado) ? estado : {};
  const resultado = { ...base };
  for (const [chave, valor] of Object.entries(delta)) {
    if (valor === null) {
      delete resultado[chave];
    } else if (ehObjetoPlano(valor)) {
      resultado[chave] = aplicarMergePatch(base[chave], valor);
    } else {
      resultado[chave] = Array.isArray(valor) ? valor.map(clonar) : valor;
    }
  }
  return resultado;
}

function clonar(valor) {
  return typeof valor === "object" && valor !== null ? structuredClone(valor) : valor;
}

/** Conta quantas chaves o delta DELETA (valor null, em qualquer profundidade). */
export function contarDelecoes(delta) {
  if (!ehObjetoPlano(delta)) return 0;
  let n = 0;
  for (const valor of Object.values(delta)) {
    if (valor === null) n += 1;
    else if (ehObjetoPlano(valor)) n += contarDelecoes(valor);
  }
  return n;
}
