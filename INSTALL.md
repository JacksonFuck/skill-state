# skill-state — instalação

Requisitos: **Node ≥ 20** (WebCrypto global). Sem `npm install` — zero dependências.
Git é opcional (habilita só a detecção de staleness contra a ref base).

Há dois modos, e o instalador cobre os dois. Nos dois, o pacote é a MESMA pasta —
só muda onde ela mora e onde os hooks são declarados. O estado (`.skill-state/`) é
**sempre por projeto**.

| | **No projeto** (recomendado p/ times) | **Global** (todos os seus projetos) |
|---|---|---|
| Skill | `<repo>/.claude/skills/skill-state/` | `~/.claude/skills/skill-state/` (e os outros hosts) |
| Hooks | `<repo>/.claude/settings.json` | settings/hooks de cada host |
| Versionada com o código? | sim (commit) | não |
| Estado (`.skill-state/`) | sempre por projeto, nos dois modos | idem |

```bash
# 1. obter o kit (uma vez)
git clone https://github.com/JacksonFuck/skill-state ~/.claude/skills/skill-state
# ou trabalhe a partir de um checkout qualquer — o --global faz o symlink

# 2. selftest
node ~/.claude/skills/skill-state/bin/cli.mjs selftest    # 39/39 verdes

# 3. ligar skill + hooks em todo host detectado (Claude, Codex, Grok, OpenCode, Phi)
#    idempotente; não apaga hooks já existentes (jcode, dream, etc.)
node ~/.claude/skills/skill-state/bin/cli.mjs install --global

# 4. por projeto: schema + template de genesis (não inventa o Σ)
cd <repo>
node ~/.claude/skills/skill-state/bin/cli.mjs install --project
# opcional: --domain ops|pesquisa

# 5. preencha o genesis impresso (fatos da fonte, não da memória) e aplique:
node ~/.claude/skills/skill-state/bin/cli.mjs apply --patch - <<'EOF'
{ ...genesis... }
EOF
node ~/.claude/skills/skill-state/bin/cli.mjs verify
```

`--global` detecta o que existe em `$HOME` (`.claude`, `.codex`, `.grok`, `.opencode` /
`.config/opencode`, `.phi/agent`). Host ausente = pulado. Rode de novo à vontade:
já ligado permanece, nada duplica.

O hook global roda em TODO projeto, mas é inofensivo onde não há estado: sem
`.skill-state/STATE.json`, `context` e `flush-check` saem em silêncio.

**Codex:** depois do `--global`, abra `/hooks` e **confie** as entradas `skill-state`.
Hooks novos não rodam até isso. **Grok:** a skill precisa do symlink em `~/.grok/skills`
(o config padrão ignora `~/.claude/skills`); o SessionStart pode ignorar stdout — se o
`PRÓXIMO PASSO` não aparecer sozinho, peça `context`.

Estado fora do default `.skill-state/`? `install --project --dir <pasta>`, ou exporte
`SKILL_STATE_DIR`. Ref base diferente de `origin/main`? Exporte `SKILL_STATE_BASE_REF`.

## Passo a passo manual (se não quiser o instalador)

Via git:

```bash
# no projeto:
git clone https://github.com/JacksonFuck/skill-state <repo>/.claude/skills/skill-state
rm -rf <repo>/.claude/skills/skill-state/.git   # opcional: destacar do repo de origem

# global:
git clone https://github.com/JacksonFuck/skill-state ~/.claude/skills/skill-state
```

Ou via ZIP (release): descompacte e mova a pasta `skill-state/` para o destino acima.

Cole as chaves `SessionStart` e `PreCompact` de `templates/hooks.snippet.json` **dentro**
do objeto `hooks` do settings correspondente, preservando hooks já existentes.

**No projeto** (`<repo>/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|compact",
        "hooks": [ { "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/skills/skill-state/bin/cli.mjs\" context" } ] }
    ],
    "PreCompact": [
      { "matcher": "auto|manual",
        "hooks": [ { "type": "command",
          "command": "node \"${CLAUDE_PROJECT_DIR:-.}/.claude/skills/skill-state/bin/cli.mjs\" flush-check" } ] }
    ]
  }
}
```

**Global** (`~/.claude/settings.json`) — troque o caminho do script nos dois comandos por:

```
node "$HOME/.claude/skills/skill-state/bin/cli.mjs" context
node "$HOME/.claude/skills/skill-state/bin/cli.mjs" flush-check
```

Os adapters de OpenCode e Phi (não têm `hooks.json` Claude-style) estão em
`templates/hosts/` e o `--global` os copia.

## Smoke test

```bash
echo '{}' | node ~/.claude/skills/skill-state/bin/cli.mjs context
# com Σ: JSON {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
# sem Σ: silêncio, exit 0
```

Abra uma sessão nova no projeto e pergunte **"qual o próximo passo?"** sem abrir arquivo
algum. Se a resposta vier do Σ, a instalação está completa.

## Recomendado: versionar o estado

Commite `.skill-state/` (os 3 arquivos) no repositório do projeto — o estado viaja com o
código, e o diff de `STATE.json`/`patches.jsonl` em cada PR mostra o que a sessão decidiu.

## Desinstalar

Remova o symlink `skill-state/` de cada `*/skills/`, as chaves de hook cujo comando contém
`skill-state/bin/cli.mjs`, o plugin `~/.config/opencode/plugins/skill-state.js`, a extensão
`~/.phi/agent/extensions/skill-state.ts`, e (se quiser) a pasta de estado de cada projeto.
Nada mais é tocado. Backups do instalador ficam em `~/.skill-state-host-install-backup/`.
