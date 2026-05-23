/**
 * OpenFront Clone — Server
 * Based on OpenFront / © OpenFront and Contributors
 * License: AGPL-3.0  https://github.com/openfrontio/OpenFrontIO
 *
 * All constants faithfully ported from src/core/configuration/Config.ts
 * Attack logic from AttackExecution.ts + Config.attackLogic()
 * Annexation from PlayerExecution.ts removeClusters()
 * Map binary format from GameMapImpl (GameMap.ts)
 */

const express  = require('express');
const { WebSocketServer } = require('ws');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

// ─── Terrain binary decoding (GameMapImpl bit layout) ─────────────────────
const IS_LAND_BIT   = 7;
const SHORELINE_BIT = 6;
const OCEAN_BIT     = 5;
const MAG_MASK      = 0x1f;

const isLand  = b => !!(b >> IS_LAND_BIT  & 1);
const isShore = b => !!(b >> SHORELINE_BIT & 1);
const isOcean = b => !!(b >> OCEAN_BIT     & 1);
const getMag  = b =>   b & MAG_MASK;

// Returns 'plains'|'highland'|'mountain'|'water'
function terrType(b) {
  if (!isLand(b)) return 'water';
  if (isShore(b)) return 'shore';   // shoreline sandy color
  const m = getMag(b);
  if (m <= 3)  return 'plains';
  if (m <= 10) return 'highland';
  return 'mountain';
}

// ─── Constants from Config.ts ─────────────────────────────────────────────
const TICK_MS           = 100;       // 10 ticks/s
const ALLIANCE_TICKS    = 3000;      // 300s * 10
const TRAITOR_TICKS     = 300;       // 30s * 10
const TRAITOR_DEF_DEBUFF= 0.5;       // traitorDefenseDebuff()
const TRAITOR_SPD_DEBUFF= 0.8;       // traitorSpeedDebuff()
const DP_RANGE          = 30;        // defensePostRange()
const DP_DEF_BONUS      = 5;         // defensePostDefenseBonus()
const DP_SPD_BONUS      = 3;         // defensePostSpeedBonus()
const SAM_COOLDOWN      = 90;        // SAMCooldown()
const SAM_RANGE_DEFAULT = 70;        // defaultSamRange()
const NUKE_SPEED        = 8;         // defaultNukeSpeed()
const VICTORY_PCT       = 0.80;      // percentageTilesOwnedToWin()
const CITY_TROOP_INC    = 250_000;   // cityTroopIncrease()
const MIN_DIST_PLAYERS  = 30;        // minDistanceBetweenPlayers()
const SPAWN_HUMAN       = 25_000;    // startManpower(human)
const SPAWN_BOT         = 10_000;    // startManpower(bot)

// attackLogic terrain params [mag, speed] from Config.ts
const TERR_PARAMS = {
  plains:   [80,   16.5],
  highland: [100,  20],
  mountain: [120,  25],
  shore:    [80,   16.5],  // treated as plains
};

// nukeMagnitudes from Config.ts
const NUKE_MAG = {
  atom:     { inner: 12, outer: 30  },
  hydrogen: { inner: 80, outer: 100 },
  mirv:     { inner: 12, outer: 18  },  // per warhead
};

// Building costs
function bldCost(type, n) {
  switch (type) {
    case 'city':    return Math.min(1_000_000, Math.pow(2, n) * 125_000);
    case 'port':    return Math.min(1_000_000, Math.pow(2, n) * 125_000);
    case 'dp':      return Math.min(250_000,   (n + 1) * 50_000);
    case 'silo':    return 1_000_000;
    case 'sam':     return Math.min(3_000_000, (n + 1) * 1_500_000);
    default:        return Infinity;
  }
}

// Nuke purchase costs
function nukeCost(type, mirvCount) {
  switch (type) {
    case 'atom':     return 750_000;
    case 'hydrogen': return 5_000_000;
    case 'mirv':     return 25_000_000 + mirvCount * 15_000_000;
    default:         return Infinity;
  }
}

const BOT_NAMES  = ['Boreas','Astra','Cyrus','Delphi','Eris','Fenrir','Gaius',
  'Hera','Idris','Juno','Kira','Locus','Mora','Nyx','Orion','Plex','Qira','Rex',
  'Soma','Tara','Ulric','Vega','Wren','Xara','Yuki','Zane'];

// Bot colors from Colors.ts botColors (muted desaturated)
const BOT_COLORS = [
  'rgb(150,160,140)','rgb(160,160,150)','rgb(170,170,140)','rgb(170,170,120)',
  'rgb(150,160,120)','rgb(150,170,130)','rgb(150,170,150)','rgb(130,170,130)',
  'rgb(140,160,140)','rgb(120,150,100)','rgb(120,140,120)','rgb(100,170,130)',
  'rgb(120,160,150)','rgb(130,160,150)','rgb(120,170,170)','rgb(120,160,190)',
  'rgb(130,150,170)','rgb(130,150,160)','rgb(140,150,160)','rgb(140,160,170)',
];

