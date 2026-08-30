# skill-state — especificação do envelope ΔΣ e do operador ⊕

> Contrato executável: `fixtures/` + `cli.mjs selftest`. Este documento descreve; os fixtures
> decidem. Divergência entre os dois é bug — corrija o que estiver errado na mesma mudança.

## 1. Envelope

Um patch é UM objeto JSON num arquivo próprio (nunca inline no shell — aspas quebram):

```json
{
  "seq": 8,
  "base_seq": 7,
  "autor": "claude/feat-123-slug",
  "quando": "2026-08-30T14:00:00Z",
  "motivo": "persistência do upload concluída (PR #42); próximo é o worker de fila",
  "delta": { "...": "..." }
}
```

| Campo | Regra |
|---|---|
| `seq` | `meta.patch_seq` atual + 1 |
| `base_seq` | `meta.patch_seq` atual — se o Σ avançou nesse meio-tempo, rejeita com `stale-base`: releia e re-proponha |
| `autor` | `claude/<branch>` ou `<usuario>` — quem propôs, para a trilha |
| `quando` | ISO-8601 UTC do momento da proposta |
| `motivo` | 1 frase; é o que um auditor lê no `patches.jsonl` — escreva para ele |
| `delta` | JSON Merge Patch restrito (§2) |

## 2. Operador ⊕ (RFC 7386 restrito)

| Situação no delta | Efeito |
|---|---|
| `"chave": {objeto}` | merge **recursivo** — só as chaves presentes mudam |
| `"chave": null` | **deleta** a chave do Σ |
| `"chave": escalar` | substitui |
| `"chave": [array]` | **substituição atômica** — mande a lista INTEIRA; para remover 1 item, reenvie a lista sem ele |

Restrições que o RFC não tem (e por quê — taxonomia de erros do paper SKILL.state §5.7,
medida em modelos menores):

| Código | Gatilho | Defende contra |
|---|---|---|
| `unknown-key` | chave fora do schema (validado no **resultado** Σ⊕ΔΣ, não só no delta) | typo virar chave-fantasma (68% dos erros observados) |
| `type-mismatch` | tipo/enum/const incoerente; chave obrigatória sumindo | corrupção estrutural (20%) |
| `malformed` | JSON inválido ou campo do envelope ausente | formatação (12%) |
| `forbidden-key` | delta tocando `spec`, `schema_version` ou `meta` | reescrever o P imutável / a zona do runtime |
| `stale-base` | `base_seq ≠ meta.patch_seq` | dois agentes se sobrescreverem |
| `duplicate-id` | `id` repetido em `pendencias`/`bloqueios` | item duplicado por releitura |

Rejeição NUNCA muda nada em disco (validate-then-write atômico) e devolve
`{"ok":false,"issues":[{"path","code","message"}]}` — o retry é seu, o rollback é do runtime.

**Exceção única (bootstrap):** no genesis (`base_seq: 0`, Σ inexistente) o delta PODE — e
deve — criar `spec` e `schema_version`. `meta` continua proibida sempre.

## 3. Trilha (`patches.jsonl`)

Cada linha: `{"envelope": <acima>, "prev_hash": "...", "hash": "..."}` com
`hash = sha256Hex(prev_hash + JSON.stringify(envelope))`, genesis `"genesis"` (SHA-256 via
WebCrypto). Consequências:

- adulterar, remover ou reordenar uma linha quebra a cadeia no elo exato (`verify` aponta);
- `replay(patches.jsonl) == STATE.json` sem `meta` — editar o snapshot à mão é detectável;
- a trilha é o registro de auditoria da execução: o prompt fica O(1), a história não se perde.

## 4. Exemplos mínimos

Concluir um passo e apontar o próximo:

```json
{ "seq": 9, "base_seq": 8, "autor": "claude/feat-44-upload", "quando": "2026-08-30T15:00:00Z",
  "motivo": "upload persistindo; próximo é o retry da fila",
  "delta": { "intencao": { "proximo_passo": "Implementar retry exponencial no worker da fila." } } }
```

Resolver uma pendência (array atômico — reenvia a lista sem ela) e registrar bloqueio:

```json
{ "seq": 10, "base_seq": 9, "autor": "claude/feat-45", "quando": "2026-08-30T16:00:00Z",
  "motivo": "p-docs resolvida; CI bloqueado por runner",
  "delta": { "intencao": {
    "pendencias": [ { "id": "p-e2e", "texto": "cobrir fluxo de upload no e2e", "dono": "agente", "origem": "sessao-3" } ],
    "bloqueios": [ { "id": "b-runner", "texto": "runner do CI sem espaço em disco — infra avisada" } ] } } }
```

Re-derivação da fonte externa (sempre que `verify` marcar `stale`):

```json
{ "seq": 11, "base_seq": 10, "autor": "claude/chore-rederive", "quando": "2026-08-31T09:00:00Z",
  "motivo": "re-derivação: base avançou; issues #12/#15 fechadas",
  "delta": { "derivado_de_github": { "verificado_em": "2026-08-31T09:00:00Z",
    "main_sha": "<sha novo>", "testes": { "total": 130, "verdes": 130 } } } }
```
