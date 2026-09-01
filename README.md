# skill-state v1.1.1 — estado de execução explícito para agentes

Guarda “onde paramos” em três arquivos no projeto, conferidos por um programa — não pela
conversa, que esquece e inventa. Serve para Claude Code, Codex, Grok, OpenCode e Phi.

**Zero `npm`. Node ≥ 20.** O dia-a-dia do agente é a `SKILL.md`. Você só instala.

## Instalar (copie e cole)

```bash
# 1. baixar (uma vez no computador)
git clone https://github.com/JacksonFuck/skill-state ~/.claude/skills/skill-state

# 2. testar — a última linha deve ser "selftest: 40/40 verdes"
node ~/.claude/skills/skill-state/bin/cli.mjs selftest

# 3. ligar nos seus agentes (Claude, Codex, Grok, OpenCode, Phi)
node ~/.claude/skills/skill-state/bin/cli.mjs install --global

# 4. em CADA pasta de projeto que for usar
cd pasta-do-seu-projeto
node ~/.claude/skills/skill-state/bin/cli.mjs install --project
```

O passo 4 imprime um JSON. Peça ao agente para preenchê-lo com o estado real do projeto e
aplicar. Depois, numa sessão nova, pergunte **“qual o próximo passo?”**.

Guia curto, para quem nunca viu isto: **[INSTALL.md](INSTALL.md)**.  
Codex: depois do passo 3, `/hooks` e confie as linhas novas.

---

## 1. O problema que isto resolve

Agentes que trabalham em tarefas de longo horizonte guardam "onde paramos" de dois jeitos
ruins:

1. **Na conversa** — que compacta (perde), cresce O(T²) em custo, e envenena decisões: fatos
   obsoletos no histórico "vencem" observações novas (no paper, Tabela 3: agentes com
   histórico levam 5–8 turnos alucinando até aceitar que o mundo mudou).
2. **Em prosa livre** (HANDOFF.md, MEMORY.md, TODO.md) — que ninguém valida. É o padrão de
   falha clássico: o arquivo de estado que "mente" — um TODO desatualizado que gera uma issue
   falsa e uma sessão inteira de investigação, um "PR aguardando revisão" semanas depois do
   merge. Documento não é fato; sem validação, a mentira só aparece quando já custou trabalho.

O skill-state substitui os dois por três arquivos com **validação determinística**:

| Arquivo | O que é | Quem escreve |
|---|---|---|
| `STATE.json` | **Σ** — snapshot estruturado do estado de execução | só o runtime |
| `STATE.schema.json` | contrato do domínio (JSON Schema, objetos fechados) | humano/agente, raramente |
| `patches.jsonl` | trilha append-only de patches **ΔΣ**, hash-encadeada | só o runtime |

O agente **lê** Σ, trabalha, e **propõe** um patch ΔΣ. O runtime (`bin/cli.mjs` — código
determinístico, não LLM) valida contra o schema, aplica com merge atômico e registra na
cadeia. Raciocínio é efêmero; estado é permanente; trilha é auditável.

## 2. Quando aplicar — e quando NÃO

**Aplique quando:**

- o trabalho atravessa **mais de uma sessão** (features multi-dia, migrações, dívida técnica
  em lotes, monitoramento de PRs/CI);
- há **passagem de bastão** entre agentes ou entre agente e humano;
- o mesmo repositório é tocado por **sessões paralelas** (worktrees) que precisam de um ponto
  de sincronização;
- você precisa de **registro auditável** do que o agente decidiu e quando.

**NÃO aplique quando:**

- a tarefa nasce e morre numa sessão (pergunta, refactor pontual, exploração) — estado aqui é
  burocracia;
- o domínio ainda não tem forma (**debugging exploratório**: você não sabe o schema antes de
  entender o problema — anote em prosa, promova a estado só o que estabilizar);
- o objetivo é analisar a própria conversa (o alvo é o texto, não o estado).

## 3. Como funciona, em detalhe

### 3.1 O loop (do paper, §3)

A cada passo o agente opera com `(P, Σ, O)`:

- **P** — especificação imutável (o plano/regras em `spec` do Σ);
- **Σ** — o estado atual (`STATE.json`);
- **O** — a observação nova (o que a sessão acabou de fazer/descobrir).

