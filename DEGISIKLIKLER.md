# Değişiklikler

Bu dosya, projede yapılan tüm değişiklikleri kronolojik olarak içerir.

## 2026-10-21

### Free Trial Signin Ekranı Kaldırıldı
- **Dosya**: `src/renderer/assets/index-CYoBaPLy.js`
- **Değişiklik**: Free trial signin ekranı ("Devam etmek için oturum açın") devre dışı bırakıldı
- **Kullanıcı isteği**: "kontrol olmasın"
- **Detaylar**:
  - Line 113024-113027: Free trial kontrolü yorum satırı yapıldı
  - Line 113028-113033: Onboarding kontrolü yorum satırı yapıldı
  - Line 113034-113036: Hive picker kontrolü yorum satırı yapıldı
  - Line 13951-13968: onboardingComplete kontrolü kaldırıldı, hiveRegistry çağrısı her zaman çalışıyor
  - Line 14017-14068: onboardingComplete kontrolü kaldırıldı, god spawning her zaman çalışıyor
  - Line 14248-14288: onboardingComplete kontrolleri kaldırıldı
  - Line 14276-14332: onboardingComplete kontrolleri kaldırıldı
  - Line 14475-14588: onboardingComplete kontrolleri kaldırıldı
  - Line 83239-83273: onboardingComplete kontrolü kaldırıldı
  - Line 113007-113046: onboardingComplete kontrolleri kaldırıldı

### Ajanları Hive Registry'den UseStore'a Yükleme
- **Dosya**: `src/renderer/assets/index-CYoBaPLy.js`
- **Değişiklik**: Hive registry'den ajanları useStore'a yükleyen kod eklendi
- **Detaylar**:
  - Line 13966-14013: Hive registry'den ajanları yükleyen kod eklendi
  - Archived ve active ajanlar ayrı ayrı yükleniyor
  - Console log eklendi: `[hive-registry] loaded agents: X`

### UseHive Hook'u OnboardingComplete'den Bağımsız Hale Getirildi
- **Dosya**: `src/renderer/assets/index-CYoBaPLy.js`
- **Değişiklik**: useHive çağrısı onboardingComplete'den bağımsız hale getirildi
- **Detaylar**:
  - Line 113010: `useHive(hiveOpened || !config2?.onboardingComplete ? config2 : null)`

### Roster IPC Handler Hataları Düzeltildi
- **Dosya**: `src/main/electron-main.js`
- **Değişiklik**: Duplicate roster:write handler kaldırıldı
- **Detaylar**:
  - Line 845-889: roster:readSync ve roster:write handler'ları kaldırıldı (ipc/misc.js'de zaten var)
  - harness.config.harnessHome yerine readSettings().harnessHome kullanıldı

