# Como instalar o skill-state

Três comandos no computador, um comando em cada projeto. Não precisa de `npm`.

**Você precisa:** Node 20 ou mais novo. Confira com:

```bash
node --version
```

Se aparecer `v20…` ou maior, siga. Se não tiver Node, instale em https://nodejs.org e volte aqui.

---

## No seu computador (uma vez)

Abra o terminal e cole, um de cada vez:

**1. Baixar**

```bash
git clone https://github.com/JacksonFuck/skill-state ~/.claude/skills/skill-state
```

**2. Testar**

```bash
node ~/.claude/skills/skill-state/bin/cli.mjs selftest
```

A última linha deve ser: `selftest: 39/39 verdes`. Se falhar, o Node está antigo ou o download quebrou — não continue.

**3. Ligar nos agentes**

```bash
node ~/.claude/skills/skill-state/bin/cli.mjs install --global
```

Isso liga o skill-state no Claude Code, Codex, Grok, OpenCode e Phi **se você já os tiver** no computador. Não apaga configuração antiga. Pode rodar de novo: o que já estiver ligado aparece como `já`.

Só no **Codex:** abra o Codex, digite `/hooks` e **aceite/confie** as duas linhas novas do skill-state. Sem isso o Codex não usa o estado.

Pronto para o computador. Os projetos ainda não têm estado — isso é o passo seguinte.

---

## Em cada projeto que você for usar

O estado mora **dentro da pasta do projeto**, não no skill. Sem isso, o agente não tem “próximo passo” daquela pasta.

```bash
cd pasta-do-seu-projeto
node ~/.claude/skills/skill-state/bin/cli.mjs install --project
```

O comando cria a pasta `.skill-state/` e **imprime um modelo JSON** (o genesis: o primeiro registro).

Peça ao agente, nessa mesma pasta:

> Preencha o genesis do skill-state com o estado real deste projeto (issues, git, o que falta) e aplique com `apply --patch -`. Depois rode `verify`.

Quando `verify` disser `"ok": true`, abra **uma sessão nova** do agente nessa pasta e pergunte:

> qual o próximo passo?

Se a resposta vier do que vocês gravaram, está instalado.

Para versionar o estado com o código (recomendado):

```bash
git add .skill-state
git commit -m "chore: estado inicial skill-state"
```

---

## Uso no dia a dia

- Trabalho de **várias sessões** ou passagem entre agentes: use o skill-state.
- Pergunta rápida de uma sessão: **não** crie estado.
- Quando um passo terminar, uma decisão for tomada ou aparecer um bloqueio, o agente deve **atualizar o estado** (não só escrever um HANDOFF.md).
- Frases que disparam a skill: “qual o próximo passo?”, “atualize o skill-state”, “handoff — grave o estado primeiro”.

O mesmo `.skill-state/` vale para Claude, Codex, Grok, OpenCode e Phi. O handoff é o arquivo, não a conversa.

**Grok:** se na primeira mensagem o próximo passo não aparecer sozinho, diga “rode o skill-state context”.

---

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| `selftest` falha | `node --version` ≥ 20; baixe de novo o clone |
| Agente não sabe o próximo passo | Você pulou o `--project` ou o genesis nesta pasta? |
| Codex ignora o estado | `/hooks` → confiar as linhas skill-state |
| Grok não injeta sozinho | Peça `context` na primeira mensagem |
| Medo de ter estragado config | O instalador não apaga hooks antigos. Cópias em `~/.skill-state-host-install-backup/` |

Comando único se o automático falhar, **dentro da pasta do projeto**:

```bash
node ~/.claude/skills/skill-state/bin/cli.mjs context
```

---

## Desinstalar

Apague o atalho `skill-state` em cada pasta `skills` dos agentes, as linhas de hook que citam `skill-state/bin/cli.mjs`, o arquivo `~/.config/opencode/plugins/skill-state.js`, `~/.phi/agent/extensions/skill-state.ts`, e (se quiser) a pasta `.skill-state` de cada projeto.

---

## Para quem já sabe (opcional)

Instalação na mão, snippet de hooks e adapters: o instalador `--global` já faz isso. Os JSON de hook estão em `templates/hooks.snippet.json`. OpenCode e Phi usam `templates/hosts/`.

Vários fluxos no mesmo repo: `install --project --dir .skill-state/nome`. Ref git diferente de `origin/main`: `SKILL_STATE_BASE_REF`.
