# Arşivden Çıkarma İş Akışı

Bu README, arşivlenmiş ajanları aktif hale getirmek için kullanılan iş akışını belgeler.

## Durum

- **Registry ajan sayısı:** 317 (317 aktif, 0 arşivlenmiş)
- **Arşivlenmiş ajanlar:** 0 (unarchive-agents.js ile aktif edildi)
- **Script:** `unarchive-agents.js`

## Otomatik Arşivden Çıkarma

### 1. Script ile tüm ajanları aktif et

```bash
node unarchive-agents.js --all
```

Bu komut:
- Hive registry'den tüm arşivlenmiş ajanları okur
- Her ajan için `archived: false` yapar
- Registry'yi günceller
- 316 ajanı aktif hale getirir

### 2. Belirli ajanı aktif et

```bash
node unarchive-agent.js --agent <agent-id>
```

Örnek:
```bash
node unarchive-agents.js --agent exec-coo
```

## UI'den Arşivden Çıkarma

### God üzerinden

1. God terminaline gidin
2. Ajan listesinden arşivlenmiş ajanı seçin
3. Komut gönder:
   ```
   unarchive <agent-id>
   ```
4. God IPC üzerinden `hive:setArchived(id, false)` çağırır
5. Registry güncellenir
6. Ajan spawn et (kullanıcı manuel)

### IPC Handler

`hive:setArchived(id, archived)` — `src/main/ipc/hive.js:1080`

## Sonraki Adım

Ajanlar aktif hale geldikten sonra:
1. Uygulamayı yeniden başlatın
2. Agent'ı spawn edin (UI'den "Add Agent" veya god komutu ile)
3. Agent aktif çalışmaya başlar

## Notlar

- Arşivlenmiş ajanların PTY'si yoktur (spawn edilmediler)
- Unarchive sadece registry durumunu değiştirir, spawn etmez
- Resume/kaldığı yerden devam çalışır: kod tam çalışıyor, transkript olmadığı için fresh başlıyor (doğru)
