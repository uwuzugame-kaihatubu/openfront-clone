// server.js — OpenFront Clone — Multiplayer Game Server
// Based on OpenFront (AGPL-3.0) — "Based on OpenFront / openfrontio/OpenFrontIO"

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Constants ──────────────────────────────────────────────────────────────
const TICK_MS      = 250;   // game update interval
const MAP_W        = 80;
const MAP_H        = 55;
const VICTORY_PCT  = 0.80;
const TERRAIN      = { plains: 0, highland: 1, mountain: 2, water: 3 };
const T_DEFENSE    = [1.0, 1.4, 2.0, 0];
const T_GROWTH     = [1.0, 0.7, 0.4, 0];
const T_COLOR_BASE = ['#2d5016','#5a7040','#6b7280','#1a3a5c'];
const BOT_COLORS   = [
  '#4a9eff','#50c878','#ffd700','#da70d6','#ff7f50',
  '#00ced1','#ff69b4','#adff2f','#ff6347','#7b68ee',
  '#20b2aa','#f0e68c','#dc143c','#00fa9a'
];
const BOT_NAMES = [
  'Astra','Boreas','Cyrus','Delphi','Eris','Fenrir','Gaius',
  'Hera','Idris','Juno','Kira','Locus','Mora','Nyx'
];

// ── Room management ────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → Room

function makeRoomId() {
  return Math.random().toString(36).slice(2,7).toUpperCase();
}

class Room {
  constructor(id, hostName, hostWs, opts = {}) {
    this.id         = id;
    this.phase      = 'lobby';  // lobby | playing | ended
    this.players    = [];       // { id, name, color, ws, isBot, alive, troops, gold, nukes, alliances, betrayalTimer }
    this.map        = null;
    this.tick       = 0;
    this.timer      = null;
    this.botCount   = opts.botCount ?? 6;
    this.difficulty = opts.difficulty ?? 'normal';
    this.victoryPct = opts.victoryPct ?? VICTORY_PCT;
    this.nukeGoldCost = opts.nukeGoldCost ?? 2500;

    this._addHuman(hostWs, hostName, opts.color || '#e05c3a', true);
  }

  _addHuman(ws, name, color, isHost = false) {
    const id = this.players.length;
    const p = {
      id, name: sanitize(name), color,
      ws, isBot: false, isHost,
      alive: true, troops: 150, gold: 0, nukes: 0,
      alliances: new Set(), betrayalTimer: 0,
      lastPing: Date.now()
    };
    this.players.push(p);
    ws._room  = this.id;
    ws._pid   = id;
    return p;
  }

  joinHuman(ws, name, color) {
    if (this.phase !== 'lobby') return null;
    if (this.players.filter(p=>!p.isBot).length >= 8) return null;
    return this._addHuman(ws, name, color);
  }

  startGame() {
    this.phase = 'playing';
    this._generateMap();
    this._spawnBots();
    this._assignStartingTiles();
    this._broadcast({ type: 'game_start', map: this._serializeMap(), players: this._serializePlayers() });
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  _generateMap() {
    const W = MAP_W, H = MAP_H;
    this.map = new Array(W * H);
    const noise = (x, y, s, seed) => {
      const xi=Math.floor(x/s), yi=Math.floor(y/s);
      const xf=(x/s)-xi, yf=(y/s)-yi;
      const h=(a,b)=>(Math.sin(a*127.1+b*311.7+seed)*43758.5453)%1;
      const lerp=(a,b,t)=>a+t*(b-a);
      return lerp(lerp(h(xi,yi),h(xi+1,yi),xf),lerp(h(xi,yi+1),h(xi+1,yi+1),xf),yf);
    };
    for (let y=0;y<H;y++) for(let x=0;x<W;x++) {
      const cx=x/W-0.5, cy=y/H-0.5;
      const d=Math.sqrt(cx*cx+cy*cy)*2.2;
      const n=noise(x,y,12,42)*0.5+noise(x,y,6,99)*0.3+noise(x,y,3,7)*0.2-d*0.25;
      let t;
      if(n<-0.12) t=TERRAIN.water;
      else if(n<0.08) t=TERRAIN.plains;
      else if(n<0.22) t=TERRAIN.highland;
      else t=TERRAIN.mountain;
      this.map[y*W+x] = { t, owner:-1, troops:0, nuked:false };
    }
  }

  _spawnBots() {
    const usedColors = new Set(this.players.map(p=>p.color));
    const availColors = BOT_COLORS.filter(c=>!usedColors.has(c));
    for (let i=0;i<this.botCount;i++) {
      this.players.push({
        id: this.players.length,
        name: BOT_NAMES[i % BOT_NAMES.length],
        color: availColors[i % availColors.length],
        ws: null, isBot: true, isHost: false,
        alive: true, troops: 150, gold: 0, nukes: 0,
        alliances: new Set(), betrayalTimer: 0,
        aggrTimer: Math.floor(Math.random()*15)
      });
    }
  }

  _assignStartingTiles() {
    const W=MAP_W, H=MAP_H;
    const landCells=[];
    for(let i=0;i<W*H;i++) if(this.map[i].t!==TERRAIN.water&&this.map[i].t!==TERRAIN.mountain) landCells.push(i);
    shuffle(landCells);

    const starts=[];
    for(let p of this.players) {
      let best=-1, bestDist=-1;
      for(let c of landCells) {
        const cx=c%W, cy=Math.floor(c/W);
        let minD=Infinity;
        for(let s of starts) { const sx=s%W,sy=Math.floor(s/W); minD=Math.min(minD,Math.abs(cx-sx)+Math.abs(cy-sy)); }
        if(minD>bestDist){bestDist=minD;best=c;}
      }
      if(best<0) continue;
      starts.push(best);
      landCells.splice(landCells.indexOf(best),1);
      const bx=best%W, by=Math.floor(best/W);
      for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
        const nx=bx+dx,ny=by+dy;
        if(nx<0||nx>=W||ny<0||ny>=H) continue;
        if(this.map[ny*W+nx].t===TERRAIN.water) continue;
        this.map[ny*W+nx].owner=p.id;
        this.map[ny*W+nx].troops=30;
      }
    }
  }

