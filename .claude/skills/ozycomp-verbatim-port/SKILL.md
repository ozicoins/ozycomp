---
name: ozycomp-verbatim-port
description: Referans bundle'dan OzyComp'e birebir port — davranış aynı, sadece OzyComp rename. Ref'ten kod taşırken/diff yaparken kullan.
---

# OzyComp Verbatim Port

Referans: `~/.rea/targets/munder-difflin-asar/extracted/out/main/index.js` (~38048 satır). Davranış **%100 aynı**; tek fark OzyComp rename'i. Satır `ref ~N` ile anılır.

## Rename haritası (uygula)

| ref | burada |
|-----|--------|
| `MUNDER_*` | `OZYC_*` (OZYC_HIVE, OZYC_AGENT_ID, OZYC_HOOK_SOCK/URL/TOKEN/SHIM, OZYC_SMOKE, OZYC_RELAY_DEV, OZYC_LICENSE_PUBKEY, OZYC_NO_GOD, OZYC_DEV_PRO, OZYC_LICENCE_ORIGIN, OZYC_COMPANY_DIR) |
| `~/.munder` | `~/.ozycomp` |
| `.munder/hook-shim.json` | `.ozycomp/hook-shim.json` |
| `bin/munder-hook.js` | `bin/ozy-hook.js` |
| `munder-difflin` (appData, MCP ns `munder-<id>`) | `ozycomp` (`ozycomp-<id>`) |
| `munderdifflin:` scheme | `ozycomp:` |
| `munderdiffl.in` | `ozycomp.app` |
| `Munder Difflin` / `MUNDER DIFFLIN` | `OzyComp` / `OZYCOMP` |
| `@MunderDifflin`, `Munder-Difflin-${v}-*.dmg` | `@OzyComp`, `OzyComp-${v}-*.dmg` |

## DOKUNMA (kasıtlı)

- **`MD_*` env** — broker/floor wire protocol; renderer bekliyor.
- **MathML `munder`/`munderover`** tokenleri (ts.worker) — dilbilgisi.
- `license.js` `LICENSE_PREFIX="MDS"` — referans key formatı (MDS-XXXXX-XXXXX-XXXXX).

## Port disiplini

- Davranışı değiştirme — sadece isim/yol/etiket. Zamanlama, hata dizgisi, dönüş şekli birebir.
- `verbatim ~N` yorumu ile kaynağı işaretle.
- UI: `src/renderer/assets/index-*.js`/`global-*.js` minified — string patch, yeniden build yok.
- Doğrula: `grep -ri 'munder\|difflin' src company resources` → sadece yukarıdaki DOKUNMA kalıntıları çıkmalı.
