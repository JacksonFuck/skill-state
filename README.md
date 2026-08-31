# skill-state v1.0.0 — estado de execução explícito para agentes

> Kit portátil do protocolo **SKILL.state** (Badhe, Tiwari & Chung, arXiv:2608.26263,
> ago/2026), endurecido em uso real e generalizado para qualquer repositório.
> **Zero dependências npm. Requer Node ≥ 20** (usa WebCrypto global). Git é
> opcional (só para detecção de staleness).
>
> Este README é escrito para **agentes** (Claude Code ou similar) e para os humanos que os
> supervisionam. Leia inteiro uma vez; depois, o dia-a-dia é a `SKILL.md`.

---

## 1. O problema que isto resolve

Agentes que trabalham em tarefas de longo horizonte guardam "onde paramos" de dois jeitos
ruins:

1. **Na conversa** — que compacta (perde), cresce O(T²) em custo, e envenena decisões: fatos
   obsoletos no histórico "vencem" observações novas (no paper, agentes com histórico levam
   5–14 turnos alucinando até aceitar que o mundo mudou).
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
Sete códigos de rejeição, mapeados na taxonomia de erros que o paper mediu em modelos menores
(68% sobrescrita acidental / 20% tipo / 12% JSON malformado) mais os do protocolo:
`unknown-key`, `type-mismatch`, `malformed`, `forbidden-key`, `stale-base`, `invalid-seq`,
`duplicate-id`. A validação roda sobre o
**resultado** Σ⊕ΔΣ, não só sobre o delta — deletar uma chave obrigatória também rejeita.
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

- **SessionStart** (`startup|resume|compact`) → `cli.mjs context` injeta Σ resumido como
  `additionalContext`: próximo passo, bloqueios, pendências (top 5), avisos, e o alerta STALE.
  É a garantia forte: **depois de uma compactação, Σ volta inteiro** — a sessão não depende
  de o resumo da compactação ter preservado o que importa.
- **PreCompact** (`auto|manual`) → `cli.mjs flush-check` lembra de flushar ΔΣ pendente se o
  Σ está velho (>30 min). **Best-effort por construção**: PreCompact não injeta contexto nem
  bloqueia — a responsabilidade de flushar é do agente (está na SKILL.md).

### 3.6 Concorrência

Otimista, via `base_seq`: todo patch declara sobre qual `patch_seq` foi proposto; se o Σ
avançou, rejeita com `stale-base` e o agente relê e re-propõe. Suficiente para worktrees
paralelos no mesmo repo; NÃO é para escrita concorrente de alta frequência (ver limitações).

## 4. Instalação (resumo — passo a passo e modo global em `INSTALL.md`)

Dois modos, mesma pasta: **no projeto** (`<repo>/.claude/skills/skill-state/`, versionada com
o código) ou **global** (`~/.claude/skills/skill-state/`, vale para todos os seus projetos).
O estado (`.skill-state/`) é sempre por projeto.

```bash
# 1. obtenha a pasta (git clone ou unzip do release) no destino escolhido
git clone https://github.com/JacksonFuck/skill-state <repo>/.claude/skills/skill-state   # projeto
git clone https://github.com/JacksonFuck/skill-state ~/.claude/skills/skill-state        # global

# 2. selftest (prova que o runtime funciona nesta máquina)
node <destino>/skill-state/bin/cli.mjs selftest                    # → 13/13 verdes

# 3. hooks: cole templates/hooks.snippet.json no objeto "hooks" do settings.json
#    (do projeto ou o global ~/.claude/settings.json — ver INSTALL.md)

# 4. estado inicial, por projeto
cd <repo> && node <destino>/skill-state/bin/cli.mjs init           # cria .skill-state/ + schema
#    preencha o genesis impresso, salve em /tmp/genesis.json e:
node <destino>/skill-state/bin/cli.mjs apply --patch /tmp/genesis.json
node <destino>/skill-state/bin/cli.mjs verify                      # ok, replay_ok
```

Configuração opcional (ambiente): `SKILL_STATE_DIR` (pasta do estado; default `.skill-state`),
`SKILL_STATE_BASE_REF` (ref de staleness; default `origin/main`), `CLAUDE_PROJECT_DIR`
(raiz; default cwd). Vários fluxos no mesmo repo = vários diretórios, um `--dir` para cada.

## 5. Comandos