  _tick() {
    if(this.phase!=='playing') return;
    this.tick++;
    const W=MAP_W;

    // Decay betrayal timers
    for(let p of this.players) if(p.betrayalTimer>0) p.betrayalTimer--;

    // Growth pass
    for(let p of this.players) {
      if(!p.alive) continue;
      const cells=this._getCells(p.id);
      if(cells.length===0){p.alive=false;continue;}
      const maxPop=cells.length*18;
      const growMult = p.troops < maxPop*0.41 ? 1.08 : p.troops < maxPop*0.85 ? 1.02 : 0.98;
      p.troops = Math.min(maxPop, p.troops*growMult + cells.length*0.12);
      p.gold   = Math.min(99999, p.gold + cells.length*0.06);
      if(p.gold>=this.nukeGoldCost && p.nukes<3){ p.nukes++; p.gold-=this.nukeGoldCost; }
    }

    // Spread troops within territory
    for(let i=0;i<W*MAP_H;i++) {
      if(this.map[i].owner>=0) this.map[i].troops=Math.min(600,this.map[i].troops+0.08);
    }

    // Bot AI
    for(let p of this.players) {
      if(!p.isBot||!p.alive) continue;
      p.aggrTimer=(p.aggrTimer||0)+1;
      const interval=this.difficulty==='hard'?4:this.difficulty==='easy'?18:9;
      if(p.aggrTimer<interval) continue;
      p.aggrTimer=0;
      this._botAct(p);
    }

    // Check victory
    const winner=this._checkVictory();
    if(winner) {
      this.phase='ended';
      clearInterval(this.timer);
      this._broadcast({ type:'game_over', winner:winner.id, winnerName:winner.name, winnerColor:winner.color });
      return;
    }

    // Broadcast state delta
    const state = this._buildStateUpdate();
    this._broadcast({ type:'state', ...state });
  }

