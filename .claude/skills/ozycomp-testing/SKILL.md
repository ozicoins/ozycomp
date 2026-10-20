---
name: ozycomp-testing
description: OzyComp test disiplini — node --test + electron stub + git/pty handle cleanup. Yeni test yazarken veya test takılması/debug'da kullan.
---

# OzyComp Testing

`node --test test/*.test.js` — `core.test.js` + `v2.test.js`. Tam suit ~2-3 dk (gerçek git + pty).

## Proje bağlamaları

- **Electron-free**: `src/main/*` plain Node. Electron'a bağımlı modüller `test/helpers.js` → `fakeElectron(overrides)` stub'ı üzerinden test edilir (`Module._load` intercept). Yeni modül electron `require` ediyorsa stub'a handler ekle.
- **tmp dirs**: `fs.mkdtempSync(path.join(os.tmpdir(), 'ozycomp-test-'))` — her test izole.
- **Cleanup şart**: açtığın her kaynak `finally` içinde kapanır:
  - `HookServer` → `await hs.stop()` (uds + httpd 2 listener)
  - `HiveManager` → commit kuyruğu git spawn eder; test `h.dropCommits(2e3)` + `dropAllCommitQueues(2e3)` ile bağlantısız kuyruğu da düşürmeli (instance'a bağlı olmayan `liveCommitQueues`).
  - `Harness` → `await h.stop()`
  - `PtyManager` → `dispose()`; `zsh -l` SIGTERM'i yok sayar → `proc.destroy()` zaten kill path'te.
  - `WebhookServer`/`TelemetryCollector`/`slack-servers`/`file-share`/`integration-broker` → kendi `.stop()`/`server.close()`.
- **Takılma tanısı**: worker referenced handle bulursa `lsof -p <workerPid>` → LISTEN socketler kapanmamış `createServer` demektir; `_getActiveHandles()` ile `x.constructor.name` + `x.spawnargs`/`x.localPort` gör.

## Yapma

- `spawnSync`/blocking exec test içinde server'ı bloklar — async `spawn` + `cp.on('exit')`.
- `setTimeout`/`setInterval` referenced bırakma → `.unref()` veya `finally` clear.
- `MD_*` env'leri wire protocol — testte de rename etme.