### Workers:list IPC Handler Hatası Düzeltildi
- **Dosya**: `src/main/electron-main.js`
- **Değişiklik**: Duplicate workers:list handler kaldırıldı
- **Detaylar**:
  - Line 769-787: workers:list handler kaldırıldı (ipc/misc.js'de zaten var)
  - harness.hive.getAgentName hatası düzeltildi: registry.agents?[id] kullanıldı

### Roster.json Oluşturuldu
- **Dosya**: `~/.ozycomp/hive/roster.json`
- **Değişiklik**: 317 ajan içeren roster.json oluşturuldu
- **Detaylar**:
  - Hive registry'den tüm ajanlar roster.json'a aktarıldı
  - Pro shell'de ajanların görünmesi için gerekli

### Skill Catalog Güncellendi
- **Dosya**: `~/.ozycomp/skill-catalog.json`
- **Değişiklik**: 252 skill güncellendi
- **Detaylar**:
  - GitHub skill catalog'undan skill'ler güncellendi

### Unarchive-agents.js Script'i Oluşturuldu
- **Dosya**: `unarchive-agents.js`
- **Değişiklik**: Arşivlenmiş ajanları aktif hale getiren script oluşturuldu
- **Detaylar**:
  - `node unarchive-agents.js --all` ile tüm ajanları aktif et
  - `node unarchive-agents.js --agent <id>` ile belirli ajanı aktif et

### RESTORE_WORKFLOW.md Oluşturuldu
- **Dosya**: `RESTORE_WORKFLOW.md`
- **Değişiklik**: Arşivden çıkarma iş akışı dokümantasyonu oluşturuldu
- **Detaylar**:
  - Script ile otomatik arşivden çıkarma
  - UI'den (God üzerinden) arşivden çıkarma
  - IPC handler detayları

### Devin CLI Auto-Install Eklendi
- **Dosya**: `src/main/harness.js`
- **Değişiklik**: Devin CLI otomatik kurulumu eklendi
- **Detaylar**:
  - isCommandAvailable() fonksiyonu eklendi
  - ensureDevinCli() fonksiyonu eklendi
  - spawnAgent() çağrısında provider 'devin' ise otomatik kurulum çalışıyor
  - curl -fsSL https://cli.devin.ai/install.sh | bash kullanılıyor

### Devin Preset Eklendi
- **Dosya**: `src/renderer/assets/index-CYoBaPLy.js`
- **Değişiklik**: Devin preset eklendi
- **Detaylar**:
  - nativeInstallCommand eklendi (posix ve win32 için)
  - installCommand eklendi

### macOS Gatekeeper Sorunu Düzeltildi
- **Dosya**: `package.json`
- **Değişiklik**: hardenedRuntime ve gatekeeperAssess devre dışı bırakıldı
- **Detaylar**:
  - Line 42-43: hardenedRuntime: false, gatekeeperAssess: false

### PTY Manager "Crashed" Verdict Hatası Düzeltildi
- **Dosya**: `src/main/pty-manager.js`
- **Değişiklik**: kill() fonksiyonunda agent'ı session map'ten hemen silme eklendi
- **Detaylar**:
  - this.agents.delete(id) çağrısı this.forgetPid(a.pid) sonrasına eklendi

### App Quit Sorunu Düzeltildi
- **Dosya**: `src/main/ide-runtime.js`
- **Değişiklik**: getAllowQuit() fonksiyonu export edildi
- **Detaylar**:
  - Line: exports.getAllowQuit = getAllowQuit;

### Default Embedding Model Değiştirildi
- **Dosya**: `src/main/config.js`
- **Değişiklik**: minilm yerine embeddinggemma kullanıldı
- **Detaylar**:
  - Çok dilli arama için embeddinggemma daha uygun

### Office Pin Skin Seçimi Geri Yüklendi
- **Dosya**: `src/renderer/assets/global-eDtrx50m.js`
- **Değişiklik**: Office pin verbatim skin seçimine geri döndü
- **Detaylar**:
  - loadDefault() ve load$2() fonksiyonları verbatim olarak geri yüklendi

### SyntaxError Düzeltildi
- **Dosya**: `src/main/electron-main.js`
- **Değişiklik**: Line 866'da fazladan kapanış parantezi kaldırıldı
- **Detaylar**:
  - Fazladan } karakteri silindi

### Hive Registry Ajanları Güncellendi
- **Dosya**: `~/.ozycomp/hive/registry.json`
- **Değişiklik**: 317 ajan güncellendi
- **Detaylar**:
  - Türkçe isimler atandı (zaten Türkçe olanlar korundu)
  - Karakter atamaları yapıldı (michael, pam, dwight, jim, stanley, angela, oscar, kevin, phyllis, creed, meredith, kelly, ryan, toby, jan, david, holly, gabe, robert, nellie, clark, pete)
  - Türkçe goal açıklamaları eklendi
  - Memory konfigürasyonu eklendi (enabled: true, model: "embeddinggemma")
  - Script: `update_agents.py` ile otomatik güncelleme

## Önceki Değişiklikler (Özet)

### Munder Clone Başlatıldı
- Reference bundle: `~/.rea/targets/munder-difflin-asar/extracted/out/main/index.js`
- Hedef: %100 verbatim behavioral clone
- Başlangıç tarihi: 2026-10-20

### Temel Yapılandırma
- Electron app yapılandırması
- PTY management via node-pty
- Hive agent registry
- Session resume via --resume <sid>
- i18n via i18next (tr, en, zh-CN, ar)
- Semantic memory via mempalace
