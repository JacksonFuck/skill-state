# skill-state — instalação

Requisitos: **Node ≥ 20** (WebCrypto global). Sem `npm install` — zero dependências.
Git é opcional (habilita só a detecção de staleness contra a ref base).

Há dois modos. Nos dois, o pacote é a MESMA pasta — só muda onde ela mora e onde os hooks
são declarados:

| | **No projeto** (recomendado p/ times) | **Global** (todos os seus projetos) |
|---|---|---|
| Skill | `<repo>/.claude/skills/skill-state/` | `~/.claude/skills/skill-state/` |
| Hooks | `<repo>/.claude/settings.json` | `~/.claude/settings.json` |
| Versionada com o código? | sim (commit) | não |
| Estado (`.skill-state/`) | sempre por projeto, nos dois modos | idem |

## Passo 1 — Obter a pasta

Via git:

```bash
# no projeto:
git clone https://github.com/JacksonFuck/skill-state <repo>/.claude/skills/skill-state
rm -rf <repo>/.claude/skills/skill-state/.git   # opcional: destacar do repo de origem

# global:
git clone https://github.com/JacksonFuck/skill-state ~/.claude/skills/skill-state
```

Ou via ZIP (release): descompacte e mova a pasta `skill-state/` para o destino acima.

O Claude Code descobre a skill pelo `SKILL.md` automaticamente na próxima sessão — tanto em
`.claude/skills/` do projeto quanto em `~/.claude/skills/`.

## Passo 2 — Selftest (prova o runtime nesta máquina)

```bash
node <destino>/skill-state/bin/cli.mjs selftest
# esperado: 20 casos ✓ e "selftest: 20/20 verdes"
```

Se falhar aqui, nada mais vale — confira a versão do Node (`node --version` ≥ 20).

## Passo 3 — Ligar os hooks

Cole as chaves `SessionStart` e `PreCompact` de `templates/hooks.snippet.json` **dentro** do
objeto `hooks` do settings correspondente, preservando hooks já existentes:

**No projeto** (`<repo>/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|compact",
        "hooks": [ { "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/skills/skill-state/bin/cli.mjs\" context 2>/dev/null || true" } ] }
    ],
    "PreCompact": [
      { "matcher": "auto|manual",
        "hooks": [ { "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/skills/skill-state/bin/cli.mjs\" flush-check 2>/dev/null || true" } ] }
    ]
  }
}
```

**Global** (`~/.claude/settings.json`) — troque o caminho do script nos dois comandos por:

```
node "$HOME/.claude/skills/skill-state/bin/cli.mjs" context 2>/dev/null || true
node "$HOME/.claude/skills/skill-state/bin/cli.mjs" flush-check 2>/dev/null || true
```

O hook global roda em TODO projeto, mas é inofensivo onde não há estado: sem
`.skill-state/STATE.json` no projeto, `context` e `flush-check` saem em silêncio.

Estado fora do default `.skill-state/`? Acrescente `--dir <pasta>` aos comandos, ou exporte
`SKILL_STATE_DIR` no ambiente do projeto. Ref base diferente de `origin/main` (ex.:
`origin/master`)? Exporte `SKILL_STATE_BASE_REF`.

## Passo 4 — Estado inicial (genesis), por projeto

```bash
cd <repo>
node <destino>/skill-state/bin/cli.mjs init
# cria .skill-state/STATE.schema.json (do template) e imprime o genesis a preencher
```

1. (Opcional, recomendado) Edite `.skill-state/STATE.schema.json` para o seu domínio —
   mantenha as 4 zonas (`spec`, `derivado_de_github`, `intencao`, `meta`) e
   `additionalProperties: false` em todo objeto.
2. Preencha o template de genesis impresso — **re-derive os valores da fonte de verdade**
   (issues/PRs/CI reais, não da memória) — e salve em `/tmp/genesis.json`.
3. Aplique e confira:

```bash
node <destino>/skill-state/bin/cli.mjs apply --patch /tmp/genesis.json
node <destino>/skill-state/bin/cli.mjs verify    # {"ok":true,...,"replay_ok":true}
```

## Passo 5 — Smoke test do hook

```bash
echo '{}' | node <destino>/skill-state/bin/cli.mjs context
# esperado: JSON {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
```

Abra uma sessão nova do Claude Code no projeto e pergunte **"qual o próximo passo?"** sem
abrir arquivo algum. Se a resposta vier do Σ, a instalação está completa.

## Recomendado: versionar o estado

Commite `.skill-state/` (os 3 arquivos) no repositório do projeto — o estado viaja com o
código, e o diff de `STATE.json`/`patches.jsonl` em cada PR mostra o que a sessão decidiu.

## Desinstalar

Remova a pasta `skill-state/` do destino, as duas chaves de hook do settings correspondente
e (se quiser) a pasta de estado de cada projeto. Nada mais é tocado.