  _botAct(p) {
    const W=MAP_W;
    const ratio = this.difficulty==='hard'?0.72:this.difficulty==='easy'?0.32:0.52;
    const cells=this._getCells(p.id);
    // Nuke if available and has a big target
    if(p.nukes>0 && Math.random()<0.05) {
      const enemies=this.players.filter(e=>e.alive&&e.id!==p.id&&!p.alliances.has(e.id));
      if(enemies.length>0) {
        const target=enemies[Math.floor(Math.random()*enemies.length)];
        const tCells=this._getCells(target.id);
        if(tCells.length>30) { this._nukeCell(p.id, tCells[Math.floor(Math.random()*tCells.length)]); return; }
      }
    }
    // Try to attack
    for(let ci of shuffle([...cells])) {
      const bx=ci%W,by=Math.floor(ci/W);
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
        if(dx===0&&dy===0) continue;
        const nx=bx+dx,ny=by+dy;
        if(nx<0||nx>=W||ny<0||ny>=MAP_H) continue;
        const ni=ny*W+nx;
        const cell=this.map[ni];
        if(cell.owner===p.id||cell.t===TERRAIN.water) continue;
        if(cell.owner>=0&&p.alliances.has(cell.owner)) continue;
        const force=this.map[ci].troops*ratio;
        const def=cell.troops*T_DEFENSE[cell.t];
        if(force>def) { this._doAttack(p.id,ci,ni,ratio); return; }
      }
    }
  }

  _doAttack(attackerId, fromIdx, toIdx, ratio) {
    const attacker=this.players[attackerId];
    const penMult=attacker.betrayalTimer>0?2.2:1;
    const force=this.map[fromIdx].troops*ratio;
    const def=this.map[toIdx].troops*T_DEFENSE[this.map[toIdx].t]*penMult;
    this.map[fromIdx].troops-=force;
    const prevOwner=this.map[toIdx].owner;
    if(force>def) {
      this.map[toIdx].owner=attackerId;
      this.map[toIdx].troops=Math.max(1,(force-def)*0.5);
      if(prevOwner>=0 && this._getCells(prevOwner).length===0) this.players[prevOwner].alive=false;
    } else {
      this.map[toIdx].troops-=force/penMult;
    }
  }

  _nukeCell(attackerId, centerIdx) {
    const p=this.players[attackerId];
    if(p.nukes<=0) return false;
    p.nukes--;
    const W=MAP_W,H=MAP_H,R=5;
    const cx=centerIdx%W,cy=Math.floor(centerIdx/W);
    for(let dy=-R;dy<=R;dy++) for(let dx=-R;dx<=R;dx++) {
      if(dx*dx+dy*dy>R*R) continue;
      const nx=cx+dx,ny=cy+dy;
      if(nx<0||nx>=W||ny<0||ny>=H) continue;
      const ni=ny*W+nx;
      this.map[ni].nuked=true;
      this.map[ni].troops*=0.08;
      if(Math.random()<0.35){this.map[ni].owner=-1;this.map[ni].troops=0;}
    }
    this._broadcast({ type:'nuke', attacker:attackerId, cx, cy });
    return true;
  }

  _checkVictory() {
    let totalLand=0;
    for(let c of this.map) if(c.t!==TERRAIN.water&&!c.nuked) totalLand++;
    for(let p of this.players) {
      if(!p.alive) continue;
      const pct=this._getCells(p.id).filter(i=>!this.map[i].nuked).length/totalLand;
      if(pct>=this.victoryPct) return p;
    }
    return null;
  }

  _getCells(pid) {
    const result=[];
    for(let i=0;i<this.map.length;i++) if(this.map[i].owner===pid) result.push(i);
    return result;
  }

  _serializeMap() {
    // Pack map as compact arrays for fast transfer
    return {
      w: MAP_W, h: MAP_H,
      terrain: Array.from(this.map, c=>c.t),
      owner:   Array.from(this.map, c=>c.owner),
      troops:  Array.from(this.map, c=>Math.round(c.troops)),
      nuked:   Array.from(this.map, c=>c.nuked?1:0)
    };
  }

  _serializePlayers() {
    return this.players.map(p=>({
      id:p.id, name:p.name, color:p.color,
      isBot:p.isBot, alive:p.alive,
      troops:Math.round(p.troops), gold:Math.round(p.gold),
      nukes:p.nukes, alliances:[...p.alliances]
    }));
  }

  _buildStateUpdate() {
    const owners=[],troops=[],nuked=[];
    for(let c of this.map){
      owners.push(c.owner);
      troops.push(Math.round(c.troops));
      nuked.push(c.nuked?1:0);
    }
    return {
      tick: this.tick,
      map: { owner:owners, troops, nuked },
      players: this._serializePlayers()
    };
  }

  handleMessage(pid, msg) {
    if(this.phase==='lobby') {
      if(msg.type==='start_game' && this.players[pid].isHost) this.startGame();
      return;
    }
    if(this.phase!=='playing') return;
    const p=this.players[pid];
    if(!p||!p.alive) return;

    if(msg.type==='attack') {
      const {from,to,ratio}=msg;
      if(!this._validCell(from)||!this._validCell(to)) return;
      if(this.map[from].owner!==pid) return;
      if(this.map[to].t===TERRAIN.water) return;
      const targetOwner=this.map[to].owner;
      if(targetOwner===pid) return;
      if(targetOwner>=0&&p.alliances.has(targetOwner)) {
        // Break alliance
        p.alliances.delete(targetOwner);
        this.players[targetOwner].alliances.delete(pid);
        p.betrayalTimer=50;
        this._broadcastTo(pid,{type:'notify',msg:'⚠ 同盟を破棄！30秒間ペナルティ中',color:'#ff4444'});
      }
      const r=Math.max(0.05,Math.min(1,ratio||0.5));
      this._doAttack(pid,from,to,r);
    }
    else if(msg.type==='alliance') {
      const targetId=msg.target;
      if(targetId<0||targetId>=this.players.length) return;
      const target=this.players[targetId];
      if(!target||!target.alive||targetId===pid) return;
      if(!p.alliances.has(targetId)) {
        const accept=Math.random()>0.35;
        if(accept) {
          p.alliances.add(targetId);
          target.alliances.add(pid);
          this._broadcastTo(pid,{type:'notify',msg:`🤝 ${target.name}と同盟締結！`,color:'#4aff88'});
          if(!target.isBot) this._broadcastTo(targetId,{type:'notify',msg:`🤝 ${p.name}と同盟締結！`,color:'#4aff88'});
        } else {
          this._broadcastTo(pid,{type:'notify',msg:`❌ ${target.name}が同盟を拒否`,color:'#ff8844'});
        }
      }
    }
    else if(msg.type==='nuke') {
      const {cellIdx}=msg;
      if(!this._validCell(cellIdx)) return;
      this._nukeCell(pid,cellIdx);
    }
  }

  _validCell(idx) { return Number.isInteger(idx)&&idx>=0&&idx<this.map.length; }

  _broadcast(data) {
    const json=JSON.stringify(data);
    for(let p of this.players) if(p.ws&&p.ws.readyState===1) p.ws.send(json);
  }
  _broadcastTo(pid,data) {
    const p=this.players[pid];
    if(p&&p.ws&&p.ws.readyState===1) p.ws.send(JSON.stringify(data));
  }

  getLobbyInfo() {
    return {
      id: this.id,
      phase: this.phase,
      players: this.players.filter(p=>!p.isBot).map(p=>({id:p.id,name:p.name,color:p.color,isHost:p.isHost})),
      botCount: this.botCount,
      difficulty: this.difficulty
    };
  }
}