E produz `(R, ΔΣ, a)`: raciocínio **R** (descartado — nunca volta ao prompt), patch **ΔΣ**
(a única coisa que sobrevive) e a próxima ação **a**. Complexidade: prompt O(1) por passo,
custo cumulativo O(T) — contra O(T²) do histórico conversacional.

```
 conversa (efêmera)              runtime determinístico            disco
┌───────────────────┐   ΔΣ    ┌──────────────────────────┐   ok  ┌──────────────┐
│ lê Σ → trabalha → │ ──────► │ parse → base_seq → ⊕ dry │ ────► │ STATE.json   │
│ propõe patch      │         │ → schema no RESULTADO →  │ +elo  │ patches.jsonl│
│                   │ ◄────── │ regras → grava atômico   │       └──────────────┘
└───────────────────┘ issues[]└──────────────────────────┘
      (retry ≤2)                 rejeição = nada muda
```

### 3.2 As duas zonas de autoridade do Σ (a parte mais importante)

O erro clássico de arquivos de estado é tratá-los como fatos. Aqui o schema separa:

- **`derivado_de_github`** — cache **carimbado** (`verificado_em`) do que vive numa fonte
  externa: sha da base, contagem de testes, fases×issues×PRs. **A fonte vence, sempre.**
  `verify` compara `main_sha` com a ref git configurada e marca `stale` — e o hook avisa a
  sessão para re-derivar antes de confiar. (O nome mantém `github` por compatibilidade com o
  contrato v1; a fonte pode ser qualquer tracker.)
- **`intencao`** — o que NENHUMA fonte externa sabe: `proximo_passo` (1 frase imperativa),
  `pendencias[]` e `bloqueios[]` (com `id` único), `avisos_operacionais[]`. Aqui o Σ é
  autoritativo.
- `spec` + `schema_version` — o **P imutável**; `meta` — zona exclusiva do runtime
  (`patch_seq`, `ultimo_hash`, `atualizado_em`). Patch que toque qualquer um → rejeitado.

### 3.3 O operador ⊕ (JSON Merge Patch RFC 7386, restrito)

Objeto = merge recursivo; `null` = deleta a chave; escalar = substitui; **array =
substituição atômica** (mande a lista inteira — sem append/índice, sem duplicação silenciosa).
Oito códigos de rejeição. No paper (§5.7, modelos menores) os erros foram 68% omissão/overwrite
de chaves, 20% tipo, 12% JSON malformado. Este kit defende o 68% no **merge** (chave omitida
não apaga — só `null` apaga) e, nas listas, com `large-replace` (>3 itens sumindo sem
`confirma-lista`). O 20%/12% são `type-mismatch` e `malformed`. `unknown-key` é outra falha
(typo virar chave-fantasma), não o 68%. Os demais códigos são do protocolo: `forbidden-key`,
`stale-base`, `invalid-seq`, `duplicate-id`. A validação roda sobre o **resultado** Σ⊕ΔΣ, não
só sobre o delta — deletar uma chave obrigatória também rejeita.
Spec completa: `references/patch-format.md`.

### 3.4 A trilha hash-encadeada (o que o paper não viu)

Cada patch vira uma linha de `patches.jsonl` com
`hash = sha256(prev_hash + envelope)`, genesis `"genesis"`. Três propriedades:

1. adulterar/remover/reordenar qualquer linha quebra a cadeia **no elo exato**;
2. `replay(patches.jsonl) == STATE.json` — editar o snapshot à mão é detectável;
3. o paper lista "tarefas cujo alvo é a trajetória (auditoria)" como limitação do método —
   a trilha inverte isso: **o log É a trajetória**, completa e verificável, sem nunca entrar
   no prompt. Em domínios regulados, é registro de auditoria de graça.

### 3.5 Os hooks (enforcement no Claude Code)

`cli.mjs context` é o comando de resume de **qualquer host**. No Claude Code o hook
SessionStart chama isso por você; noutros agentes, invoque no início da sessão.

- **SessionStart** (`startup|resume|compact`) → `cli.mjs context` injeta Σ resumido como
  `additionalContext`: próximo passo, bloqueios, pendências (top 5), avisos, e o alerta STALE.
  É a garantia forte: **depois de uma compactação, Σ volta inteiro** — a sessão não depende
  de o resumo da compactação ter preservado o que importa.