// ─── Map cache ────────────────────────────────────────────────────────────
const mapCache = new Map();
function loadMap(name) {
  if (mapCache.has(name)) return mapCache.get(name);
  const dir  = path.join(__dirname, 'public', 'maps', name);
  const mani = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const meta = mani.map16x;                          // smallest = best perf
  const bin  = fs.readFileSync(path.join(dir, 'map16x.bin'));
  const terrain = new Uint8Array(bin);
  // nation coords are for the full map; map16x = full/4
  const scaleRatio = mani.map.width / meta.width;    // = 4
  const nations = (mani.nations || []).map(n => ({
    name: n.name,
    x: Math.round(n.coordinates[0] / scaleRatio),
    y: Math.round(n.coordinates[1] / scaleRatio),
  }));
  const result = { terrain, W: meta.width, H: meta.height, nations, name: mani.name };
  mapCache.set(name, result);
  return result;
}

// ─── Utilities ────────────────────────────────────────────────────────────
const shuffle = a => { for (let i=a.length-1;i>0;i--){const j=0|Math.random()*(i+1);[a[i],a[j]]=[a[j],a[i]];}return a; };
const san     = s  => String(s).replace(/[<>&"']/g,'').trim().slice(0, 30);
const clamp   = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const within  = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const d2sq    = (x1,y1,x2,y2) => (x1-x2)**2+(y1-y2)**2;
const mkId    = () => Math.random().toString(36).slice(2,7).toUpperCase();
const fmtN    = n => n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':Math.round(n)+'';

// sigmoid from Util.ts
const sigmoid = (x, k, m) => 1 / (1 + Math.exp(-k * (x - m)));

// ─── Room ─────────────────────────────────────────────────────────────────
const rooms = new Map();

class Room {
  constructor(id, ws, name, color, opts = {}) {
    this.id      = id;
    this.phase   = 'lobby';
    this.mapName = opts.mapName || 'europe';
    this.players = [];
    this.units   = [];    // buildings on map: {tileIdx,x,y,type,owner,cooldown,level}
    this.attacks = [];    // {attackerId,troops,front[],targetId}
    this.nukes   = [];    // {attackerId,sx,sy,tx,ty,nukeType,progress,speed}
    this.terrain = null;
    this.W = 0; this.H = 0;
    this.owner   = null;  // Int16Array
    this.fallout = null;  // Uint8Array
    this.tick    = 0;
    this.timer   = null;
    this.mirvLaunched = 0;
    this.dirtyFallout = false;
    this.opts = {
      botCount:    opts.botCount   ?? 7,
      difficulty:  opts.difficulty || 'normal',
      victoryPct:  opts.victoryPct ?? VICTORY_PCT,
    };
    this._addHuman(ws, name, color, true);
  }

  _mkPlayer(id, name, color, ws, isBot, isHost) {
    return {
      id, name: san(name), color, ws, isBot, isHost,
      alive: true,
      troops: isBot ? SPAWN_BOT : SPAWN_HUMAN,
      gold: 0,
      cities: 0, ports: 0, dps: 0, silos: 0, sams: 0, warships: 0,
      nukes: { atom: 0, hydrogen: 0, mirv: 0 },
      alliances: [],       // [{pid, exp}]
      isTraitor: false, traitorTicks: 0,
      spawnImmunity: 50,   // 5s immunity at start
      _aggrTimer: 0 | Math.random() * 30,
    };
  }

  _addHuman(ws, name, color, isHost = false) {
    const p = this._mkPlayer(this.players.length, name, color, ws, false, isHost);
    this.players.push(p);
    ws._room = this.id;
    ws._pid  = p.id;
    return p;
  }

  joinHuman(ws, name, color) {
    if (this.phase !== 'lobby') return null;
    if (this.players.filter(p => !p.isBot).length >= 8) return null;
    return this._addHuman(ws, name, color, false);
  }

  // ── START ───────────────────────────────────────────────────────────────
  startGame() {
    this.phase = 'playing';
    const map  = loadMap(this.mapName);
    this.terrain = map.terrain;
    this.W = map.W;
    this.H = map.H;
    this.owner   = new Int16Array(this.W * this.H).fill(-1);
    this.fallout = new Uint8Array(this.W * this.H);

    // Add bots
    const usedColors = new Set(this.players.map(p => p.color));
    for (let i = 0; i < this.opts.botCount; i++) {
      const color = BOT_COLORS.find(c => !usedColors.has(c)) || BOT_COLORS[i % BOT_COLORS.length];
      usedColors.add(color);
      this.players.push(this._mkPlayer(
        this.players.length, BOT_NAMES[i % BOT_NAMES.length], color, null, true, false
      ));
    }

    this._spawnAll(map.nations);

    // Send terrain as base64
    this._broadcast({
      type: 'game_start',
      W: this.W, H: this.H,
      mapName: this.mapName,
      terrain: Buffer.from(this.terrain).toString('base64'),
      players: this._serPlayers(),
    });
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  _spawnAll(nations) {
    const W = this.W, H = this.H;
    // Collect land tile indices (not shore, not ocean)
    const landTiles = [];
    for (let i = 0; i < W * H; i++) {
      const b = this.terrain[i];
      if (isLand(b) && !isShore(b)) landTiles.push(i);
    }

    // Build nation spawn lookup (only non-water positions)
    const nationQueue = [];
    for (const n of nations) {
      const ni = n.y * W + n.x;
      if (ni >= 0 && ni < W * H && isLand(this.terrain[ni])) {
        nationQueue.push(ni);
      }
    }

    const starts = [];
    for (const p of this.players) {
      let best = -1;

      // Bots get nation positions first
      if (p.isBot && nationQueue.length > 0) {
        best = nationQueue.shift();
        // Make sure not too close to existing start
        const bx = best % W, by = 0 | best / W;
        for (const s of starts) {
          const sx = s % W, sy = 0 | s / W;
          if (Math.abs(bx - sx) + Math.abs(by - sy) < MIN_DIST_PLAYERS) {
            best = -1;
            break;
          }
        }
      }

      if (best < 0) {
        // Find tile farthest from all existing starts
        let bestDist = -1;
        const sample = shuffle([...landTiles]).slice(0, 600);
        for (const c of sample) {
          const cx = c % W, cy = 0 | c / W;
          let minD = Infinity;
          for (const s of starts) {
            const sx = s % W, sy = 0 | s / W;
            const d = Math.abs(cx - sx) + Math.abs(cy - sy);
            if (d < minD) minD = d;
          }
          if (minD > bestDist) { bestDist = minD; best = c; }
        }
      }

      if (best < 0) continue;
      starts.push(best);

      // Give starting territory radius 8 tiles
      const bx = best % W, by = 0 | best / W, R = 8;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R * R) continue;
        const nx = bx + dx, ny = by + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (!isLand(this.terrain[ni])) continue;
        this.owner[ni] = p.id;
      }
    }
  }

  // ── TICK ─────────────────────────────────────────────────────────────────
  _tick() {
    if (this.phase !== 'playing') return;
    this.tick++;
    const W = this.W, H = this.H;

    // 1. Growth + gold + timers (mirrors PlayerExecution.tick)
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.spawnImmunity > 0) p.spawnImmunity--;
      if (p.traitorTicks > 0) { p.traitorTicks--; if (p.traitorTicks === 0) p.isTraitor = false; }
      p.alliances = p.alliances.filter(a => a.exp > this.tick);

      const tiles = this._count(p.id);
      if (tiles === 0) { p.alive = false; continue; }

      // maxTroops from Config.ts
      const maxT = this._maxTroops(p, tiles);
      // troopIncreaseRate from Config.ts
      let toAdd = (10 + Math.pow(p.troops, 0.73) / 4) * (1 - p.troops / maxT);
      if (p.isBot) toAdd *= 0.5;
      if (p.troops < maxT) p.troops = Math.min(maxT, p.troops + Math.max(0, toAdd));

      // goldAdditionRate from Config.ts: human=100, bot=50
      p.gold += p.isBot ? 50 : 100;
    }

    // 2. SAM cooldowns
    for (const u of this.units) if (u.cooldown > 0) u.cooldown--;

    // 3. Process attacks
    this._processAttacks();

    // 4. Bot AI (every 3 ticks for perf)
    if (this.tick % 3 === 0) {
      for (const p of this.players) if (p.isBot && p.alive) this._botTick(p);
    }

    // 5. Annexation check (every 20 ticks, like ticksPerClusterCalc=20)
    if (this.tick % 20 === 0) this._annexCheck();

    // 6. Nukes
    this._processNukes();

    // 7. Victory
    const winner = this._checkVictory();
    if (winner) {
      this.phase = 'ended';
      clearInterval(this.timer);
      this._broadcast({ type: 'game_over', winner: winner.id, winnerName: winner.name, winnerColor: winner.color });
      return;
    }

    // 8. State broadcast ~10 fps
    if (this.tick % 3 === 0) this._sendState();
  }

  _maxTroops(p, tiles) {
    // From Config.ts maxTroops():
    // 2*(tiles^0.6*1000 + 50000) + cities*cityTroopIncrease
    const base = 2 * (Math.pow(tiles, 0.6) * 1000 + 50_000)
               + p.cities * CITY_TROOP_INC;
    if (p.isBot) return base / 3;
    return base;
  }

  // ── ATTACKS ───────────────────────────────────────────────────────────────
  _processAttacks() {
    const W = this.W, H = this.H;
    const dead = [];

    for (let ai = 0; ai < this.attacks.length; ai++) {
      const atk = this.attacks[ai];
      const att = this.players[atk.attackerId];
      if (!att || !att.alive) { dead.push(ai); continue; }

      const defPlayer = atk.targetId >= 0 ? this.players[atk.targetId] : null;

      // attackTilesPerTick from Config.ts:
      // vs player: within(5*atk/def*2, 0.01, 0.5) * adjTiles * 3
      // vs terra:  adjTiles * 2
      const adjTiles = Math.max(1, atk.front.length);
      let tilesThisTick;
      if (defPlayer && defPlayer.alive) {
        const defTroops = Math.max(1, defPlayer.troops);
        tilesThisTick = Math.max(1, Math.round(
          within((5 * atk.troops / defTroops) * 2, 0.01, 0.5) * adjTiles * 3
        ));
      } else {
        tilesThisTick = Math.max(1, Math.min(adjTiles * 2, 30));
      }

      for (let step = 0; step < tilesThisTick && atk.troops > 0 && atk.front.length > 0; step++) {
        const ti = atk.front.shift();
        if (ti < 0 || ti >= W * H) continue;
        if (this.owner[ti] === atk.attackerId) continue;
        const tb = this.terrain[ti];
        if (!isLand(tb) || this.fallout[ti]) continue;

        const defOwnerId = this.owner[ti];
        const defOwner   = defOwnerId >= 0 ? this.players[defOwnerId] : null;
        // Block allied tiles
        if (defOwner && att.alliances.some(a => a.pid === defOwnerId)) continue;

        const tt  = terrType(tb);
        let [mag, speed] = TERR_PARAMS[tt] || [80, 16.5];

        // Defense post bonus (Config.ts: defensePostDefenseBonus=5, speedBonus=3)
        const tx = ti % W, ty = 0 | ti / W;
        for (const u of this.units) {
          if (u.type !== 'dp' || u.owner !== defOwnerId) continue;
          if (d2sq(u.x, u.y, tx, ty) <= DP_RANGE * DP_RANGE) {
            mag   *= DP_DEF_BONUS;
            speed *= DP_SPD_BONUS;
            break;
          }
        }

        // Traitor debuff on defender: traitorDefenseDebuff=0.5
        const traitorMod = defOwner && defOwner.isTraitor ? TRAITOR_DEF_DEBUFF : 1;

        if (defOwner && defOwner.alive) {
          // Full Config.ts attackLogic formula
          const defTiles  = Math.max(1, this._count(defOwnerId));
          const defTroops = defOwner.troops;

          // Large defender debuff (sigmoid)
          const defenseSig = 1 - sigmoid(defTiles, Math.LN2 / 50_000, 150_000);
          const lgDefSpdDebuff = 0.7 + 0.3 * defenseSig;
          const lgDefAtkDebuff = 0.7 + 0.3 * defenseSig;

          // Large attacker debuff
          const attTiles = this._count(atk.attackerId);
          let lgAtkBonus = 1, lgAtkSpdBonus = 1;
          if (attTiles > 100_000) {
            lgAtkBonus    = Math.sqrt(100_000 / attTiles) ** 0.7;
            lgAtkSpdBonus = (100_000 / attTiles) ** 0.6;
          }

          // Human vs Bot: mag * 0.7
          if (!att.isBot && defOwner.isBot) mag *= 0.7;

          const defTroopLoss = defTroops / defTiles;
          const atkLoss1 = within(defTroops / atk.troops, 0.6, 2) * mag * 0.8
                         * lgDefAtkDebuff * lgAtkBonus * traitorMod;
          const atkLoss2 = 1.3 * defTroopLoss * (mag / 100) * traitorMod;
          const attackerTroopLoss = 0.6 * atkLoss1 + 0.4 * atkLoss2;

          const tilesPerTick = within(defTroops / (5 * atk.troops), 0.2, 1.5)
            * speed * lgDefSpdDebuff * lgAtkSpdBonus
            * (defOwner.isTraitor ? TRAITOR_SPD_DEBUFF : 1);

          if (atk.troops > attackerTroopLoss) {
            atk.troops -= attackerTroopLoss;
            const prevOwner = this.owner[ti];
            this.owner[ti]  = atk.attackerId;
            defOwner.troops = Math.max(0, defTroops - defTroopLoss);
            this._captureUnitsAt(ti, att, defOwner);
            this._expandFront(atk, ti);
            if (this._count(prevOwner) === 0) this.players[prevOwner].alive = false;
          } else {
            defOwner.troops = Math.max(0, defTroops - atk.troops / mag);
            atk.troops = 0;
          }
        } else {
          // TerraNullius: attackerTroopLoss = mag/5 (human) or mag/10 (bot)
          const atkLoss = att.isBot ? mag / 10 : mag / 5;
          if (atk.troops > atkLoss) {
            atk.troops -= atkLoss;
            this.owner[ti] = atk.attackerId;
            this._captureUnitsAt(ti, att, null);
            this._expandFront(atk, ti);
          } else {
            atk.troops = 0;
          }
        }
      }

      if (atk.troops <= 0 || atk.front.length === 0) dead.push(ai);
    }
    for (let i = dead.length - 1; i >= 0; i--) this.attacks.splice(dead[i], 1);
  }

  _captureUnitsAt(ti, captor, prev) {
    for (const u of this.units) {
      if (u.tileIdx !== ti) continue;
      if (u.type === 'dp') {
        // DP: decreaseLevel on capture
        u.level = (u.level || 1) - 1;
        if (u.level <= 0) {
          this.units.splice(this.units.indexOf(u), 1);
          if (prev && prev.dps > 0) prev.dps--;
        } else {
          if (prev && prev.dps > 0) prev.dps--;
          u.owner = captor.id;
          captor.dps++;
        }
      } else {
        const fn = u.type + 's';
        if (prev && prev[fn] > 0) prev[fn]--;
        u.owner = captor.id;
        captor[fn]++;
      }
    }
  }

  _expandFront(atk, ti) {
    const W = this.W, H = this.H;
    const tx = ti % W, ty = 0 | ti / W;
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = tx + dx, ny = ty + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (this.owner[ni] === atk.attackerId || !isLand(this.terrain[ni]) || this.fallout[ni]) continue;
      const defOwnerId = this.owner[ni];
      // Respect alliances
      const att = this.players[atk.attackerId];
      if (defOwnerId >= 0 && att && att.alliances.some(a => a.pid === defOwnerId)) continue;
      if (atk.targetId >= 0 && defOwnerId !== atk.targetId && defOwnerId !== -1) continue;
      if (!atk.front.includes(ni)) atk.front.push(ni);
    }
    if (atk.front.length > 1000) atk.front = atk.front.slice(0, 1000);
  }

  // ── ANNEXATION (PlayerExecution.removeClusters) ───────────────────────
  _annexCheck() {
    const W = this.W, H = this.H;
    for (const target of this.players) {
      if (!target.alive) continue;
      const tiles = this._getTiles(target.id);
      if (!tiles.length) { target.alive = false; continue; }

      // Check if every land neighbor belongs to one single enemy
      const nbOwners = new Set();
      let touchesEdge = false;

      outer:
      for (const ti of tiles) {
        const tx = ti % W, ty = 0 | ti / W;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = tx + dx, ny = ty + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) { touchesEdge = true; break outer; }
          const ni = ny * W + nx;
          if (this.owner[ni] === target.id) continue;
          if (!isLand(this.terrain[ni])) continue;  // water doesn't count
          nbOwners.add(this.owner[ni]);
          if (nbOwners.size > 1) break outer;
        }
      }
      if (touchesEdge || nbOwners.size !== 1) continue;

      const [capId] = nbOwners;
      if (capId < 0 || capId === target.id) continue;
      const cap = this.players[capId];
      if (!cap || !cap.alive) continue;
      if (cap.alliances.some(a => a.pid === target.id)) continue;

      // conquerGoldAmount: bot → all gold, human → half
      const goldGain = target.isBot ? target.gold : Math.floor(target.gold / 2);
      cap.gold += goldGain;
      target.gold = 0;

      for (const ti of tiles) this.owner[ti] = capId;
      for (const u of this.units) {
        if (u.owner !== target.id || u.type === 'dp') continue;
        const fn = u.type + 's';
        if (target[fn] > 0) target[fn]--;
        u.owner = capId;
        cap[fn]++;
      }
      target.alive = false;
      this._broadcastTo(capId, { type: 'notify', msg: `⚡ ${target.name}を包囲制圧！ +${fmtN(goldGain)}G`, color: '#ffd700' });
      this._broadcast({ type: 'event_log', msg: `${cap.name} が ${target.name} を包囲制圧！`, kind: 'gold' });
    }
  }

  // ── NUKES ────────────────────────────────────────────────────────────────
  _processNukes() {
    const dead = [];
    for (let i = 0; i < this.nukes.length; i++) {
      const n = this.nukes[i];
      const totalDist = Math.max(1, Math.hypot(n.tx - n.sx, n.ty - n.sy));
      n.progress += n.speed / totalDist;
      if (n.progress >= 1) { this._nukeImpact(n); dead.push(i); }
    }
    for (let i = dead.length - 1; i >= 0; i--) this.nukes.splice(dead[i], 1);
  }

  _nukeImpact(n) {
    const W = this.W, H = this.H;
    const cx = n.tx, cy = n.ty;

    // SAM intercept check
    for (const u of this.units) {
      if (u.type !== 'sam' || u.cooldown > 0 || u.owner === n.attackerId) continue;
      const range = SAM_RANGE_DEFAULT;
      if (d2sq(u.x, u.y, cx, cy) > range * range) continue;
      u.cooldown = SAM_COOLDOWN;
      // Intercept chances (simplified from SAMLauncherExecution)
      const hit = n.nukeType === 'atom' ? 1.0 : n.nukeType === 'hydrogen' ? 0.5 : 0.3;
      if (Math.random() < hit) {
        this._broadcast({ type: 'sam_intercept', sx: u.x, sy: u.y, tx: cx, ty: cy, nukeType: n.nukeType });
        this._broadcast({ type: 'event_log', msg: `🛡 SAMが${n.nukeType}を迎撃！`, kind: 'good' });
        return;
      }
    }

    // Impact
    const mag = NUKE_MAG[n.nukeType];
    const outer2 = mag.outer * mag.outer;
    for (let dy = -mag.outer; dy <= mag.outer; dy++) {
      for (let dx = -mag.outer; dx <= mag.outer; dx++) {
        if (dx * dx + dy * dy > outer2) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (!isLand(this.terrain[ni])) continue;
        this.fallout[ni]  = 1;
        this.owner[ni]    = -1;
        this.units = this.units.filter(u => u.tileIdx !== ni);
      }
    }
    this.dirtyFallout = true;
    this._broadcast({ type: 'nuke_impact', cx, cy, nukeType: n.nukeType, inner: mag.inner, outer: mag.outer });
    this._broadcast({ type: 'event_log', msg: `💥 ${n.nukeType}着弾！`, kind: 'bad' });
  }

  // ── BOT AI ───────────────────────────────────────────────────────────────
  _botTick(p) {
    p._aggrTimer++;
    const interval = this.opts.difficulty === 'hard' ? 4
                   : this.opts.difficulty === 'easy'  ? 18 : 9;
    if (p._aggrTimer < interval) return;
    p._aggrTimer = 0;

    const W = this.W;
    const tiles = this._getTiles(p.id);
    if (!tiles.length) return;

    // attackAmount: bot → troops/20
    const sent = Math.floor(p.troops / 20);
    if (sent < 1) return;

    // Build border front toward weakest enemy
    const front = [];
    const sample = shuffle([...tiles]).slice(0, 60);
    for (const ft of sample) {
      const fx = ft % W, fy = 0 | ft / W;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = fx + dx, ny = fy + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= this.H) continue;
        const ni = ny * W + nx;
        if (this.owner[ni] === p.id || !isLand(this.terrain[ni]) || this.fallout[ni]) continue;
        const oid = this.owner[ni];
        if (oid >= 0 && p.alliances.some(a => a.pid === oid)) continue;
        front.push(ni);
      }
    }
    if (!front.length) return;

    p.troops -= sent;
    const targetId = this.owner[front[0]] >= 0 ? this.owner[front[0]] : -1;
    this.attacks.push({ attackerId: p.id, troops: sent, front: shuffle(front), targetId });

    // Auto-build city if rich enough
    if (p.gold >= bldCost('city', p.cities) && p.cities < 4 && tiles.length > 80) {
      const ti = tiles[0 | Math.random() * tiles.length];
      if (isLand(this.terrain[ti]) && !this.fallout[ti] && !isShore(this.terrain[ti])) {
        p.gold -= bldCost('city', p.cities);
        p.cities++;
        const x = ti % W, y = 0 | ti / W;
        this.units.push({ tileIdx: ti, x, y, type: 'city', owner: p.id, cooldown: 0, level: 1 });
      }
    }
  }

  // ── VICTORY ──────────────────────────────────────────────────────────────
  _checkVictory() {
    let total = 0;
    for (let i = 0; i < this.W * this.H; i++) {
      if (isLand(this.terrain[i]) && !this.fallout[i]) total++;
    }
    if (!total) return null;
    for (const p of this.players) {
      if (!p.alive) continue;
      if (this._count(p.id) / total >= this.opts.victoryPct) return p;
    }
    return null;
  }

  // ── MESSAGE HANDLING ─────────────────────────────────────────────────────
  handleMessage(pid, msg) {
    if (this.phase === 'lobby') {
      if (msg.type === 'start' && this.players[pid]?.isHost) this.startGame();
      return;
    }
    if (this.phase !== 'playing') return;
    const p = this.players[pid];
    if (!p || !p.alive) return;
    switch (msg.type) {
      case 'attack':      this._onAttack(p, msg);     break;
      case 'build':       this._onBuild(p, msg);      break;
      case 'buy_nuke':    this._onBuyNuke(p, msg);    break;
      case 'launch_nuke': this._onLaunchNuke(p, msg); break;
      case 'alliance':    this._onAlliance(p, msg);   break;
      case 'chat':
        this._broadcast({ type: 'chat', name: p.name, color: p.color, text: san(msg.text || '').slice(0, 100) });
        break;
    }
  }

  _onAttack(p, msg) {
    const W = this.W, H = this.H;
    const { targetId, ratio = 0.2 } = msg;
    const r = clamp(ratio, 0.01, 1.0);

    // Betrayal: break alliance if attacking ally
    if (targetId != null && targetId >= 0 && p.alliances.some(a => a.pid === targetId)) {
      p.alliances = p.alliances.filter(a => a.pid !== targetId);
      const tgt = this.players[targetId];
      if (tgt) tgt.alliances = tgt.alliances.filter(a => a.pid !== p.id);
      p.isTraitor = true;
      p.traitorTicks = TRAITOR_TICKS;
      this._broadcastTo(p.id, { type: 'notify', msg: '⚠ 裏切りペナルティ30秒！', color: '#f85149' });
      if (tgt && !tgt.isBot) this._broadcastTo(tgt.id, { type: 'notify', msg: `⚠ ${p.name}に裏切られた！`, color: '#f85149' });
      this._broadcast({ type: 'event_log', msg: `${p.name} が ${this.players[targetId]?.name||'?'} を裏切った！`, kind: 'bad' });
    }

    // attackAmount: human → troops/5
    const sent = Math.min(Math.floor(p.troops * r), Math.floor(p.troops));
    if (sent < 1) return;
    p.troops -= sent;

    // Build front
    const front = [];
    for (let i = 0; i < W * H; i++) {
      if (this.owner[i] !== p.id) continue;
      const tx = i % W, ty = 0 | i / W;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = tx + dx, ny = ty + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (this.owner[ni] === p.id || !isLand(this.terrain[ni]) || this.fallout[ni]) continue;
        const oid = this.owner[ni];
        if (oid >= 0 && p.alliances.some(a => a.pid === oid)) continue;
        if (targetId != null && targetId >= 0 && oid !== targetId && oid !== -1) continue;
        if (!front.includes(ni)) front.push(ni);
      }
    }
    if (!front.length) { p.troops += sent; return; }
    this.attacks.push({ attackerId: p.id, troops: sent, front: shuffle(front), targetId: targetId ?? -1 });
  }

  _onBuild(p, msg) {
    const { buildType, tileIdx } = msg;
    if (!['city','port','dp','silo','sam'].includes(buildType)) return;
    if (tileIdx < 0 || tileIdx >= this.W * this.H) return;
    if (this.owner[tileIdx] !== p.id) return;
    const tb = this.terrain[tileIdx];
    if (!isLand(tb) || this.fallout[tileIdx]) return;

    // Port must be adjacent to water
    if (buildType === 'port') {
      const x = tileIdx % this.W, y = 0 | tileIdx / this.W;
      const hasWater = [[-1,0],[1,0],[0,-1],[0,1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= this.W || ny < 0 || ny >= this.H) return false;
        return !isLand(this.terrain[ny * this.W + nx]);
      });
      if (!hasWater) {
        this._broadcastTo(p.id, { type: 'notify', msg: '⚓ 港は海岸のみ建設可能', color: '#ff8844' });
        return;
      }
    }

    const fn   = buildType + 's';
    const n    = p[fn] || 0;
    const cost = bldCost(buildType, n);
    if (p.gold < cost) {
      this._broadcastTo(p.id, { type: 'notify', msg: `💰 ゴールド不足 (${fmtN(cost)}G必要)`, color: '#ff8844' });
      return;
    }
    p.gold -= cost;
    p[fn]++;
    const x = tileIdx % this.W, y = 0 | tileIdx / this.W;
    this.units.push({ tileIdx, x, y, type: buildType, owner: p.id, cooldown: 0, level: 1 });
    this._broadcastTo(p.id, { type: 'notify', msg: `✅ ${buildType}を建設`, color: '#3fb950' });
  }

  _onBuyNuke(p, msg) {
    const { nukeType } = msg;
    if (!['atom','hydrogen','mirv'].includes(nukeType)) return;
    if (p.silos <= 0) {
      this._broadcastTo(p.id, { type: 'notify', msg: '🚀 ミサイルサイロが必要', color: '#ff8844' });
      return;
    }
    const cost = nukeCost(nukeType, this.mirvLaunched);
    if (p.gold < cost) {
      this._broadcastTo(p.id, { type: 'notify', msg: `💰 ゴールド不足 (${fmtN(cost)}G)`, color: '#ff8844' });
      return;
    }
    p.gold -= cost;
    p.nukes[nukeType]++;
    this._broadcastTo(p.id, { type: 'notify', msg: `☢ ${nukeType}購入！`, color: '#ffd700' });
  }

  _onLaunchNuke(p, msg) {
    const { nukeType, tx, ty } = msg;
    if (!(p.nukes[nukeType] > 0)) {
      this._broadcastTo(p.id, { type: 'notify', msg: '核兵器がありません', color: '#ff8844' });
      return;
    }
    if (p.silos <= 0) {
      this._broadcastTo(p.id, { type: 'notify', msg: '🚀 サイロが必要', color: '#ff8844' });
      return;
    }
    p.nukes[nukeType]--;

    // Find closest owned silo as launch origin
    const silo = this.units.find(u => u.type === 'silo' && u.owner === p.id);
    const sx = silo ? silo.x : 0 | this.W / 2;
    const sy = silo ? silo.y : 0;

    if (nukeType === 'mirv') {
      this.mirvLaunched++;
      // 3 warheads with random scatter (like MIRVExecution)
      for (let k = 0; k < 3; k++) {
        const ox = 0 | (Math.random() - 0.5) * 30;
        const oy = 0 | (Math.random() - 0.5) * 30;
        this.nukes.push({
          attackerId: p.id, sx, sy,
          tx: clamp(tx + ox, 0, this.W - 1),
          ty: clamp(ty + oy, 0, this.H - 1),
          nukeType: 'mirv', progress: 0, speed: NUKE_SPEED,
        });
      }
    } else {
      this.nukes.push({ attackerId: p.id, sx, sy, tx, ty, nukeType, progress: 0, speed: NUKE_SPEED });
    }

    this._broadcast({ type: 'nuke_launch', attackerId: p.id, nukeType, sx, sy, tx, ty, name: p.name });
    this._broadcast({ type: 'event_log', msg: `${p.name} が ${nukeType} 発射！`, kind: 'bad' });
  }

  _onAlliance(p, msg) {
    const tgt = this.players[msg.targetId];
    if (!tgt || !tgt.alive || tgt.id === p.id) return;
    if (p.alliances.some(a => a.pid === tgt.id)) {
      this._broadcastTo(p.id, { type: 'notify', msg: 'すでに同盟中', color: '#888' });
      return;
    }
    const accept = tgt.isBot ? Math.random() < 0.65 : true;
    if (accept) {
      const exp = this.tick + ALLIANCE_TICKS;
      p.alliances.push({ pid: tgt.id, exp });
      tgt.alliances.push({ pid: p.id, exp });
      this._broadcastTo(p.id, { type: 'notify', msg: `🤝 ${tgt.name}と同盟（5分）`, color: '#3fb950' });
      if (!tgt.isBot) this._broadcastTo(tgt.id, { type: 'notify', msg: `🤝 ${p.name}と同盟`, color: '#3fb950' });
      this._broadcast({ type: 'event_log', msg: `${p.name} と ${tgt.name} が同盟締結`, kind: 'info' });
    } else {
      this._broadcastTo(p.id, { type: 'notify', msg: `❌ ${tgt.name}が同盟を拒否`, color: '#ff8844' });
    }
  }

  // ── HELPERS ──────────────────────────────────────────────────────────────
  _count(pid) { let c = 0; for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === pid) c++; return c; }
  _getTiles(pid) { const r = []; for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === pid) r.push(i); return r; }

  _serPlayers() {
    return this.players.map(p => ({
      id: p.id, name: p.name, color: p.color, isBot: p.isBot, isHost: p.isHost,
      alive: p.alive, troops: Math.round(p.troops), gold: Math.round(p.gold),
      cities: p.cities, ports: p.ports, dps: p.dps, silos: p.silos, sams: p.sams,
      nukes: p.nukes, alliances: p.alliances.map(a => a.pid), isTraitor: p.isTraitor,
    }));
  }

  _sendState() {
    const falloutB64 = this.dirtyFallout ? Buffer.from(this.fallout).toString('base64') : undefined;
    if (this.dirtyFallout) this.dirtyFallout = false;
    this._broadcast({
      type: 'state', tick: this.tick,
      owners:  Array.from(this.owner),
      players: this._serPlayers(),
      units:   this.units.map(u => ({ ti: u.tileIdx, x: u.x, y: u.y, t: u.type, o: u.owner, lv: u.level || 1 })),
      nukes:   this.nukes.map(n => ({ ai: n.attackerId, sx: n.sx, sy: n.sy, tx: n.tx, ty: n.ty, nt: n.nukeType, p: n.progress })),
      fallout: falloutB64,
    });
  }

  getLobby() {
    return {
      id: this.id, phase: this.phase,
      players: this.players.filter(p => !p.isBot).map(p => ({ id: p.id, name: p.name, color: p.color, isHost: p.isHost })),
      opts: this.opts,
    };
  }

  _broadcast(data) {
    const j = JSON.stringify(data);
    for (const p of this.players) if (p.ws?.readyState === 1) p.ws.send(j);
  }
  _broadcastTo(pid, data) {
    const p = this.players[pid];
    if (p?.ws?.readyState === 1) p.ws.send(JSON.stringify(data));
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const id   = mkId();
      const room = new Room(id, ws, msg.name || 'Player', msg.color || '#e05c3a', msg.opts || {});
      rooms.set(id, room);
      ws.send(JSON.stringify({ type: 'created', roomId: id, pid: 0, lobby: room.getLobby() }));
      return;
    }
    if (msg.type === 'join') {
      const room = rooms.get((msg.roomId || '').toUpperCase());
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'ルームが見つかりません' })); return; }
      const p = room.joinHuman(ws, msg.name || 'Player', msg.color || '#4a9eff');
      if (!p)   { ws.send(JSON.stringify({ type: 'error', msg: '参加できません（満員またはゲーム中）' })); return; }
      ws.send(JSON.stringify({ type: 'joined', roomId: room.id, pid: p.id, lobby: room.getLobby() }));
      for (const op of room.players)
        if (!op.isBot && op.id !== p.id && op.ws?.readyState === 1)
          op.ws.send(JSON.stringify({ type: 'lobby_update', lobby: room.getLobby() }));
      return;
    }

    const room = ws._room ? rooms.get(ws._room) : null;
    if (!room || ws._pid === undefined) return;
    room.handleMessage(ws._pid, msg);
  });

  ws.on('close', () => {
    const room = ws._room ? rooms.get(ws._room) : null;
    if (room && ws._pid !== undefined) {
      const p = room.players[ws._pid];
      if (p) p.ws = null;
      if (room.players.every(p => p.isBot || !p.ws || p.ws.readyState !== 1)) {
        clearInterval(room.timer);
        rooms.delete(room.id);
      }
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false; ws.ping();
  });
}, 30_000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`⚔ OpenFront Clone — port ${PORT}`));