// ── WebSocket handler ──────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Create or join room
    if(msg.type==='create_room') {
      const id=makeRoomId();
      const room=new Room(id, msg.name||'Player', ws, {
        botCount: msg.botCount??6,
        difficulty: msg.difficulty||'normal',
        color: msg.color||'#e05c3a',
        victoryPct: (msg.victoryPct??80)/100,
        nukeGoldCost: msg.nukeGoldCost??2500
      });
      rooms.set(id,room);
      ws.send(JSON.stringify({ type:'room_created', roomId:id, pid:0, lobby:room.getLobbyInfo() }));
      return;
    }

    if(msg.type==='join_room') {
      const room=rooms.get(msg.roomId?.toUpperCase());
      if(!room){ ws.send(JSON.stringify({type:'error',msg:'ルームが見つかりません'})); return; }
      const p=room.joinHuman(ws, msg.name||'Player', msg.color||'#4a9eff');
      if(!p){ ws.send(JSON.stringify({type:'error',msg:'参加できません（満員またはゲーム中）'})); return; }
      ws.send(JSON.stringify({ type:'room_joined', roomId:room.id, pid:p.id, lobby:room.getLobbyInfo() }));
      // Notify others
      for(let op of room.players) {
        if(op.id!==p.id&&op.ws&&op.ws.readyState===1)
          op.ws.send(JSON.stringify({type:'lobby_update',lobby:room.getLobbyInfo()}));
      }
      return;
    }

    // In-room messages
    const room = ws._room ? rooms.get(ws._room) : null;
    if(!room) return;
    const pid = ws._pid;
    if(pid===undefined) return;

    if(msg.type==='chat') {
      const p=room.players[pid];
      if(p) room._broadcast({type:'chat',name:p.name,color:p.color,text:sanitize(msg.text||'').slice(0,100)});
      return;
    }

    room.handleMessage(pid, msg);
  });

  ws.on('close', () => {
    const room=ws._room?rooms.get(ws._room):null;
    if(room&&ws._pid!==undefined) {
      const p=room.players[ws._pid];
      if(p){p.ws=null;p.alive=false;}
      // Clean up empty rooms
      if(room.players.every(p=>p.isBot||!p.ws||p.ws.readyState!==1)) {
        clearInterval(room.timer);
        rooms.delete(room.id);
      }
    }
  });
});

// Heartbeat
setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(!ws.isAlive){ws.terminate();return;}
    ws.isAlive=false;
    ws.ping();
  });
},30000);

// ── Helpers ────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
  return arr;
}
function sanitize(s) { return String(s).replace(/[<>&"']/g,'').trim().slice(0,30); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌍 OpenFront Clone running on port ${PORT}`));