- **PreCompact** (`auto|manual`) → `cli.mjs flush-check` lembra de flushar ΔΣ pendente se o
  Σ está velho (>30 min). **Best-effort por construção**: PreCompact não injeta contexto nem
  bloqueia — a responsabilidade de flushar é do agente (está na SKILL.md).

### 3.6 Concorrência

Otimista, via `base_seq`: todo patch declara sobre qual `patch_seq` foi proposto; se o Σ
avançou, rejeita com `stale-base` e o agente relê e re-propõe. No mesmo working tree, `apply`
ainda serializa com lockfile (PID) + journal: dois processos não intercalam o jsonl; crash no
meio é completado no próximo `apply`/`verify`.

## 4. Instalação

O bloco no topo deste README é o caminho curto. O guia para seguir no terminal, inclusive
se algo falhar, está em `INSTALL.md` (`install --global` no computador, `install --project`
em cada pasta de trabalho).

O CLI mora **uma vez no computador** (`~/.claude/skills/skill-state/`, passo `install --global`).
O estado mora **em cada projeto** (`.skill-state/`, passo `install --project`).
`install --project` **não** copia o binário para `<repo>/.claude/skills/` — quem chama esse
caminho toma `MODULE_NOT_FOUND`, ou um `ls` com exit 2 se a pasta de estado ainda não existe.
Vendorizar a skill no repo é opcional e feito à mão; o instalador não faz isso.

Configuração opcional (ambiente): `SKILL_STATE_DIR` (pasta do estado; default `.skill-state`),
`SKILL_STATE_BASE_REF` (ref de staleness; default `origin/main`), `CLAUDE_PROJECT_DIR`
(raiz; default cwd). Vários fluxos no mesmo repo = vários diretórios, um `--dir` para cada.

## 5. Comandos

| Comando | Faz | Saída |
|---|---|---|
| `init [--domain dev\|ops\|pesquisa]` | cria dir de estado + schema do domínio; imprime genesis | texto |
| `apply --patch f.json\|- [--dry-run]` | valida e aplica (arquivo ou stdin) | `{ok:true,seq,hash}` ou `{ok:false,issues[]}` |
| `validate --patch f.json` | idem `apply --dry-run` | idem |
| `verify` | cadeia íntegra + `replay==STATE.json` + staleness vs ref base | `{ok,cadeia,replay_ok,stale,...}` |
| `archive [--keep N]` | recorta prefixo do log se verify verde (default keep 50) | `{ok,arquivados,ate_seq,artefato}` |
| `install --global` | skill + hooks/adapters nos hosts detectados (idempotente) | texto por host |
| `install --project` | `init` no cwd / `CLAUDE_PROJECT_DIR` | texto (schema + genesis) |
| `context` | Σ resumido para o resume de **qualquer host** (Claude Code: hook SessionStart) | `{hookSpecificOutput:{...}}` |
| `flush-check` | aviso de flush pendente (PreCompact) | texto ou nada |
| `selftest` | contrato do protocolo sobre `fixtures/` | 40 casos, exit 0/1 |

Todos aceitam `--dir <pasta>`. Exit codes: 0 sucesso, 1 rejeição/falha, 2 uso incorreto.

## 6. Vantagens

O que **este kit** (sidecar no host conversacional) garante:

- **Handoff executável** — sessão nova, lendo só o contexto injetado, responde "qual o
  próximo passo?". O hook SessionStart re-injeta Σ depois de compactar.
- **Estado que não mente calado** — carimbo `verificado_em` + `verify` contra a ref base +
  replay da cadeia: cache velho, edição à mão e log reescrito tornam-se detectáveis.
- **Recuperação de drift externo** — no paper (Tabela 3) histórico alucina 5–8 turnos;
  estado estruturado atualiza na hora. Aqui: `stale` vs a ref git e o primeiro patch da
  sessão é a re-derivação.
- **Auditoria de graça** — a trilha hash-encadeada registra quem mudou o quê, quando e por
  quê (`motivo`), verificável offline.

O que o **paper** mediu no *runtime deles* (Gemini, warehouse — **não** esta instalação):
prompt O(1), 16× menos tokens a 100 passos, 0.94 vs 0.74–0.88 a 200 passos; janela
deslizante 0.18 e compressão 0.22 vs estado 0.94. Este sidecar convive com o histórico do
host; o ganho que sobrevive é de qualidade (anti-envenenamento, drift), não custo O(1).
Ver limitação 5.

