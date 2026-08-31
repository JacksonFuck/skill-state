/**
 * Validador determinístico do protocolo skill-state — subset de JSON Schema, zero deps.
 *
 * Cobre exatamente o que STATE.schema.json usa: type, properties, required,
 * additionalProperties, items, enum, const. Não é um validador JSON Schema completo de
 * propósito: cada palavra-chave a mais é superfície onde um patch malformado passa
 * despercebido. Se o schema do domínio precisar de mais, o lugar é uma
 * implementação tipada com validador completo — não aqui.
 *
 * As issues devolvidas usam os códigos da taxonomia de erros do paper SKILL.state §5.7,
 * na ordem de frequência observada lá: `unknown-key` (68% — sobrescrita/deleção acidental),
 * `type-mismatch` (20%), `malformed` (12%) — mais os códigos do próprio protocolo:
 * `forbidden-key`, `stale-base`, `invalid-seq`, `duplicate-id`, `schema-error`.
 */

function tipoDe(valor) {
  if (valor === null) return "null";
  if (Array.isArray(valor)) return "array";
  return typeof valor; // "object" | "string" | "number" | "boolean"
}

/**
 * Valida `valor` contra `schema` (subset). Devolve lista de issues
 * `{path, code, message}` — vazia = válido.
 */
export function validarContraSchema(valor, schema, caminho = "$") {
  const issues = [];
  if (schema === undefined || schema === null) {
    issues.push({ path: caminho, code: "schema-error", message: "schema ausente neste nó" });
    return issues;
  }

  if (schema.const !== undefined && valor !== schema.const) {
    issues.push({
      path: caminho,
      code: "type-mismatch",
      message: `esperado const ${JSON.stringify(schema.const)}, veio ${JSON.stringify(valor)}`,
    });
    return issues;
  }

  if (schema.enum !== undefined && !schema.enum.includes(valor)) {
    issues.push({
      path: caminho,
      code: "type-mismatch",
      message: `valor ${JSON.stringify(valor)} fora do enum [${schema.enum.join(", ")}]`,
    });
    return issues;
  }

  if (schema.type !== undefined) {
    const tipos = Array.isArray(schema.type) ? schema.type : [schema.type];
    const real = tipoDe(valor);
    const ok = tipos.includes(real) || (real === "number" && tipos.includes("integer") && Number.isInteger(valor));
    if (!ok) {
      issues.push({
        path: caminho,
        code: "type-mismatch",
        message: `esperado ${tipos.join("|")}, veio ${real}`,
      });
      return issues; // sem tipo certo, não adianta descer
    }
  }

  if (tipoDe(valor) === "object" && schema.properties !== undefined) {
    for (const chaveObrigatoria of schema.required ?? []) {
      if (!(chaveObrigatoria in valor)) {
        issues.push({
          path: `${caminho}.${chaveObrigatoria}`,
          code: "type-mismatch",
          message: "chave obrigatória ausente",
        });
      }
    }
    for (const [chave, filho] of Object.entries(valor)) {
      const schemaFilho = schema.properties[chave];
      if (schemaFilho === undefined) {
        if (schema.additionalProperties === false) {
          issues.push({
            path: `${caminho}.${chave}`,
            code: "unknown-key",
            message: "chave desconhecida (provável typo — o schema fecha este objeto)",
          });
        }
        continue;
      }
      issues.push(...validarContraSchema(filho, schemaFilho, `${caminho}.${chave}`));
    }
  }

  if (tipoDe(valor) === "array" && schema.items !== undefined) {
    valor.forEach((item, i) => {
      issues.push(...validarContraSchema(item, schema.items, `${caminho}[${i}]`));
    });
  }

  return issues;
}

/**
 * Regras do protocolo que o JSON Schema não expressa:
 * 1. `id` único em listas de itens identificados (pendencias/bloqueios).
 * 2. Zonas imutáveis (`spec`, `schema_version`) e zona do runtime (`meta`) — um delta que as
 *    toque é rejeitado com `forbidden-key` ANTES do merge.
 */
export function validarRegrasDoProtocolo(estadoResultante, delta) {
  const issues = [];
  for (const chaveProibida of ["spec", "schema_version", "meta"]) {
    if (delta !== null && typeof delta === "object" && chaveProibida in delta) {
      issues.push({
        path: `$.${chaveProibida}`,
        code: "forbidden-key",
        message:
          chaveProibida === "meta"
            ? "meta é escrita só pelo runtime — remova-a do delta"
            : `${chaveProibida} é o P imutável do protocolo — não pode ser alterado por patch`,
      });
    }
  }
  for (const lista of ["pendencias", "bloqueios"]) {
    const itens = estadoResultante?.intencao?.[lista];
    if (!Array.isArray(itens)) continue;
    const vistos = new Set();
    for (const item of itens) {
      if (item && typeof item === "object" && "id" in item) {
        if (vistos.has(item.id)) {
          issues.push({
            path: `$.intencao.${lista}`,
            code: "duplicate-id",
            message: `id duplicado: ${JSON.stringify(item.id)}`,
          });
        }
        vistos.add(item.id);
      }
    }
  }
  return issues;
}
