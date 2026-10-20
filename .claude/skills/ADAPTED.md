# OzyComp — Adapted Skills

Profil ve proje-scoped skill bağlamaları. İlk profil: 2026-10-20.

## Repo profili

| Alan | Değer |
|------|-------|
| Dil | JavaScript (CommonJS, `'use strict'`) — TypeScript yok |
| Runtime | Node 26 (test/headless), Electron 20 (app) |
| Paket yöneticisi | npm — **runtime deps sadece `node-pty`**; zero-dep ilkesi (UI vendored/minified) |
| Build | `electron-builder` → mac `[dmg,zip]`, win `[nsis,zip]`, linux `[AppImage,deb]` |
| Test | `node --test test/*.test.js` — `test/core.test.js`, `test/v2.test.js` |
| Test seam | `test/helpers.js` — `Module._load` electron stub (`fakeElectron`) |
| Lint/CI | yok — stil = dosya içi tutarlılık |

## Komutlar (gerçek)

- **Test**: `npm test` → `node --test test/*.test.js`
  - Tek dosya: `node --test test/core.test.js`
  - Süre: tam suit ~2-3 dk (git commit zincirleri + pty spawn'ları gerçek)
- **Dev**: `npm run dev` → `env -u ELECTRON_RUN_AS_NODE electron .`
- **Smoke**: `npm run smoke` → `OZYC_SMOKE=1 electron .`
- **Build**: `npm run build` → `electron-builder`

## Kritik proje kuralları

- **Verbatim referans**: `~/.rea/targets/munder-difflin-asar/extracted/out/main/index.js` — davranış birebir; alıntı `ref ~LINE`.
- **Rename**: her şey **OzyComp**. `OZYC_*` env, `~/.ozycomp`, `ozycomp:` scheme, `ozycomp.app`, `bin/ozy-hook.js`, appData `ozycomp`. **`MD_*` env'lerine DOKUNMA** (wire protocol). MathML `munder` tokenlerine dokunma.
- **Zero-dep**: runtime'a npm paketi ekleme; UI `src/renderer/assets/` vendored.
- **Türkçe**: kullanıcıya görünen her metin Türkçe; kod/yol/API adları özgün.
- **Roster**: `company/roster.json` → 316 agent seed (`{{companyRoot}}`/`{{claudeHome}}` placeholder). Seed `agents/<id>/inbox|outbox|memory.md` **oluşturmalı** yoksa `deliver()` bounce→god loop.
- **node-pty**: `/dev/ptmx` çalışıyor; `zsh -l` SIGTERM'i yok sayar → kill yolunda `proc.destroy()` şart.
- **Electron-free test**: `src/main/*` plain Node — electron'a `require` ederse `helpers.js` stub'ı veya try/catch.
- Git commit `Co-Authored-By: Claude Code <noreply@anthropic.com>`; PR `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Adapted skills (proje-scoped)

- `ozycomp-testing` — test skill'i: node --test + helpers stub + git/pty cleanup disiplini.
- `ozycomp-verbatim-port` — referans birebir port + rename haritası disiplini.

Adapted kopyalar `.claude/skills/<ad>/SKILL.md` altında; base skill'ler değiştirilmedi.
