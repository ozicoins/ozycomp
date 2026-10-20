'use strict';
/**
 * OfficeFloor — Canvas2D isometric office floor. Zero-dep stand-in for the
 * reference's PixiJS OfficeFloor: same cast, same errand spots, same quip
 * pools, same Turkish activity labels, halloween season toggle.
 *
 * Tile-space is a 36×22 office: top-left is the CEO office (godOnly errands),
 * bottom row is the café (coffee/vending/fridge/shelf/bins), top wall has
 * windows + water dispensers. Desks fill the middle; agents spawn on
 * desk-/pc-/warroom-/entrance-prefixed points.
 */
(() => {
  // ── layout (tile coords match the reference's errandSpots verbatim) ──
  const TILE = 32;                 // diamond width; height = TILE/2
  const W = 36, H = 22;

  const ERRAND_SPOTS = [
    { kind: 'water',     stand: { x: 2,  y: 20 }, facing: 'left',  fx: { x: 1,  y: 20 }, duration: 4.5 },
    { kind: 'water',     stand: { x: 22, y: 20 }, facing: 'right', fx: { x: 23, y: 20 }, duration: 4.5 },
    { kind: 'water',     stand: { x: 30, y: 20 }, facing: 'right', fx: { x: 31, y: 20 }, duration: 4.5 },
    { kind: 'water',     stand: { x: 6,  y: 4 },  facing: 'up',    fx: { x: 6,  y: 3 },  duration: 4.5, godOnly: true },
    { kind: 'smoke',     stand: { x: 2,  y: 3 },  facing: 'up',    fx: { x: 2,  y: 1 },  duration: 18,  godOnly: true },
    { kind: 'water',     stand: { x: 17, y: 4 },  facing: 'up',    fx: { x: 17, y: 3 },  duration: 4.5 },
    { kind: 'window',    stand: { x: 10, y: 3 },  facing: 'up',    fx: { x: 10, y: 1 },  duration: 5 },
    { kind: 'window',    stand: { x: 15, y: 3 },  facing: 'up',    fx: { x: 14, y: 1 },  duration: 5 },
    { kind: 'dispenser', stand: { x: 16, y: 3 },  facing: 'down',  fx: { x: 16, y: 4 },  duration: 3.5 },
    { kind: 'dispenser', stand: { x: 32, y: 4 },  facing: 'up',    fx: { x: 32, y: 3 },  duration: 3.5 },
    { kind: 'fridge',    stand: { x: 29, y: 20 }, facing: 'up',    fx: { x: 29, y: 19 }, duration: 3.2 },
    { kind: 'shelf',     stand: { x: 30, y: 20 }, facing: 'up',    fx: { x: 30, y: 18 }, duration: 4 },
    { kind: 'bin',       stand: { x: 18, y: 20 }, facing: 'left',  fx: { x: 17, y: 20 }, duration: 2.6 },
    { kind: 'bin',       stand: { x: 31, y: 16 }, facing: 'right', fx: { x: 32, y: 16 }, duration: 2.6 },
  ];
  const CAFE_SEATS = [                    // cafe-seat-1..4 @ px 432,224/432,256
    { x: 27, y: 20, facing: 'up',   partner: 1, spot: 'table' },
    { x: 27, y: 21, facing: 'down', partner: 0, spot: 'table' },
    { x: 25, y: 20, facing: 'up',   partner: 3, spot: 'table' },
    { x: 25, y: 21, facing: 'down', partner: 2, spot: 'table' },
  ];
  const CAFE_STANDS = [                   // cafe-stand-coffee / cafe-stand-vending
    { x: 23, y: 20, facing: 'up',   partner: -1, spot: 'coffee'  },
    { x: 24, y: 20, facing: 'up',   partner: -1, spot: 'vending' },
  ];
  const COFFEE = [
    'is this… decaf?? who did this', 'we’re out of beans again',
    'World’s Best Boss mug', 'first cup of the day. and the fifth.',
    'the coffee here is basically a hug', 'who took my mug?'];
  const VENDING = [
    'the machine ate my dollar', 'B4… please be the pretzels',
    'it’s stuck. classic.', 'shaking it. gently. respectfully.',
    'one (1) emotional-support snack', 'A1 again. living dangerously.'];
  const SNACK = [
    'is it Pretzel Day?', 'who finished the chips??', 'just a little treat',
    'these are everyone’s? cool cool cool', 'second breakfast'];
  const TABLE = [
    'big day. lots of meetings.', 'just five more minutes',
    'did you see the standup notes?', 'pretending to read my notes',
    'I needed this break, honestly', 'do NOT tell Michael I’m in here'];
  const SPOT_POOL = { coffee: COFFEE, vending: VENDING, snack: SNACK, table: TABLE };
  const BY_CHARACTER = {
    michael:  ['I DECLARE… BANKRUPTCY!', "that's what she said", "I'm not superstitious. just a little stitious.", 'no meetings before coffee. that’s the rule.'],
    dwight:   ['FALSE.', 'identity theft is not a joke', 'that mug is regulation', 'this fridge needs a beet drawer', 'Schrute Farms has better coffee'],
    jim:      ["...that's what she said", 'bears. beets. Battlestar Galactica.', 'I moved Dwight’s stapler again', 'just here for the gossip'],
    pam:      ['Dunder Mifflin, this is Pam', 'sketching the vending machine', 'the watercolor of the break room'],
    kevin:    ['the chili is NOT ready', 'why waste time say lot word', 'me want snack', 'cookie? cookie.'],
    angela:   ['this break room is filthy', 'party planning committee, 3pm', 'I’m judging the fridge'],
    oscar:    ['actually, it’s “espresso”', 'well, actually…', 'the budget for snacks is concerning'],
    stanley:  ['is it Pretzel Day?', 'did I stutter?', 'crossword and coffee. leave me be.', "I'll retire before this brews"],
    phyllis:  ['Bob is picking me up at five', 'knitting and a nice cup of tea'],
    andy:     ['Cornell, ever heard of it?', 'rit-dit-dit, coffee break!', 'Big Tuna, grab a chair'],
    kelly:    ['did you HEAR what happened??', 'so. much. to tell you.', 'I am the GOSSIP queen'],
    ryan:     ['I’m kind of a big deal', 'the temp needs caffeine', 'starting a coffee startup, actually'],
    toby:     ['I should write that up…', 'HR-wise this break is fine', 'no one ever sits with me'],
    creed:    ['which one of you is the new guy?', 'I’ve eaten worse out of that fridge', 'mung beans. under my desk.'],
    meredith: ['is it 5 o’clock yet?', 'someone spike the coffee?'],
  };
  const EXCHANGES = [
    ['world’s best boss.', 'you are. I had the mug made.', 'and I cherish it.'],
    ['would an idiot do this?', '...if yes, I don’t.', 'that’s my boy.'],
    ['feared or loved? both.', 'that’s beautiful.', 'I know.'],
    ['I edited your wiki page again.', 'I know. thank you.'],
    ['question. how many bears?', 'one.', 'that’s too many.'],
    ['fact: bears eat beets.', 'bears. beets. Galactica.', 'what is happening.'],
    ['I grew up on a beet farm.', 'shocking.', '...not shocking at all.'],
    ['what’s Schrute Farms smell like?', 'victory. and beets.'],
    ['did you just throw your phone?', 'didn’t like what it said.', 'cool.'],
    ['is a hot dog a sandwich?', 'it is.', 'I know, right?'],
    ['three-hole-punch Jim returns.', 'never gets old.'],
    ['why few word when lot word?', '...genuinely profound.', 'I know.'],
    ['I am not a bad person.', '...', 'not a great person either.', 'there it is.'],
    ['I love my cats more than people.', 'including us?', 'especially you.'],
    ['cats are better than dogs.', 'dogs are better.', '...sorry.'],
    ['do you love me?', 'I love… being here.', 'that’s a yes.'],
    ['I’m kind of a big deal.', 'you are?', 'in my mind. yes.'],
    ['did you miss me?', 'no.', 'a little?', '...there it is.'],
    ['did you just roll your eyes?', 'I did.', 'why?', 'muscle memory.'],
    ['I’ve watched that clock since 4.', 'weren’t you working?', 'watching the clock.'],
    ['what do we sell again?', 'paper.', 'sure, yeah.'],
    ['how old are you?', 'yeah.', 'that’s not an answer.', 'sure it is.'],
    ['that’s not how math works.', 'I know.', 'then why?', 'faster.'],
    ['I’m not an alcoholic.', 'you went to a meeting.', 'for the food.'],
    ['I went to Cornell.', 'nobody cares.', 'I went to Cornell.', 'still nobody cares.'],
    ['I have a lot of feelings.', 'I can tell.', 'is that bad?', 'for us? yes.'],
    ['why are you the way you are?', '...', 'honestly.'],
    ['your cat died.', 'I know.', 'I’m sorry.', '...thank you.'],
    ['stop looking at me.', 'you stop looking at me.'],
    ['sign this.', 'what is it?', 'doesn’t matter.', '...fine.'],
    ['you can’t say that.', 'I just did.', 'gonna stop me?', '...no.'],
    ['that’s a fire lane.', 'fire hasn’t happened yet.'],
    ['I wrapped your stapler in Jello.', 'I’ll eat around it.', 'fair.'],
    ['zombie attack plan?', 'especially that.', 'of course.'],
    ['just seeing if you’d answer.', 'I hate you.', 'I know.'],
    ['a little stitious, not super.', 'that’s not a word.', 'it is now.'],
    ['funniest person in the office?', 'and other times?', 'other times I know it.'],
    ['that’s what she said.', '...every time.', 'come on.'],
    ['I started the fire.', 'no you didn’t.', 'in our hearts, I did.'],
    ['is today a day ending in Y?', 'yes.', 'then no.'],
    ['Bob Vance.', 'Phyllis Vance.', 'Vance Refrigeration.'],
    ['you look beautiful today.', '...I know.'],
    ['I’m better than you in every way.', 'probably.', 'definitely.', 'sure.'],
    ['I’m a nice guy.', 'you’re okay.', 'nicest thing you’ve said.'],
    ['are you okay?', 'I’ve been worse.', 'when?', 'can’t narrow it down.'],
    ['there’s a spider on your desk.', 'where?', '...you ate it.', 'protein.'],
    ['soul mates can be bosses.', 'you’re my boss.', 'exactly.'],
    ['standup ran 40 minutes.', 'could’ve been an email.'],
    ['is the build green yet?', '...don’t look.'],
    ['who reply-all’d everyone?', 'we don’t talk about it.'],
  ];
  const GOSSIP_KEYS = [
    'dedikodu: duydunuz mu', 'şşşt… patron bakıyor', 'bunu kimseye söyleme',
    'mutfakta ne oldu biliyor musun', 'bu ofis delirdi'];
  const ROSTER = Object.keys(BY_CHARACTER);   // michael..meredith
  const DEFAULT_CHARACTER = 'jim';

  // Turkish activity labels — verbatim map from the reference
  function companyActivityTR(text) {
    const labels = {
      'awaiting': 'iş bekliyor', 'idle': 'boşta', 'working': 'çalışıyor',
      'thinking': 'düşünüyor', 'waiting': 'bekliyor', 'paused': 'duraklatıldı',
      'resumed': 'devam ediyor', 'archived': 'hazır kadroda',
      'starting up': 'başlatılıyor', 'reconnecting': 'yeniden bağlanıyor',
      'reconnecting…': 'yeniden bağlanıyor…', 'running the floor': 'ofisi yönetiyor',
      'a fresh harness': 'yeni oturum', 'standby': 'hazır bekliyor',
      'on standby': 'hazır bekliyor',
    };
    return labels[String(text || '').trim().toLowerCase()] || String(text || '');
  }

  const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
  function pickSoloLine(character, spot, seed) {
    const flavour = BY_CHARACTER[character];
    if (flavour && seed % 5 < 3) return pick(flavour, Math.floor(seed / 5));
    return pick(SPOT_POOL[spot] ?? TABLE, seed);
  }

  // Breaker level → coat tint (status dot on the nameplate uses same colors)
  const LVL_COLOR = { healthy: '#6cbf6c', steering: '#e0a63a', constrained: '#e07a3a', stopped: '#d9534f', dead: '#5a5548' };

  const iso = (tx, ty) => ({ x: (tx - ty) * (TILE / 2), y: (tx + ty) * (TILE / 4) });
  const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  class OfficeFloor {
    constructor(canvas, opts = {}) {
      this.cv = canvas;
      this.cx = canvas.getContext('2d');
      this.onSelect = opts.onSelect ?? (() => {});
      this.season = localStorage.getItem('cth.season') ?? 'none';   // SEASONS=['halloween','none']
      this.sprites = new Map();     // id → sprite
      this.seatClaims = new Map();  // seatIdx → id
      this.seats = [];              // desk spawn tiles
      this.godTile = { x: 6, y: 4 };
      this._raf = 0;
      this._last = 0;
      this._drag = null;
      this.cam = { x: 0, y: 0, z: 1 };
      this._buildMap();
      canvas.addEventListener('pointerdown', e => { this._drag = { x: e.clientX, y: e.clientY, cam: { ...this.cam }, moved: false }; });
      canvas.addEventListener('pointermove', e => {
        if (!this._drag) return;
        const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this._drag.moved = true;
        this.cam.x = this._drag.cam.x + dx; this.cam.y = this._drag.cam.y + dy;
      });
      canvas.addEventListener('pointerup', e => {
        if (this._drag && !this._drag.moved) this._click(e);
        this._drag = null;
      });
      canvas.addEventListener('wheel', e => {
        e.preventDefault();
        this.cam.z = Math.min(2.4, Math.max(0.5, this.cam.z * (e.deltaY > 0 ? 0.9 : 1.1)));
      }, { passive: false });
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
      this._start();
    }

    setSeason(s) { this.season = s === 'halloween' ? 'halloween' : 'none'; localStorage.setItem('cth.season', this.season); }

    _buildMap() {
      // walkable: everything except solid furniture rows we stamp below
      this.walk = Array.from({ length: H }, () => Array(W).fill(true));
      const solid = (x, y, w = 1, h = 1) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.walk[j] && i >= 0 && i < W) this.walk[j][i] = false; };
      // top wall furniture: CEO office (1,1)-(7,3) walls, windows/dispensers row-3 occupied above stands
      solid(0, 0, W, 1);              // north wall
      solid(0, 1, 1, H - 1);          // west wall
      solid(W - 1, 1, 1, H - 1);      // east wall
      solid(0, H - 1, W, 1);          // south wall
      // CEO office walls: x 0..8, y 1..6 walled except door at (5,6)
      for (let x = 0; x <= 8; x++) { this.walk[6][x] = false; }
      for (let y = 1; y <= 6; y++) { this.walk[y][8] = false; }
      this.walk[6][5] = true;         // ceo door
      // boardroom zone x 10..17, y 8..13 (walkable interior, walls on top)
      for (let x = 9; x <= 18; x++) this.walk[7][x] = false;
      this.walk[7][14] = true;        // boardroom door
      this.zones = { boardroom: { x: 10, y: 8, w: 7, h: 5 } };
      // café counter + seats: seats are walkable (characters sit)
      // desks: stamp a 4×2 grid of desk-prefixed spawn tiles in the bullpen
      this.spawn = new Map();
      this.spawn.set('entrance', { x: 18, y: 20 });
      const seatDefs = [];
      // god desk inside CEO office
      seatDefs.push(['desk-ceo', 6, 4]);
      // pc row 1-4 front, 5-8 back (brooklyn99 naming kept)
      let n = 1;
      for (let row = 0; row < 2; row++)
        for (let col = 0; col < 4; col++)
          seatDefs.push([`pc-${n++}`, 11 + col * 4, 10 + row * 5]);
      // named desks on the right wing
      const named = ['desk-chief-architect', 'desk-product-manager', 'desk-team-lead', 'desk-backend-engineer',
        'desk-ui-ux-expert', 'desk-data-engineer', 'desk-project-manager', 'desk-market-researcher', 'desk-agent-organizer'];
      named.forEach((nm, i) => seatDefs.push([nm, 20 + (i % 3) * 4, 9 + Math.floor(i / 3) * 4]));
      // warroom desks bottom-left
      seatDefs.push(['warroom-1', 3, 16], ['warroom-2', 6, 16], ['warroom-3', 3, 18], ['warroom-4', 6, 18]);
      for (const [name, x, y] of seatDefs) {
        this.spawn.set(name, { x, y });
        this.seats.push({ name, x, y });
      }
      // errand stands are walkable (characters stand on them)
      // entrance plaza ring for waitTiles
      this.waitTiles = [];
      const ent = this.spawn.get('entrance');
      for (let r = 0; r <= 6 && this.waitTiles.length < 16; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = ent.x + dx, y = ent.y + dy;
            if (this.walkable(x, y) && !this.waitTiles.some(t => t.x === x && t.y === y))
              this.waitTiles.push({ x, y });
          }
      if (!this.waitTiles.length) this.waitTiles.push(ent);
    }

    walkable(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      return this.walk[y][x];
    }

    // ── agent lifecycle ──
    setAgents(agents, breaker = {}, activity = {}) {
      const seen = new Set();
      for (const a of agents) {
        seen.add(a.id);
        if (!this.sprites.has(a.id)) this.sprites.set(a.id, this._spawn(a));
        const s = this.sprites.get(a.id);
        s.alive = a.alive !== false;
        s.level = s.alive ? (breaker[a.id]?.level ?? 'healthy') : 'dead';
        s.activity = companyActivityTR(activity[a.id] ?? (a.alive ? 'working' : 'paused'));
        s.usage = a.usage;
      }
      for (const [id, s] of [...this.sprites]) {
        if (!seen.has(id)) { if (s.seat != null) this.seatClaims.delete(s.seat); this.sprites.delete(id); }
      }
    }

    _spawn(a) {
      const character = a.character && BY_CHARACTER[a.character] ? a.character
        : ROSTER[Math.abs(this._hash(a.id)) % ROSTER.length] ?? DEFAULT_CHARACTER;
      let seat = null;
      if (a.isGod || a.id === 'god') { seat = 0; this.seatClaims.set(0, a.id); }
      else for (let i = 1; i < this.seats.length; i++)
        if (![...this.seatClaims.values()].length || ![...this.seatClaims.keys()].includes(i)) {
          this.seatClaims.set(i, a.id); seat = i; break;
        }
      const t = seat != null ? this.seats[seat] : (this.spawn.get('entrance'));
      return {
        id: a.id, character, isGod: a.isGod || a.id === 'god', seat,
        tx: t.x, ty: t.y, px: t.x, py: t.y,
        path: [], walking: 0, facing: 'down', state: 'desk',
        bubble: null, bubbleUntil: 0,
        errandAt: performance.now() / 1000 + 15 + Math.random() * 30,
        cafeAt: performance.now() / 1000 + 40 + Math.random() * 60,
        errand: null, errandUntil: 0, brk: null,
        activity: 'çalışıyor', level: 'healthy', alive: true,
      };
    }
    _hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

    // ── movement ──
    _neighbors(x, y) {
      const out = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        if (this.walkable(x + dx, y + dy)) out.push([x + dx, y + dy]);
      return out;
    }
    _findPath(from, to) {                 // BFS on the 36×22 grid — tiny
      if (from.x === to.x && from.y === to.y) return [];
      if (!this.walkable(to.x, to.y)) return null;
      const key = (x, y) => `${x},${y}`;
      const prev = new Map([[key(from.x, from.y), null]]);
      const q = [[from.x, from.y]];
      while (q.length) {
        const [x, y] = q.shift();
        if (x === to.x && y === to.y) {
          const path = [];
          let k = key(x, y);
          while (prev.get(k)) { const [px, py] = k.split(',').map(Number); path.unshift({ x: px, y: py }); k = prev.get(k); }
          return path;
        }
        for (const [nx, ny] of this._neighbors(x, y)) {
          const k = key(nx, ny);
          if (!prev.has(k)) { prev.set(k, key(x, y)); q.push([nx, ny]); }
        }
      }
      return null;
    }
    _walkTo(s, tile, then) {
      const p = this._findPath({ x: s.tx, y: s.ty }, tile);
      if (!p) return false;
      s.path = p; s.walkThen = then; return true;
    }

    // ── behaviors ──
    _tick(now) {
      for (const s of this.sprites.values()) {
        // walking
        if (s.path.length) {
          const n = s.path[0];
          s.walking += 1 / 0.28 * (1 / 60);               // ~0.28s per tile
          const t = Math.min(1, s.walking);
          s.px = s.tx + (n.x - s.tx) * ease(t);
          s.py = s.ty + (n.y - s.ty) * ease(t);
          s.facing = Math.abs(n.x - s.tx) > Math.abs(n.y - s.ty) ? (n.x > s.tx ? 'right' : 'left') : (n.y > s.ty ? 'down' : 'up');
          if (t >= 1) { s.tx = n.x; s.ty = n.y; s.px = n.x; s.py = n.y; s.path.shift(); s.walking = 0; if (!s.path.length && s.walkThen) { const f = s.walkThen; s.walkThen = null; f(); } }
          continue;
        }
        // mid-errand
        if (s.errand) {
          if (now >= s.errandUntil) { s.errand = null; this._goHome(s); }
          continue;
        }
        // café break lingering / pair chat beats
        if (s.brk) {
          const b = s.brk;
          b.timer -= 1 / 60;
          b.quipTimer -= 1 / 60;
          if (b.chat) {
            b.chat.beat -= 1 / 60;
            if (b.chat.beat <= 0) {
              const line = b.chat.lines[b.chat.idx++ % b.chat.lines.length];
              s.bubble = line; s.bubbleUntil = now + 2.8;
              b.chat.beat = 2.8;
              if (b.chat.idx > b.chat.lines.length + 2) b.chat = null;
            }
          } else if (b.quipTimer <= 0) {
            this._emitQuip(s, now); b.quipTimer = 4 + Math.random() * 4;
          }
          if (b.timer <= 0) { this._releaseBreak(s); }
          continue;
        }
        // schedule an errand (god gets godOnly spots; workers skip them)
        if (s.alive && now >= s.errandAt && s.state !== 'walking') {
          const pool = ERRAND_SPOTS.filter(e => s.isGod ? true : !e.godOnly);
          const e = pool[Math.floor(Math.random() * pool.length)];
          if (this._walkTo(s, e.stand, () => {
            s.facing = e.facing; s.errand = e.kind; s.errandUntil = now + e.duration;
          })) { s.errandAt = now + 45 + Math.random() * 60; }
          else s.errandAt = now + 10;
        }
        // café break only when idle/success-ish (alive but no heavy status)
        if (s.alive && !s.isGod && !s.brk && now >= s.cafeAt) {
          const free = [...CAFE_SEATS.map((x, i) => ({ ...x, idx: i, seated: true })),
                        ...CAFE_STANDS.map((x, i) => ({ ...x, idx: CAFE_SEATS.length + i, seated: false }))]
            .filter(c => ![...this.sprites.values()].some(o => o.brk && o.brk.idx === c.idx));
          if (free.length && s.activity === 'boşta') {
            const c = free[Math.floor(Math.random() * free.length)];
            if (this._walkTo(s, c, () => {
              s.facing = c.facing; s.brk = { idx: c.idx, spot: c.spot, timer: 8 + Math.random() * 8, quipTimer: 4 + Math.random() * 4, chat: null };
              this._maybePairChat(s, c, now);
            })) s.cafeAt = now + 120 + Math.random() * 120;
            else s.cafeAt = now + 30;
          } else s.cafeAt = now + 20;
        }
        if (s.bubble && now > s.bubbleUntil) s.bubble = null;
      }
    }
    _goHome(s) {
      const seat = s.seat != null ? this.seats[s.seat] : this.waitTiles[Math.floor(Math.random() * this.waitTiles.length)];
      this._walkTo(s, seat, () => { s.facing = 'down'; });
    }
    _releaseBreak(s) { s.brk = null; this._goHome(s); }
    _emitQuip(s, now) {
      const spot = s.brk?.spot ?? 'table';
      const seed = Math.floor(Math.random() * 1e6);
      const p = iso(s.px, s.py);
      const g = iso(this.godTile.x, this.godTile.y);
      const dist = Math.hypot(p.x - g.x, p.y - g.y);
      if (dist > 96 && Math.random() < 0.35)
        s.bubble = GOSSIP_KEYS[Math.floor(Math.random() * GOSSIP_KEYS.length)];
      else
        s.bubble = pickSoloLine(s.character, spot, seed);
      s.bubbleUntil = now + 3.4;
    }
    _maybePairChat(s, spot, now) {
      if (spot.partner == null || spot.partner < 0) return;
      const partner = [...this.sprites.values()].find(o => o.brk && o.brk.idx === spot.partner && !o.brk.chat);
      if (!partner) return;
      const lines = EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)];
      s.brk.chat = { lines, idx: 0, beat: 1.2 };
      partner.bubble = '👀'; partner.bubbleUntil = now + 1.4;
    }

    // ── render ──
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.cv.parentElement?.clientWidth ?? 900;
      const h = this.cv.parentElement?.clientHeight ?? 480;
      this.cv.width = w * dpr; this.cv.height = h * dpr;
      this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
      this.dpr = dpr;
      if (!this._fitted) { this._fitted = true; this.cam.x = w / 2; this.cam.y = 40; this.cam.z = Math.min(1.4, w / 1250); }
    }
    _start() {
      const loop = (t) => {
        const now = t / 1000;
        if (this._last && now - this._last > 0) this._tick(now);
        this._last = now;
        this._draw(now);
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }
    stop() { cancelAnimationFrame(this._raf); }

    _draw(now) {
      const { cx, cv, cam } = this;
      cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      cx.fillStyle = '#0e0d0b'; cx.fillRect(0, 0, cv.width, cv.height);
      cx.save();
      cx.translate(cam.x, cam.y); cx.scale(cam.z, cam.z);
      this._drawFloor(now);
      this._drawFurniture(now);
      // draw sprites sorted by depth (y)
      const sprites = [...this.sprites.values()].sort((a, b) => a.py - b.py);
      for (const s of sprites) this._drawSprite(s, now);
      for (const s of sprites) { this._drawNameplate(s); if (s.bubble) this._drawBubble(s, now); }
      if (this.season === 'halloween') this._drawHalloween(now);
      cx.restore();
    }
    _tile(tx, ty, fill, stroke) {
      const p = iso(tx, ty), hw = TILE / 2, hh = TILE / 4;
      this.cx.beginPath();
      this.cx.moveTo(p.x, p.y - hh); this.cx.lineTo(p.x + hw, p.y);
      this.cx.lineTo(p.x, p.y + hh); this.cx.lineTo(p.x - hw, p.y);
      this.cx.closePath();
      if (fill) { this.cx.fillStyle = fill; this.cx.fill(); }
      if (stroke) { this.cx.strokeStyle = stroke; this.cx.lineWidth = 0.5; this.cx.stroke(); }
    }
    _drawFloor(now) {
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const checker = (x + y) % 2 === 0;
          let c = checker ? '#1c1a14' : '#1f1c16';
          if (y <= 6 && x <= 8) c = checker ? '#211e18' : '#242019';            // CEO office rug
          else if (x >= 9 && x <= 18 && y >= 8 && y <= 13) c = checker ? '#1d1b20' : '#201d24'; // boardroom
          else if (y >= 19) c = checker ? '#1e1c12' : '#211e14';                // café band
          if (!this.walkable(x, y)) c = '#141209';
          this._tile(x, y, c, '#262218');
        }
      // walls glow on top edge
      for (let x = 0; x < W; x++) this._tile(x, 0, '#2b2619', '#3a321f');
      this._tile(6, 0, '#4a3f22', '#5a4d2a');   // CEO window
    }
    _drawFurniture(now) {
      const { cx } = this;
      const box = (tx, ty, w, h, color, label) => {
        const p = iso(tx + w / 2 - .5, ty + h / 2 - .5);
        const hw = (w * TILE) / 2 - 4, hh = (h * TILE) / 4 - 2;
        cx.fillStyle = '#241f14';
        cx.fillRect(p.x - hw, p.y - hh - 8, hw * 2, hh * 2 + 8);
        cx.fillStyle = color;
        cx.fillRect(p.x - hw + 2, p.y - hh - 6, hw * 2 - 4, hh * 2 + 4);
        if (label) {
          cx.fillStyle = '#0e0d0b'; cx.font = '600 8px ui-monospace, monospace';
          cx.textAlign = 'center'; cx.fillText(label, p.x, p.y - 4);
        }
      };
      // desks: one 1×1 block on each seat tile + monitor dot
      for (const seat of this.seats) {
        const p = iso(seat.x, seat.y);
        cx.fillStyle = '#33291a';
        cx.fillRect(p.x - 11, p.y - 14, 22, 10);
        const on = [...this.sprites.values()].some(s => s.seat === this.seats.indexOf(seat) && s.alive);
        cx.fillStyle = on ? '#6cbf6c' : '#3a352a';
        cx.fillRect(p.x - 3, p.y - 18, 6, 5);                       // monitor led
      }
      // café counter + fridge + machines
      box(22, 19.4, 2, 1, '#4a3a1f', '☕');
      box(23.6, 19.4, 1.4, 1, '#40331c', '🥤');
      box(28.6, 18.4, 1, 1.6, '#2e4a3a', '❄');                       // fridge
      box(29.8, 17.4, 1, 1.2, '#3a3324', '▤');                       // shelf
      // bins
      for (const b of ERRAND_SPOTS.filter(e => e.kind === 'bin')) {
        const p = iso(b.fx.x, b.fx.y);
        cx.fillStyle = '#4a4436'; cx.fillRect(p.x - 4, p.y - 8, 8, 8);
      }
      // plants (water targets)
      for (const w2 of ERRAND_SPOTS.filter(e => e.kind === 'water')) {
        const p = iso(w2.fx.x, w2.fx.y);
        cx.fillStyle = '#3f5a33'; cx.beginPath(); cx.arc(p.x, p.y - 4, 5, 0, 7); cx.fill();
      }
      // windows on north wall
      for (const w2 of ERRAND_SPOTS.filter(e => e.kind === 'window')) {
        const p = iso(w2.fx.x, w2.fx.y);
        cx.fillStyle = '#28435a'; cx.fillRect(p.x - 7, p.y - 10, 14, 8);
      }
      // dispensers
      for (const d of ERRAND_SPOTS.filter(e => e.kind === 'dispenser')) {
        const p = iso(d.fx.x, d.fx.y);
        cx.fillStyle = '#c8d4dc'; cx.fillRect(p.x - 3, p.y - 12, 6, 10);
      }
      // smoke corner (godOnly) — cigarette curl
      const sm = ERRAND_SPOTS.find(e => e.kind === 'smoke');
      const p = iso(sm.fx.x, sm.fx.y);
      cx.strokeStyle = 'rgba(200,200,200,.5)'; cx.beginPath();
      cx.arc(p.x + Math.sin(now) * 2, p.y - 8, 3, 0, 3.2); cx.stroke();
      // boardroom table
      box(11, 9, 5, 2, '#2f2a20', 'BOARDROOM');
      // CEO desk
      box(5.5, 3, 2, 1, '#3a2e1a', 'DÜNDAR');
    }
    _drawSprite(s, now) {
      const { cx } = this;
      const p = iso(s.px, s.py);
      const bob = s.path.length ? Math.abs(Math.sin(now * 14)) * 3 : (s.alive && !s.errand ? Math.sin(now * 2 + this._hash(s.id)) * 1 : 0);
      const y = p.y - bob;
      // shadow
      cx.fillStyle = 'rgba(0,0,0,.35)';
      cx.beginPath(); cx.ellipse(p.x, p.y + 5, 9, 4, 0, 0, 7); cx.fill();
      const coat = LVL_COLOR[s.level] ?? LVL_COLOR.healthy;
      // body (coat)
      cx.fillStyle = s.alive ? coat : '#3a352a';
      cx.beginPath(); cx.roundRect(p.x - 6, y - 16, 12, 14, 4); cx.fill();
      // head
      cx.fillStyle = '#d9c9a8';
      cx.beginPath(); cx.arc(p.x, y - 20, 6, 0, 7); cx.fill();
      // hair by character
      cx.fillStyle = { michael: '#3a2f22', dwight: '#5a4632', jim: '#2f2a24', pam: '#8a5a3a', kevin: '#4a3f30',
        angela: '#c9b896', oscar: '#1f1a14', stanley: '#2a241c', phyllis: '#a89a7a', andy: '#5a3a28',
        kelly: '#241a14', ryan: '#3a3226', toby: '#6a5a44', creed: '#8a8a7a', meredith: '#a86a3a' }[s.character] ?? '#3a3226';
      cx.beginPath(); cx.arc(p.x, y - 23, 5.5, 3.4, 6); cx.fill();
      // face direction indicator (eyes)
      const ex = { left: -2, right: 2, up: 0, down: 0 }[s.facing] ?? 0;
      const ey = s.facing === 'up' ? -1.5 : 0;
      cx.fillStyle = '#1a1408';
      cx.fillRect(p.x - 2.5 + ex, y - 21 + ey, 1.6, 1.6);
      cx.fillRect(p.x + 1 + ex, y - 21 + ey, 1.6, 1.6);
      // errand fx
      if (s.errand === 'water') {
        cx.fillStyle = '#7ab5d9';
        for (let i = 0; i < 4; i++) cx.fillRect(p.x + 8 + i * 2, y - 10 + (i % 2) * 3, 2, 3);
      } else if (s.errand === 'smoke') {
        cx.strokeStyle = 'rgba(220,220,220,.6)';
        cx.beginPath(); cx.arc(p.x + 6, y - 26 - (now % 1) * 6, 2 + (now % 1) * 2, 0, 7); cx.stroke();
      } else if (s.errand === 'bin') {
        cx.fillStyle = '#e9e2cf';
        const t = (now % 1);
        cx.beginPath(); cx.arc(p.x + 8 + t * 8, y - 14 - Math.sin(t * Math.PI) * 8, 2.5, 0, 7); cx.fill();
      }
    }
    _drawNameplate(s) {
      const { cx } = this;
      const p = iso(s.px, s.py);
      const label = s.isGod ? 'Patron' : s.id;
      cx.font = '600 9px ui-monospace, monospace';
      const w = Math.max(cx.measureText(label).width + 14, cx.measureText(s.activity).width + 10);
      cx.fillStyle = 'rgba(14,13,11,.82)';
      cx.beginPath(); cx.roundRect(p.x - w / 2, p.y + 7, w, s.activity ? 20 : 13, 4); cx.fill();
      cx.strokeStyle = 'rgba(42,38,28,.9)'; cx.stroke();
      cx.fillStyle = s.alive ? '#e9e2cf' : '#5a5548';
      cx.textAlign = 'center'; cx.fillText(label, p.x + 4, p.y + 16);
      cx.fillStyle = LVL_COLOR[s.level] ?? LVL_COLOR.healthy;
      cx.beginPath(); cx.arc(p.x - w / 2 + 6, p.y + 13, 2.6, 0, 7); cx.fill();
      if (s.activity) {
        cx.fillStyle = '#8a8270'; cx.font = '8px ui-monospace, monospace';
        cx.fillText(s.activity, p.x, p.y + 24.5);
      }
    }
    _drawBubble(s, now) {
      const { cx } = this;
      const p = iso(s.px, s.py);
      cx.font = '9px -apple-system, sans-serif';
      const text = s.bubble;
      const w = Math.min(190, cx.measureText(text).width + 14);
      const viewW = this.cv.width / this.dpr / this.cam.z;      // world-space viewport width
      const left = -this.cam.x / this.cam.z;                    // world-space left edge
      const x = Math.max(left + 10, Math.min(p.x + 10, left + viewW - w - 10));
      const y = p.y - 46;
      cx.fillStyle = '#e9e2cf';
      cx.beginPath(); cx.roundRect(x, y - 16, w, 18, 5); cx.fill();
      cx.beginPath(); cx.moveTo(x + 10, y + 1); cx.lineTo(x + 16, y + 8); cx.lineTo(x + 20, y + 1); cx.fill();
      cx.fillStyle = '#1a1408'; cx.textAlign = 'left';
      cx.fillText(text.length > 46 ? text.slice(0, 44) + '…' : text, x + 7, y - 3);
    }
    _drawHalloween(now) {
      const { cx } = this;
      // jack-o-lantern at entrance + floating ghosts
      const p = iso(18, 21);
      cx.fillStyle = '#e07a3a'; cx.beginPath(); cx.arc(p.x, p.y - 4, 7, 0, 7); cx.fill();
      cx.fillStyle = '#1a1408';
      cx.fillRect(p.x - 3, p.y - 6, 2, 2); cx.fillRect(p.x + 1, p.y - 6, 2, 2);
      cx.fillRect(p.x - 3, p.y - 2, 6, 1.5);
      const g = iso(14, 10);
      cx.fillStyle = 'rgba(233,226,207,.16)';
      cx.beginPath(); cx.arc(g.x, g.y - 10 - Math.sin(now) * 4, 8, Math.PI, 0); cx.fill();
      cx.fillRect(g.x - 8, g.y - 10 - Math.sin(now) * 4, 16, 10);
    }
    _click(e) {
      const rect = this.cv.getBoundingClientRect();
      const mx = (e.clientX - rect.left - this.cam.x) / this.cam.z;
      const my = (e.clientY - rect.top - this.cam.y) / this.cam.z;
      let best = null, bd = 24;
      for (const s of this.sprites.values()) {
        const p = iso(s.px, s.py);
        const d = Math.hypot(p.x - mx, (p.y - 10) - my);
        if (d < bd) { bd = d; best = s; }
      }
      if (best) this.onSelect(best.id);
    }
  }

  window.OfficeFloor = OfficeFloor;
  window.officeActivityTR = companyActivityTR;
})();
