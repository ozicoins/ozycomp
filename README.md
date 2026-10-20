# OzyComp

Yerel çalışan çoklu-agent harness'i: CLI kodlama agent'ları (Claude Code, Codex, Gemini, Grok, opencode, Cursor, Devin…) node-pty içinde çalışır ve dosya tabanlı bir "hive" üzerinden koordine edilir. Munder Difflin 0.5.5'in mimarisi REA ile çözümlendi; OzyComp o mimariyi birebir (verbatim) yeniden kuruyor — davranış aynı, ad ve yollar OzyComp.

## Çalıştırma

```bash
npm install
npm test          # headless çekirdek testleri (Electron gerekmez, ~2-3 dk)
npm run smoke     # Electron'u açar, shell agent başlatır, gidiş-dönüşü doğrular, kapanır
npm start         # uygulama
npm run build     # electron-builder → mac dmg/zip, win nsis/zip, linux AppImage/deb
```

> VSCode terminalinde `ELECTRON_RUN_AS_NODE=1` tanımlı olur ve Electron düz Node gibi açılır (`app` tanımsız olur). `start`/`dev`/`smoke` script'leri bu değişkeni temizler.

## Mimari: 5 düzlem

| Düzlem | Dosya | Orijinaldeki karşılığı |
|---|---|---|
| Terminal | `src/main/pty-manager.js` | `PtyManager`, `PtySubmitter.typeAndSubmit` (submit-proof) |
| Hook kontrolü | `src/main/hook-server.js`, `bin/ozy-hook.js` | `HookServer` (Unix soket + loopback HTTP, Bearer), `OpenQuestionTracker`, `WorkerWakeWatchdog` |
| Hive dosyaları | `src/main/hive.js` | `HiveManager`: registry.json / tasks.json / board.md / log.jsonl / cost-ledger.jsonl, outbox→inbox yönlendirici |
| Denetleyici | `src/main/circuit-breaker.js` | `CircuitBreaker`: healthy→steering→constrained→stopped, compact grace |
| Orkestrasyon | `src/main/harness.js`, `src/main/providers.js` | god agent istemi, 15 sağlayıcı kayıt defteri |

Electron katmanı: `src/main/electron-main.js` (BrowserWindow + `cth:*` IPC, gönderen doğrulamalı), `src/preload/index.js` (`window.cth` köprüsü), `src/renderer/` (Ofis / Görevler / Pano görünümleri + terminal çekmecesi).

## Varsayılan şirket

`company/` altında **Patron Şirketi** — 316 kişilik hazır kadro (`company/roster.json`, `organization.json`, `profiles/*.md`, `skill-catalog-tr.json`). İlk `ensure()` çağrısında hive'a seed edilir: `god` + 315 `archived` agent kaydı ve her id için `agents/<id>/inbox|outbox|memory.md` dizinleri. `{{companyRoot}}`/`{{claudeHome}}` placeholder'ları seed anında çözülür.

## Sağlayıcılar

15 preset: `claude`, `codex`, `grok`, `kimi`, `gemini`, `antigravity`, `qwen`, `opencode`, `crush`, `pi`, `copilot`, `cursor`, `devin`, `shell`, `custom`. Her preset `installCommand`/`nativeInstallCommand` taşır; tek-tık kurulum `pty:installCli` IPC'si üzerinden çalışır.

## Hive düzeni (`~/.ozycomp/hive`)

```
registry.json            agent kaydı (godId: "god")
tasks.json               kanban: todo | doing | blocked | done
board.md                 ortak plan; yalnızca god yazabilir
log.jsonl                tüm olaylar (route, hook, submit, wake-nudge)
cost-ledger.jsonl        maliyet satırları
roster-archive.json      seed edilen kadro arşivi
agents/<id>/inbox/       gelen JSON zarfları {from,to,act,body}
agents/<id>/outbox/      giden zarflar; yönlendirici alıcının inbox'ına taşır
agents/<id>/memory.md    kalıcı agent hafızası
hook-token               loopback HTTP için Bearer token (0600)
.hooks.sock              hook Unix soketi (0600)
```

Agent'ların her biri `~/.ozycomp/workspaces/<id>/` içinde izole çalışır. Bu dizine `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` bağlam dosyaları, hive'daki `memory.md` dosyasına bir symlink ve Claude için `.claude/settings.local.json` hook ayarları yazılır.

## Lisans

Pro entitlement `src/main/license.js` — `MDS-XXXXX-XXXXX-XXXXX` formatlı key'ler, ed25519 cihaz anahtarı, 15/60 dk'lık uyarlanabilir recheck döngüsü (14 güne kadar çevrimdışı Pro). Sunucu `OZYC_LICENCE_ORIGIN ?? https://harnessmd.com`. Dev override: `OZYC_DEV_PRO=1` (paketlenmemiş çalıştırmada).

## Ortam değişkenleri

`OZYC_*` öneki (bkz. `ozycomp-verbatim-port` skill'i): `OZYC_HIVE`, `OZYC_AGENT_ID`, `OZYC_HOOK_SOCK/URL/TOKEN/SHIM`, `OZYC_SMOKE`, `OZYC_RELAY_DEV`, `OZYC_LICENSE_PUBKEY`, `OZYC_NO_GOD`, `OZYC_DEV_PRO`, `OZYC_LICENCE_ORIGIN`, `OZYC_COMPANY_DIR`. **`MD_*` değişkenleri broker/floor wire protocol'dür — kasıtlı olarak dokunulmaz.**

## Kapsam

Terminal, hook, hive, devre kesici, 15 sağlayıcı, god agent, Ofis/Görevler/Pano arayüzü, memory.md — ve v2 düzlemleri: Slack/webhook köprüleri, OTLP telemetri, sesli mod (transcribe), Knowledge Graph (`kg.js`/`kg-core.cjs`), MemPalace, temps, çoklu kat (`floors.js`), Teams/relay (`relay.js`, `integration-broker.js`), lisans/Pro (`license.js`), i18n (tr/en/zh-CN/ar), skill pazaryeri (`mcp-catalog.js`, `skills/`).