| Comando | Faz | Saída |
|---|---|---|
| `init` | cria dir de estado + schema do template; imprime genesis a preencher | texto |
| `apply --patch f.json [--dry-run]` | valida e aplica (ou só simula) | `{ok:true,seq,hash}` ou `{ok:false,issues[]}` |
| `validate --patch f.json` | idem `apply --dry-run` | idem |
| `verify` | cadeia íntegra + `replay==STATE.json` + staleness vs ref base | `{ok,cadeia,replay_ok,stale,...}` |
| `context` | JSON de hook SessionStart com Σ resumido | `{hookSpecificOutput:{...}}` |
| `flush-check` | aviso de flush pendente (PreCompact) | texto ou nada |
| `selftest` | contrato do protocolo sobre `fixtures/` | 13 casos, exit 0/1 |

Todos aceitam `--dir <pasta>`. Exit codes: 0 sucesso, 1 rejeição/falha, 2 uso incorreto.

## 6. Vantagens

- **Prompt O(1), custo O(T)** — no paper, 16× menos tokens a 100 passos, 0.94 de acurácia
  contra 0.74–0.88 dos baselines a 200 passos (benchmark dos próprios autores — trate os
  números como direção, não como promessa).
- **Recuperação imediata de drift externo** — quando o mundo muda por fora do loop, quem
  decide pelo estado atual não fica preso a fatos velhos do histórico (0 turnos de recuperação
  vs 5–14). É o resultado mais transferível do paper.
- **Estrutura > compressão** — com o MESMO orçamento de tokens, janela deslizante marca 0.18
  e compressão estatística 0.22; estado estruturado, 0.94. Resumir não substitui estruturar.
- **Estado que não mente calado** — carimbo `verificado_em` + `verify` contra a ref base +
  replay da cadeia: as três mentiras clássicas de arquivos de estado (cache velho, edição à
  mão, log reescrito) tornam-se detectáveis mecanicamente.
- **Auditoria de graça** — a trilha hash-encadeada registra quem mudou o quê, quando e por
  quê (`motivo`), verificável offline.
- **Handoff executável** — o teste de aceitação ("sessão nova responde 'qual o próximo
  passo?' só com o contexto injetado") deixa de ser disciplina e vira comportamento do hook.

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
8. **O log cresce para sempre** se ninguém o arquivar. Política sugerida: a cada ~50 patches,
   `verify` verde → arquivar o trecho antigo com o hash de continuidade (não implementado
   nesta versão; mantenha o hábito manualmente).

## 8. Estrutura do kit

```
skill-state/
  SKILL.md                    # o protocolo para o agente (gatilhos, fluxo, regras duras)
  README.md                   # este arquivo
  INSTALL.md                  # instalação passo a passo
  references/patch-format.md  # spec formal do envelope e do ⊕
  bin/cli.mjs                 # runtime (init|context|flush-check|validate|apply|verify|selftest)
  bin/merge.mjs               # operador ⊕ puro
  bin/schema.mjs              # validador de subset de JSON Schema (zero deps)
  bin/chain.mjs               # cadeia SHA-256 (WebCrypto)
  bin/selftest.mjs            # roda os fixtures
  fixtures/                   # 11 arquivos — o CONTRATO executável do protocolo
  templates/                  # schema inicial, genesis, snippet de hooks
```

Os fixtures são deliberadamente parte do kit: qualquer reimplementação (ex.: uma versão
TypeScript tipada) deve passar **nos mesmos arquivos** — paridade por dados, não por código.

## 9. Origem e crédito

Protocolo do paper *SKILL.state: Scalable Long-Horizon Agent Skills* (arXiv:2608.26263).
Os endurecimentos desta implementação — schema fechado, `base_seq` otimista, trilha
hash-encadeada, validação sobre o resultado do merge, hooks de re-injeção — nasceram de
adoção em produção num monorepo real, onde o primeiro genesis flagrou a documentação de
estado do próprio projeto mentindo havia seis semanas. v1.0.0.

Obrigado a [@tcconnally](https://github.com/tcconnally) pela [issue #1](https://github.com/JacksonFuck/skill-state/issues/1):
`apply` aceitava `seq` não-contíguo e só o `verify` acusava depois. O código `invalid-seq`,
a rejeição antes de gravar e os fixtures de contiguidade existem por esse relatório —
repro, expected e os cinco casos de teste vieram prontos.
