#!/usr/bin/env node
/**
 * Arşivlenmiş ajanları aktif hale getirme scripti
 *
 * Kullanım:
 *   node unarchive-agents.js [--all|--agent <id>]
 *
 * --all: tüm arşivlenmiş ajanları unarchive eder
 * --agent <id>: belirli ajanı unarchive eder
 *
 * Bu script:
 * 1. Hive registry'den arşivlenmiş ajanları okur
 * 2. Her ajan için setArchived(id, false) çağırır
 * 3. Roster'a yazar
 * 4. Ajan spawn etmez (kullanıcı manuel spawn etmeli)
 */

const fs = require('fs');
const path = require('path');

const HIVE_ROOT = '/Users/oguzhan/.ozycomp/hive';
const REGISTRY_FILE = path.join(HIVE_ROOT, 'registry.json');

function readRegistry() {
  try {
    const content = fs.readFileSync(REGISTRY_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.error('Registry okunamadı:', e.message);
    process.exit(1);
  }
}

function writeRegistry(data) {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('Registry güncellendi');
  } catch (e) {
    console.error('Registry yazılamadı:', e.message);
    process.exit(1);
  }
}

function unarchiveAgent(registry, agentId) {
  const agent = registry.agents[agentId];
  if (!agent) {
    console.error(`Ajan bulunamadı: ${agentId}`);
    return false;
  }
  if (!agent.archived) {
    console.log(`Ajan zaten aktif: ${agentId} (${agent.name})`);
    return false;
  }

  agent.archived = false;
  agent.status = 'idle';
  agent.action = 'unarchived';
  agent.ptyId = null;

  console.log(`Unarchive ediliyor: ${agentId} (${agent.name})`);
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const targetId = args[1];

  const registry = readRegistry();
  let changed = false;

  if (mode === '--all') {
    const archivedIds = Object.entries(registry.agents)
      .filter(([id, a]) => a.archived)
      .map(([id]) => id);

    console.log(`${archivedIds.length} arşivlenmiş ajan bulundu`);

    for (const id of archivedIds) {
      if (unarchiveAgent(registry, id)) {
        changed = true;
      }
    }
  } else if (mode === '--agent' && targetId) {
    if (unarchiveAgent(registry, targetId)) {
      changed = true;
    }
  } else {
    console.log('Kullanım: node unarchive-agents.js [--all|--agent <id>]');
    console.log('  --all: tüm arşivlenmiş ajanları unarchive eder');
    console.log('  --agent <id>: belirli ajanı unarchive eder');
    process.exit(0);
  }

  if (changed) {
    writeRegistry(registry);
    console.log('\nAjanlar unarchive edildi. Uygulamayı yeniden başlatın ve spawn edin.');
  } else {
    console.log('\nDeğişiklik yok.');
  }
}

main();