## 7. Limitações (honestas — leia antes de adotar)

1. **Σ precisa ser estatística suficiente.** O protocolo assume que tudo que importa para o
   futuro cabe no schema. Onde isso falha (exploração sem forma conhecida; observação cuja
   relevância só se revela depois e não foi projetada a tempo), o que não virou patch
   **se perde** — num histórico conversacional ainda estaria lá. Mitigação: a trilha de
   patches reduz o custo do erro, e prosa (handoff) continua permitida como narrativa.
2. **Authoring de schema custa.** Um schema por domínio, pensado (zonas, enums, ids). O
   template cobre "execução de desenvolvimento"; outros domínios exigem desenho.
3. **PreCompact é best-effort.** Se o agente não flushar e o contexto compactar, o ΔΣ da
   sessão corrente evapora — igual ao handoff manual esquecido. O SessionStart pós-compactação
   limita o dano (Σ anterior volta inteiro).
4. **Concorrência é otimista, não transacional.** `stale-base` resolve dois worktrees; não
   resolve N escritores de alta frequência nem merge semântico de intenções conflitantes.
5. **Economia real < economia nominal.** Com prompt caching, histórico append-only é barato
   de reprocessar; um Σ mutável invalida cache. O ganho que sobrevive é de **qualidade**
   (anti-envenenamento, recuperação de drift), mais que de custo bruto.
6. **Modelos pequenos erram edição de JSON** (68/20/12% no paper) — o schema fechado e o
   rollback existem exatamente por isso, mas com modelos fracos espere mais ciclos de retry.
7. **Schema pega forma, não intenção.** Um `proximo_passo` otimista ou uma deleção "limpando"
   contexto legítimo passam pela validação. Antídoto: revisão adversarial de patches suspeitos
   (>3 deleções, reescrita de listas inteiras) — regra na SKILL.md.
8. **O log quente não precisa crescer para sempre.** `archive --keep 50` (default 50) recorta
   o prefixo quando `verify` está verde, grava o trecho em `archive/prefix-<seq>.jsonl` com
   hash de continuidade, e o `verify` seguinte continua verde. Sem política mágica: o comando
   existe; o hábito (rodar de vez em quando) é seu.

## 8. Estrutura do kit

```
skill-state/
  SKILL.md                    # o protocolo para o agente (gatilhos, fluxo, regras duras)
  README.md                   # este arquivo
  INSTALL.md                  # instalação passo a passo
  references/patch-format.md  # spec formal do envelope e do ⊕
  bin/cli.mjs                 # runtime (init|context|flush-check|validate|apply|verify|archive|install|selftest)
  bin/install.mjs             # --global (hosts) e --project (init)
  bin/merge.mjs               # operador ⊕ puro
  bin/schema.mjs              # validador de subset de JSON Schema (zero deps)
  bin/chain.mjs               # cadeia SHA-256 (WebCrypto)
  bin/selftest.mjs            # roda os fixtures
  fixtures/                   # 20 arquivos — o CONTRATO executável do protocolo
  templates/                  # schema, genesis, snippet de hooks, adapters OpenCode/Phi
```

Os fixtures são deliberadamente parte do kit: qualquer reimplementação (ex.: uma versão
TypeScript tipada) deve passar **nos mesmos arquivos** — paridade por dados, não por código.

## 9. Origem e crédito

Protocolo do paper *SKILL.state: Scalable Long-Horizon Agent Skills* (arXiv:2608.26263).
Os endurecimentos desta implementação — schema fechado, `base_seq` otimista, trilha
hash-encadeada, validação sobre o resultado do merge, hooks de re-injeção — nasceram de
adoção em produção num monorepo real, onde o primeiro genesis flagrou a documentação de
estado do próprio projeto mentindo havia seis semanas. v1.1.0 (instalador `--global` /
`--project`). v1.1.1 (CLI canônico é o global; `install --project` não copia o binário).

Obrigado a [@tcconnally](https://github.com/tcconnally) pela [issue #1](https://github.com/JacksonFuck/skill-state/issues/1):
`apply` aceitava `seq` não-contíguo e só o `verify` acusava depois. O código `invalid-seq`,
a rejeição antes de gravar e os fixtures de contiguidade existem por esse relatório —
repro, expected e os cinco casos de teste vieram prontos.
