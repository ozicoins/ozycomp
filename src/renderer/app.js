'use strict';
/**
 * Renderer — talks to main only through window.cth. Views:
 *   Ofis (desk grid + breaker dots), Görevler (kanban + automations),
 *   Pano (board.md), Bilgi (knowledge graph), Ayarlar (license, temps/KG
 *   switches, MCP catalog, secrets, usage).
 * Clicking a desk opens a terminal drawer streaming that agent's PTY.
 */
(() => {
  const cth = window.cth;
  const $ = s => document.querySelector(s);
  const tails = new Map();
  let current = null;
  let lastStatus = null;
  let settings = {};
  let floor = null;                 // OfficeFloor canvas instance

  const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ── views ──
  document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.navbtn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${b.dataset.view}`));
    refresh();
  }));

  function renderFloor(st) {
    // Canvas2D isometric floor (OfficeFloor.js) — same cast/errands/quips as the reference
    if (!floor && window.OfficeFloor) {
      floor = new OfficeFloor($('#floor-cv'), { onSelect: openDrawer });
      $('#season-btn').addEventListener('click', () =>
        floor.setSeason(floor.season === 'halloween' ? 'none' : 'halloween'));
      $('#season-btn').style.opacity = floor.season === 'halloween' ? '1' : '.45';
    }
    if (floor) {
      const activity = {};
      for (const a of st.agents) activity[a.id] = a.isGod ? 'running the floor' : (a.alive ? 'working' : 'paused');
      floor.setAgents(st.agents, st.breaker?.agents ?? {}, activity);
      $('#season-btn').style.opacity = floor.season === 'halloween' ? '1' : '.45';
    }
    const grid = $('#floor');
    if (!st.agents.length) {
      grid.innerHTML = '<div class="empty">Ofis boş. “+ Agent” ile bir agent başlat — ilki <b>god</b> olsun.</div>';
      return;
    }
    grid.innerHTML = st.agents.map(a => {
      const lvl = st.breaker.agents[a.id]?.level ?? 'healthy';
      const dotCls = a.alive ? `lvl-${lvl}` : 'dead';
      const tail = (tails.get(a.id) ?? '').split('\n').filter(Boolean).slice(-3).join('\n');
      const usage = st.usage?.agents?.[a.id];
      const uTxt = usage ? ` · ${(usage.total / 1000).toFixed(1)}k tok · $${usage.costUsd.toFixed(3)}` : '';
      return `<div class="desk" data-id="${esc(a.id)}">
        <span class="dot ${dotCls}" title="${esc(lvl)}"></span>
        <div class="name">${esc(a.id)}</div>
        <div class="meta">${esc(a.provider)} · pid ${a.pid ?? '—'} · ${a.alive ? 'çalışıyor' : 'durdu'}${uTxt}</div>
        <div class="tail">${esc(tail)}</div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.desk').forEach(d => d.addEventListener('click', () => openDrawer(d.dataset.id)));
  }

  function renderKanban(tasks) {
    const cols = { todo: 'Yapılacak', doing: 'Sürüyor', blocked: 'Engelli', done: 'Bitti' };
    $('#kanban').innerHTML = Object.entries(cols).map(([k, label]) => `
      <div class="col"><h4>${label}</h4>
        ${tasks.filter(t => t.status === k).map(t =>
          `<div class="card">${esc(t.title)}<br><small>${esc(t.id)} · ${esc(t.assignee ?? 'atanmadı')}</small></div>`).join('')}
      </div>`).join('');
  }

  function renderAutomations(list) {
    $('#auto-list').innerHTML = list.map(a => `
      <li><b>${esc(a.agentId)}</b> — ${esc(a.text)} <small>her ${a.intervalMinutes}dk ${a.enabled ? '' : '(kapalı)'}</small>
      <button data-del="${esc(a.id)}" class="mini danger">sil</button></li>`).join('');
    $('#auto-list').querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', async () => { await cth.removeAutomation(b.dataset.del); refresh(); }));
  }

  // ── skills & agent repos view ──
  let skillsCache = null, catalogCache = null;
  async function renderSkills() {
    skillsCache = await cth.skillsLocal();
    const q = ($('#skills-q').value ?? '').toLowerCase();
    $('#skills-local').innerHTML = skillsCache
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .map(s => `<li><b>${esc(s.name)}</b><span class="badge ${s.scope}">${esc(s.scope)}</span>
        ${s.provider !== 'claude' ? `<span class="badge">${esc(s.provider)}</span>` : ''}
        ${s.source ? `<span class="badge">${esc(s.source)}</span>` : ''}<br>
        <small>${esc(s.description)}</small><br>
        <small>${esc(s.path)}</small>
        <button data-rm="${esc(s.path)}" class="mini danger">kaldır</button>
        <button data-reveal="${esc(s.path)}" class="mini">göster</button></li>`)
      .join('') || '<li>beceri bulunamadı</li>';
    $('#skills-local').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
      const r = await cth.skillsUninstall(b.dataset.rm);
      if (!r.ok) alert(`Kaldırma: ${r.error}`);
      renderSkills();
    }));
    $('#skills-local').querySelectorAll('[data-reveal]').forEach(b => b.addEventListener('click', () =>
      cth.skillsReveal(b.dataset.reveal)));

    if (!catalogCache) catalogCache = await cth.skillsCatalog();
    const cq = ($('#catalog-q').value ?? '').toLowerCase();
    const rows = (catalogCache.skills ?? [])
      .filter(s => !cq || s.name.toLowerCase().includes(cq) || s.description.toLowerCase().includes(cq) || s.category.toLowerCase().includes(cq))
      .slice(0, 60);
    $('#skills-catalog').innerHTML =
      (catalogCache.stale ? `<li class="hint">katalog bayat${catalogCache.error ? `: ${esc(catalogCache.error)}` : ''}</li>` : '') +
      (rows.map(s => `<li><b>${esc(s.name)}</b><span class="badge">${esc(s.category)}</span><br>
        <small>${esc(s.description)}</small><br>
        <button data-ins="${esc(s.url)}" data-name="${esc(s.name)}" class="mini">kur</button>
        <a href="${esc(s.url)}" class="mini" style="display:inline-block;padding:2px 8px">kaynak</a></li>`).join('')
        || '<li>sonuç yok</li>');
    $('#skills-catalog').querySelectorAll('[data-ins]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'kuruluyor…';
      const r = await cth.skillsInstall(b.dataset.ins, b.dataset.name);
      b.textContent = r.ok ? 'kuruldu ✓' : 'hata';
      if (!r.ok) alert(`Kurulum: ${r.error}`);
      skillsCache = null; catalogCache = catalogCache; renderSkills();
    }));

    const repos = await cth.registeredRepos();
    $('#repo-list').innerHTML = repos.map(r =>
      `<li><code>${esc(r)}</code> <button data-repo-rm="${esc(r)}" class="mini danger">sil</button></li>`).join('')
      || '<li class="hint">kayıtlı repo yok — bir dizin ekleyin, içindeki .claude/skills taranır</li>';
    $('#repo-list').querySelectorAll('[data-repo-rm]').forEach(b => b.addEventListener('click', async () => {
      const cur = await cth.registeredRepos();
      await cth.registeredRepos(cur.filter(x => x !== b.dataset.repoRm));
      renderSkills();
    }));
  }

  async function renderKnowledge() {
    const docs = await cth.kgList();
    $('#kg-docs').innerHTML = docs.map(d =>
      `<li><b>${esc(d.title)}</b> <small>${esc(d.modality)} · ${d.chunks} parça · ${esc(d.id)}</small>
       <button data-del="${esc(d.id)}" class="mini danger">sil</button></li>`).join('');
    $('#kg-docs').querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', async () => { await cth.kgRemove(b.dataset.del); renderKnowledge(); }));
  }

  async function renderSettings(st) {
    settings = await cth.settings();
    $('#set-temps').checked = settings.tempsEnabled !== false;
    $('#set-kg').checked = settings.knowledgeGraph !== false;
    $('#set-lang').value = settings.lang ?? 'tr';
    const lic = settings.license ?? { state: 'locked' };
    $('#lic-state').textContent = `durum: ${lic.state}${lic.daysLeft ? ` (${lic.daysLeft} gün kaldı)` : ''}${lic.dev ? ' [dev]' : ''}`;

    const catalog = await cth.mcpCatalog();
    const chosen = new Set(settings.mcpIds ?? []);
    $('#mcp-list').innerHTML = catalog.map(m => `
      <label class="row"><input type="checkbox" data-mcp="${esc(m.id)}" ${chosen.has(m.id) ? 'checked' : ''}>
      <b>${esc(m.label)}</b> <small>${esc(m.tier)}${m.secretKeys.length ? ` — gerekli: ${m.secretKeys.join(', ')}` : ''} · ${esc(m.hint)}</small></label>`).join('');
    $('#mcp-list').querySelectorAll('[data-mcp]').forEach(cb => cb.addEventListener('change', async () => {
      const ids = [...$('#mcp-list').querySelectorAll('[data-mcp]:checked')].map(x => x.dataset.mcp);
      await cth.patchSettings({ mcpIds: ids });
    }));

    const keys = await cth.secretKeys();
    $('#secret-list').innerHTML = keys.map(k =>
      `<li><code>${esc(k)}</code> <button data-del="${esc(k)}" class="mini danger">sil</button></li>`).join('');
    $('#secret-list').querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', async () => { await cth.removeSecret(b.dataset.del); renderSettings(); }));

    const u = st.usage ?? { agents: {}, tokens: 0, costUsd: 0 };
    $('#usage-pre').textContent =
      `toplam: ${u.tokens} token · $${u.costUsd.toFixed(4)}\n` +
      Object.entries(u.agents).map(([id, a]) => `${id}: ${a.total} tok · $${a.costUsd.toFixed(4)}`).join('\n');

    // voice card
    const vs = await cth.voiceStatus();
    if (vs) {
      const eng = Object.entries(vs.engines).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' ');
      $('#voice-state').textContent =
        `motorlar ${eng} → dikte: ${vs.chosen.dictation ?? 'yok'} · toplantı: ${vs.chosen.meeting ?? 'yok'} · ` +
        `model ${vs.model.inUse}${vs.warming ? ' (ısınıyor)' : ''} · sözlük ${vs.words.total} kelime`;
      $('#voice-engine').value = vs.config.engine;
      $('#voice-model').value = vs.config.model;
      const dl = await cth.voiceModels();
      $('#voice-models').innerHTML = dl.map(m => `
        <div class="row"><b>${esc(m.id)}</b> <small>${m.mb}MB ${m.installed ? '· kurulu' : ''}</small>
        ${m.installed ? '' : `<button data-dl="${esc(m.id)}" class="mini">indir</button>`}</div>`).join('');
      $('#voice-models').querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', async () => {
        const r = await cth.voiceDownload(b.dataset.dl);
        if (!r.ok) alert(`İndirme: ${r.error}`);
        renderSettings(lastStatus);
      }));
      $('#voice-words').value = (vs.config.customWords ?? []).join(', ');
      const aa = await cth.anyAppStatus();
      $('#anyapp-state').textContent = aa.armed
        ? `her uygulamada dikte: ${aa.armed} tuşu aktif${aa.streamRefused ? ' (akış kapalı)' : ''}`
        : `her uygulamada dikte: ${aa.unavailable === 'no-helper' ? 'md-hotkey yardımcısı kurulu değil'
          : aa.unavailable === 'floor' ? 'floor modunda kapalı'
          : aa.unavailable === 'wayland' ? 'Wayland oturumunda kapalı' : 'kapalı'}`;
    }
  }

  async function refresh() {
    try {
      const st = await cth.status();
      lastStatus = st;
      $('#status-pill').textContent =
        `hook :${st.hookPort} · otel :${new URL(st.otelEndpoint ?? 'http://x:0').port} · ` +
        `${st.agents.length} agent · ${st.openQuestions.length} soru · ${st.license?.state ?? '?'}`;
      renderFloor(st);
      renderKanban(st.tasks);
      renderAutomations(st.automations ?? []);
      if ($('#view-board').classList.contains('active')) $('#board-pre').textContent = await cth.board();
      if ($('#view-knowledge').classList.contains('active')) await renderKnowledge();
      if ($('#view-skills').classList.contains('active')) await renderSkills();
      if ($('#view-settings').classList.contains('active')) await renderSettings(st);
    } catch (e) {
      $('#status-pill').textContent = 'bağlantı hatası';
    }
  }

  // ── drawer / terminal ──
  async function openDrawer(id) {
    current = id;
    $('#drawer-title').textContent = id;
    const u = lastStatus?.usage?.agents?.[id];
    $('#drawer-usage').textContent = u ? `${u.total} tok · $${u.costUsd.toFixed(4)}` : '';
    $('#term').textContent = stripAnsi(await cth.scrollback(id));
    $('#drawer').classList.add('open');
    $('#term').scrollTop = 1e9;
    $('#term-input').focus();
  }
  $('#drawer-close').addEventListener('click', () => { $('#drawer').classList.remove('open'); $('#caps-panel').hidden = true; current = null; });
  $('#drawer-kill').addEventListener('click', async () => { if (current) { await cth.kill(current); refresh(); } });
  $('#drawer-steer').addEventListener('click', async () => {
    if (!current) return;
    const body = prompt(`${current} için yönlendirme mesajı:`);
    if (body) await cth.steer(current, body);
  });
  $('#term-form').addEventListener('submit', async e => {
    e.preventDefault();
    const v = $('#term-input').value;
    if (!current || !v) return;
    $('#term-input').value = '';
    const r = await cth.send(current, v);
    if (!r.ok) alert(`Gönderilemedi: ${r.reason}`);
  });

  // ── capabilities palette (per-provider command list, verbatim groups) ──
  let capsCache = null;
  async function renderCaps() {
    const provider = lastStatus?.agents.find(a => a.id === current)?.provider ?? 'claude';
    if (!capsCache || capsCache.provider !== provider) {
      const groups = await cth.commandGroups(provider);
      capsCache = { provider, groups };
    }
    const q = ($('#caps-q').value ?? '').toLowerCase();
    $('#caps-list').innerHTML = capsCache.groups.map(g => {
      const items = g.items.filter(i =>
        !q || i.cmd.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q) || (i.usage ?? '').toLowerCase().includes(q));
      if (!items.length) return '';
      return `<div class="caps-group"><h5>${esc(g.title)}</h5>` + items.map(i =>
        `<div class="caps-item"><code>${esc(i.cmd)}</code><span class="badge">${esc(i.kind)}</span><br>
          <small>${esc(i.desc)}</small>${i.usage ? `<br><small class="hint">${esc(i.usage)}</small>` : ''}</div>`).join('') + `</div>`;
    }).join('');
  }
  $('#drawer-caps').addEventListener('click', async () => {
    const p = $('#caps-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) { await renderCaps(); $('#caps-q').focus(); }
  });
  $('#caps-q').addEventListener('input', renderCaps);

  // ── spawn ──
  async function fillProviders() {
    const sel = $('#spawn-form').provider;
    const list = await cth.providers();
    sel.innerHTML = list.map(p =>
      `<option value="${esc(p.id)}" ${p.installed ? '' : 'disabled'}>${esc(p.label)}${p.installed ? '' : ' (kurulu değil)'}</option>`).join('');
  }
  $('#spawn-btn').addEventListener('click', async () => {
    await fillProviders();
    const f = $('#spawn-form');
    if (!lastStatus?.agents.some(a => a.id === 'god')) f.id.value = 'god';
    $('#spawn-dlg').showModal();
  });
  $('#spawn-dlg').addEventListener('close', async () => {
    if ($('#spawn-dlg').returnValue !== 'ok') return;
    const f = $('#spawn-form');
    const opts = {
      provider: f.provider.value,
      role: f.id.value === 'god' ? 'god' : 'worker',
      auto: f.auto.checked,
      isolate: f.isolate.checked,
    };
    if (f.model.value.trim()) opts.model = f.model.value.trim();
    await cth.spawn(f.id.value.trim(), opts);
    f.reset();
    refresh();
  });

  // ── skills view controls ──
  $('#skills-q').addEventListener('input', () => renderSkills());
  $('#catalog-q').addEventListener('input', () => renderSkills());
  $('#catalog-reload').addEventListener('click', async () => {
    catalogCache = await cth.skillsCatalog(true);
    renderSkills();
  });
  $('#repo-form').addEventListener('submit', async e => {
    e.preventDefault();
    const p = $('#repo-path').value.trim();
    if (!p) return;
    const cur = await cth.registeredRepos();
    await cth.registeredRepos([...cur, p]);
    $('#repo-path').value = '';
    renderSkills();
  });

  // ── knowledge search ──
  $('#kg-form').addEventListener('submit', async e => {
    e.preventDefault();
    const hits = await cth.kgSearch($('#kg-q').value, 8);
    $('#kg-results').innerHTML = hits.length
      ? hits.map(h => `<li><b>${esc(h.title)}</b> <small>skor ${h.score.toFixed(2)}</small><br>${esc(h.snippet)}</li>`).join('')
      : '<li>sonuç yok</li>';
  });

  // ── automations form ──
  $('#auto-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    await cth.addAutomation({ agentId: f.agentId.value.trim(), text: f.text.value.trim(), intervalMinutes: Number(f.intervalMinutes.value) });
    f.reset();
    refresh();
  });

  // ── settings forms ──
  $('#set-temps').addEventListener('change', async e => { await cth.patchSettings({ tempsEnabled: e.target.checked }); });
  $('#set-kg').addEventListener('change', async e => { await cth.patchSettings({ knowledgeGraph: e.target.checked }); });
  $('#set-lang').addEventListener('change', async e => {
    await cth.patchSettings({ lang: e.target.value });
    if (window.setLocale) window.setLocale(e.target.value);
  });
  $('#secret-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    if (f.key.value.trim() && f.value.value) { await cth.setSecret(f.key.value.trim(), f.value.value); f.reset(); renderSettings(lastStatus); }
  });
  $('#lic-form').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await cth.licenseRedeem($('#lic-key').value);
    if (!r.ok) alert(`Lisans: ${r.error}`);
    refresh();
  });
  $('#lic-trial').addEventListener('click', async () => { const r = await cth.licenseTrial(); if (!r.ok) alert(`Deneme: ${r.error}`); refresh(); });

  // ── voice settings + push-to-talk dictation ──
  $('#voice-engine').addEventListener('change', e => cth.voicePatch({ engine: e.target.value }));
  $('#voice-model').addEventListener('change', e => cth.voicePatch({ model: e.target.value }));
  $('#voice-words').addEventListener('change', e =>
    cth.voicePatch({ customWords: e.target.value.split(',').map(x => x.trim()).filter(Boolean) }));
  cth.onVoiceProgress(p => { $('#voice-prog').textContent = `indiriliyor: %${Math.round((p.pct ?? 0) * 100)}`; });

  const mic = $('#mic-btn');
  let rec = null, recChunks = [];
  const startRec = async () => {
    if (rec) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recChunks = [];
      rec.ondataavailable = e => recChunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        mic.classList.remove('rec');
        const blob = new Blob(recChunks, { type: 'audio/webm' });
        const buf = await blob.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        mic.textContent = '⏳';
        const r = await cth.voiceTranscribe({ audio: b64, mimeType: 'audio/webm', mode: 'dictation' });
        mic.textContent = '🎙';
        if (r.ok && r.text) {
          const inp = $('#term-input');
          inp.value = (inp.value ? inp.value + ' ' : '') + r.text;
        } else if (!r.ok) alert(`Dikte: ${r.error}`);
      };
      rec.start(); mic.classList.add('rec');
    } catch (e) { alert(`Mikrofon: ${e.message}`); }
  };
  const stopRec = () => { if (rec && rec.state !== 'inactive') rec.stop(); rec = null; };
  mic.addEventListener('pointerdown', startRec);
  mic.addEventListener('pointerup', stopRec);
  mic.addEventListener('pointerleave', stopRec);

  // ── streams ──
  cth.onPtyData((id, chunk) => {
    const clean = stripAnsi(chunk);
    tails.set(id, ((tails.get(id) ?? '') + clean).slice(-2000));
    if (id === current) {
      const t = $('#term');
      const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
      t.textContent += clean;
      if (atBottom) t.scrollTop = 1e9;
    }
  });
  cth.onPtyExit(() => refresh());
  cth.onSpawned(() => refresh());
  cth.onTempSpawned(() => refresh());
  cth.onUsage(() => { if ($('#view-office').classList.contains('active')) refresh(); });
  cth.onLicense(() => refresh());
  cth.onOpenQuestion(q => {
    if (!q) return;
    const a = prompt(`${q.agent} soruyor:\n\n${q.question}`);
    if (a != null) cth.answerQuestion(q.id, a);
  });
  cth.onTempConfirm?.(c => alert(`Araştırma/işe alım önerisi onay bekliyor:\n${c.file}`));

  setInterval(refresh, 2000);
  refresh();
})();
