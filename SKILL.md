---
name: skill-state
description: >
  Protocolo de estado de execução para trabalho de longo horizonte (baseado no paper
  SKILL.state, arXiv:2608.26263). Use SEMPRE que: (a) retomar trabalho num projeto/pasta que
  tenha STATE.json; (b) concluir um passo relevante, encontrar bloqueio ou tomar decisão que a
  próxima sessão precisa saber; (c) for escrever handoff/passagem de bastão (o patch vem
  primeiro); (d) o contexto estiver prestes a compactar; (e) iniciar trabalho multi-sessão num
  projeto que ainda NÃO tem STATE.json (proponha o init). Substitui memória conversacional por
  Σ estruturado + patches ΔΣ validados deterministicamente e registrados em trilha append-only.
---

# skill-state — estado explícito em vez de histórico conversacional

## A ideia em 4 linhas

O que você precisa lembrar entre sessões NÃO mora na conversa (ela compacta, envenena e mente) —
mora em `STATE.json` (Σ), um snapshot estruturado e validado por schema. Você lê Σ, trabalha, e
projeta o que importa num **patch ΔΣ** que um runtime determinístico valida ANTES de aplicar.
O raciocínio é efêmero; o estado é permanente; a trilha de patches é auditável.

## Quando esta skill se aplica (gatilhos)

| Situação | Ação |
|---|---|
| Sessão nova num projeto com `STATE.json` | Qualquer host: `node "$HOME/.claude/skills/skill-state/bin/cli.mjs" context`. No Claude Code o hook SessionStart já fez isso. Confie no `PRÓXIMO PASSO`; se STALE, re-derive da fonte primeiro. Stdout vazio = sem Σ → proponha `install --project`. Não chame `<repo>/.claude/skills/skill-state/bin/cli.mjs` |
| Passo concluído / decisão tomada / bloqueio encontrado | Proponha ΔΣ **agora**, não no fim da sessão |
| Vai escrever handoff, resumo de sessão, "onde paramos" | Patch primeiro; a prosa cita o `seq` do patch |
| Contexto prestes a compactar | Flush do ΔΣ pendente antes (o hook PreCompact lembra, mas é best-effort) |
| Trabalho multi-sessão começando num projeto SEM STATE.json | Proponha `install --project` (ou `init`) + genesis (ver INSTALL.md) |
| Tarefa de sessão única, pergunta pontual, exploração | **Não se aplica** — não crie estado para o que morre com a conversa |

## Anatomia (por projeto ou por área de trabalho)

| Arquivo | Papel | Quem escreve |
|---|---|---|
| `STATE.json` | Σ — snapshot atual | só o runtime (`cli.mjs apply`) |
| `STATE.schema.json` | contrato do domínio | humano/agente, raramente (mudança revisada) |
| `patches.jsonl` | trilha append-only de ΔΣ, hash-encadeada | só o runtime |

Estado: `.skill-state/` na raiz do projeto (mude com `--dir <pasta>` ou
`SKILL_STATE_DIR` — um diretório por fluxo de trabalho, ex.: um por spec).

CLI (uma vez no host, **não** por projeto):

```bash
node "$HOME/.claude/skills/skill-state/bin/cli.mjs" <comando>
```

`install --global` liga esse binário. `install --project` só cria `.skill-state/` —
**não** copia o CLI para `<repo>/.claude/skills/`. Não faça
`ls .skill-state && node <repo>/.claude/skills/skill-state/bin/cli.mjs`: pasta
ausente → `ls` exit 2 sem mensagem; pasta presente → `MODULE_NOT_FOUND`.

## O Σ tem duas zonas com autoridade DIFERENTE

- **`derivado_de_github`** — cache carimbado (`verificado_em`) do que vive numa fonte externa
  (issues, PRs, CI, sha da base). **A fonte vence, sempre.** Se `verify` disser `stale`,
  re-derive antes de confiar — e o primeiro patch da sessão é a re-derivação. Nunca cite este
  bloco como fato sem checar o carimbo.
- **`intencao`** — o que a fonte externa NÃO sabe: próximo passo, pendências, bloqueios,
  avisos operacionais. Aqui o STATE.json é autoritativo.
- `spec` + `schema_version` são o P imutável; `meta` é do runtime. Patch que os toque é
  rejeitado (`forbidden-key`).

## Fluxo obrigatório

1. **Ao retomar:** qualquer host chama `node "$HOME/.claude/skills/skill-state/bin/cli.mjs" context`
   (Claude Code: o hook SessionStart já injetou). Aja pelo `PRÓXIMO PASSO`.
2. **Trabalhe.** Raciocínio, tentativas e leituras são efêmeros — não precisam sobreviver.
3. **Mudou algo que a próxima sessão precisa saber?** Aplique o envelope via stdin
   (não use `/tmp` compartilhado entre sessões):

   ```bash
   node "$HOME/.claude/skills/skill-state/bin/cli.mjs" apply --patch - <<'EOF'
   { "seq": <meta.patch_seq + 1>, "base_seq": <meta.patch_seq atual>,
     "autor": "claude/<branch>", "quando": "<ISO-8601 UTC>",
     "motivo": "1 frase — por que este patch existe",
     "delta": { "intencao": { "proximo_passo": "..." } } }
   EOF
   ```

   Spec completa em `references/patch-format.md`. Substituição de lista que remove
   mais de 3 itens exige `confirma-lista` no `motivo` (`large-replace`).

4. **Rejeitado?** Leia `issues[]` (path + code + message), corrija e re-proponha — **máx 2
   retries**; na 3ª falha, pare e registre o problema para um humano. Nunca force, nunca
   edite `STATE.json` à mão.
5. **Antes de encerrar/compactar:** flush do ΔΣ pendente — a responsabilidade é sua, o hook
   só lembra.
6. **Handoffs em prosa:** patch primeiro; o texto cita o `seq`. Divergência entre prosa e
   STATE.json? O `verify` decide.

## Regras duras

- **NUNCA** edite `STATE.json` ou `patches.jsonl` à mão — `verify` detecta
  (replay ≠ snapshot) e o estado passa a valer nada. Só via `cli.mjs apply`.
- Arrays no delta são **substituição atômica** (mande a lista inteira); `null` **deleta** a
  chave; chave fora do schema **rejeita** — typo não vira chave-fantasma.
- `base_seq` deve ser o `meta.patch_seq` atual — dois agentes em paralelo: o segundo relê Σ e
  re-propõe (concorrência otimista).
- Substituição de lista que remove **mais de 3 itens** é recusada (`large-replace`) salvo
  `confirma-lista` no `motivo`. O runtime pega a omissão; `proximo_passo` que contradiz
  bloqueio aberto ainda pede juízo (schema pega forma, não mentira de intenção).
- O Σ não é lugar de prosa: campo novo recorrente → evolua o `STATE.schema.json` numa mudança
  revisada, não contrabandeie texto livre.

## Verificação

```bash
node "$HOME/.claude/skills/skill-state/bin/cli.mjs" verify     # cadeia + replay + staleness
node "$HOME/.claude/skills/skill-state/bin/cli.mjs" selftest   # contrato do protocolo (fixtures) — 40/40
```

Teste de aceitação de qualquer patch: uma sessão nova, lendo SÓ o contexto injetado, responde
"qual o próximo passo?" sem abrir mais nada. Se não responder, o último patch falhou —
registre a lacuna como pendência.
