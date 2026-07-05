'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const clients = new Map();

const SUITS = ['♥', '♠', '♣', '♦'];
const SUIT_META = {
  '♥': { key:'apple', name:'りんご', emoji:'🍎', color:'#ff4f68' },
  '♠': { key:'mud', name:'どろんこ', emoji:'💧', color:'#26a7ff' },
  '♣': { key:'cabbage', name:'キャベツ', emoji:'🥬', color:'#40d278' },
  '♦': { key:'corn', name:'トウモロコシ', emoji:'🌽', color:'#ffd84c' },
};

const CPU_CHARACTERS = [
  {
    key:'kamomodoki', name:'かももどき', avatar:'🦆', imagePath:'/cpu_characters/kamomodoki.jpg',
    gender:'female', style:'attack', catchphrase:'マストフォローは祝福です♡',
    motto:['人の不幸は蜜の味','下家のデスロード','ウホッウホッ','そこが地獄の入り口です♡']
  },
  {
    key:'wakumodoki', name:'ワクもどき', avatar:'✊🏻', imagePath:'/cpu_characters/wakumodoki.jpg',
    gender:'female', style:'bold', catchphrase:'やるぞぉ〜✊🏻',
    motto:['できるぞぉ〜✊🏻','あたしゃ、魔神だよ…','いける気しかしない！','大胆に行きます！']
  },
  {
    key:'rikumodoki', name:'リクもどき', avatar:'📋', imagePath:'/cpu_characters/rikumodoki.png',
    gender:'male', style:'steady', catchphrase:'進捗確認します。',
    motto:['締切厳守です','計画通りに進めましょう','リスクを洗い出します','想定外です、落ち着きましょう']
  },
];
const HUMAN_ANIMAL_AVATARS = ['🐶','🐱','🐰','🐻','🐼','🐸','🐵','🦊','🐯','🐮','🐹','🐨','🦁','🐷','🐺','🐔'];

function pickHumanAvatar(room){
  if(!room) return '🐷';
  const humanPlayers = room.players.filter(p=>!p.cpu);
  if(humanPlayers.length===0) return '🐷';
  const used = new Set(humanPlayers.map(p=>p.avatar).filter(Boolean));
  const available = HUMAN_ANIMAL_AVATARS.filter(a=>!used.has(a));
  const pool = available.length ? available : HUMAN_ANIMAL_AVATARS;
  return pool[Math.floor(Math.random()*pool.length)] || '🐶';
}


function uid(prefix='id') { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries=0; tries<100; tries++) {
    let code = '';
    for (let i=0; i<5; i++) code += chars[Math.floor(Math.random()*chars.length)];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}
function clamp(n,min,max){ return Math.max(min, Math.min(max, Number(n)||0)); }
function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function shuffleIds(ids){ return shuffle((ids||[]).map(String)); }
function normalizePenaltyMode(v){ return v === 'faceValue' || v === 'spadeSuit' ? v : 'flat3'; }
function normalizeJokerPenalty(v){ return clamp(Math.abs(Number(v ?? 20)), 0, 999); }
function normalizeJokerPenaltyTiming(v){ return v === 'gameEnd' ? 'gameEnd' : 'perRound'; }
function normalizePickTargetCount(v){ return clamp(Number(v ?? 2), 0, 13); }
function shootThePigEnabled(room){ return !!(room && room.shootPigEnabled && room.madPigEnabled !== false); }

function cardFaceKey(c){ return c && !c.joker ? `${c.suit}${c.rank}` : 'JOKER'; }
function isMadPigCard(room, card){ return !!(room && room.madPigEnabled !== false && card && !card.joker && card.suit === '♠' && card.rank === '11'); }
function playerHasJoker(p){ return !!(p?.hand || []).some(c=>c.joker); }
function playerHasMadPig(room, p){ return !![...(p?.hand || []), ...(p?.scorePile || [])].some(c=>isMadPigCard(room,c)); }
function isJokerOnlyHand(p){ return !!p && p.hand?.length === 1 && p.hand[0].joker; }
function isEmptyHand(p){ return !!p && Array.isArray(p.hand) && p.hand.length === 0; }
function activeTrickInProgress(room){ return room.trick && room.trick.length > 0 && room.trick.length < 4; }
function findRoundEndPid(room){
  const emptyPid = room.players.findIndex(isEmptyHand);
  if(emptyPid >= 0) return emptyPid;
  const jokerOnlyPid = room.players.findIndex(isJokerOnlyHand);
  if(jokerOnlyPid >= 0) return jokerOnlyPid;
  return Number.isInteger(room.endAfterTrickPid) ? room.endAfterTrickPid : -1;
}
function roundEndReason(room, pid){
  const p = room.players[pid];
  if(!p) return 'ラウンド終了条件を満たしました。';
  if(isEmptyHand(p)) return `${p.name} の手札が0枚になりました。`;
  if(isJokerOnlyHand(p)) return `${p.name} の手札がババブタ1枚だけになりました。`;
  return `${p.name} がラウンド終了条件を満たしました。`;
}
function suitOrder(s){ return {'♥':0,'♠':1,'♣':2,'♦':3}[s] ?? 99; }
function sortHand(hand){
  hand.sort((a,b)=>{
    if(a.joker && b.joker) return 0;
    if(a.joker) return 1;
    if(b.joker) return -1;
    return suitOrder(a.suit)-suitOrder(b.suit) || a.val-b.val;
  });
}
function cardText(c, room=null){
  if(!c) return '';
  if(c.joker) return '🐷ババブタ';
  const m = SUIT_META[c.suit] || {emoji:c.suit, name:c.suit};
  return `${m.emoji}${c.rank}${isMadPigCard(room || {madPigEnabled:true}, c) ? ' / マッド・ピッグ' : ''}`;
}
function publicCard(c, room=null){
  if(!c) return null;
  if(c.joker) return { id:c.id, joker:true, label:'ババブタ', name:'ババブタ', emoji:'🐷', color:'#7b4cf6' };
  const m = SUIT_META[c.suit];
  return { id:c.id, joker:false, suit:c.suit, suitKey:m.key, suitName:m.name, emoji:m.emoji, color:m.color, rank:c.rank, val:c.val, mad:isMadPigCard(room || {madPigEnabled:true}, c), label:`${m.name}${c.rank}` };
}
function makeDeck(idPrefix='c'){
  const deck=[]; let n=0;
  for(const suit of SUITS){
    for(let v=1; v<=13; v++) deck.push({ id:`${idPrefix}_${++n}_${suit}_${v}`, suit, rank:String(v), val:v, joker:false });
  }
  deck.push({ id:`${idPrefix}_joker`, joker:true, rank:'JOKER', val:0 });
  return deck;
}
function makeNormalCardsForRound(round){
  const deck=[]; let n=0;
  for(const suit of SUITS){
    for(let v=1; v<=13; v++) deck.push({ id:`r${round}_${++n}_${suit}_${v}_${uid('c')}`, suit, rank:String(v), val:v, joker:false });
  }
  return deck;
}

function defaultOptions(input={}){
  const totalRounds = clamp(input.totalRounds ?? input.rounds ?? 3, 1, 6);
  const madPigEnabled = input.madPigEnabled !== false && input.madPigEnabled !== 'false';
  return {
    totalRounds,
    madPigEnabled,
    jokerPenalty: normalizeJokerPenalty(input.jokerPenalty ?? 20),
    jokerPenaltyTiming: normalizeJokerPenaltyTiming(input.jokerPenaltyTiming),
    penaltyMode: normalizePenaltyMode(input.penaltyMode),
    pickTargetCount: normalizePickTargetCount(input.pickTargetCount ?? 2),
    pass3Enabled: !!(input.pass3Enabled || input.pass3 === 'on'),
    initialPairEnabled: !!(input.initialPairEnabled || input.startPair === 'on'),
    shootPigEnabled: madPigEnabled && !!(input.shootPigEnabled || input.shoot === 'on'),
  };
}

function makePlayer({id, name, cpu=false, host=false, cpuCharacter=null, sessionToken=null, avatar=''}){
  return { id, name: (name || 'Player').slice(0,20), cpu, host, avatar: cpu ? (cpuCharacter?.avatar || '🤖') : (avatar || '🐷'), sessionToken: cpu ? null : (sessionToken || uid('sess')), cpuCharacter, hand:[], scorePile:[], pairs:[], connected:!cpu, speech:null, final:null, passSelection:null, initialPairDone:false, jokerPenaltyBank:0, shootPigPenaltyBank:0, shootPigActivatedRounds:[] };
}
function makeRoom(hostId, hostName, options){
  const code = roomCode();
  const opts = defaultOptions(options);
  const room = {
    code, phase:'lobby', round:1, totalRounds:opts.totalRounds, ...opts,
    players:[makePlayer({id:hostId, name:hostName || 'You', host:true, avatar:'🐷'})],
    lead:null, current:null, leadSuit:null, trick:[], trickNo:1,
    pendingPick:null, trickReview:null, roundSnapshot:null, finalScores:null, removedCard:null,
    log:[], message:'部屋を作成しました。CPUを追加するか、友だちを招待してください。', createdAt:Date.now(), timers:{}, shootPigRoundResults:{}, shootEvent:null, lastPickReveal:null, endAfterTrickPid:null
  };
  rooms.set(code, room);
  log(room, `部屋 ${code} を作成しました。`);
  return room;
}
function getRoomByClient(ws){ const c=clients.get(ws); return c?.roomCode ? rooms.get(c.roomCode) : null; }
function pidByClient(room, ws){ const c=clients.get(ws); if(!room || !c) return -1; return room.players.findIndex(p=>p.id===c.id); }
function log(room, text){
  room.log.push({ at:Date.now(), text:String(text) });
  if(room.log.length > 120) room.log = room.log.slice(-120);
}
function say(room, pid, text){
  const p = room.players[pid]; if(!p || !text) return;
  p.speech = { text:String(text), at:Date.now(), expiresAt:Date.now()+4200 };
}
function clearGameplayTimers(room){
  if(!room || !room.timers) return;
  for(const key of ['review','pickFinish','cpu','cpuPick','cpuPair']){
    if(room.timers[key]) clearTimeout(room.timers[key]);
    room.timers[key] = null;
  }
}
function transferHostIfNeeded(room){
  if(!room) return;
  const hasConnectedHost = room.players.some(p=>p.host && !p.cpu && p.connected);
  if(hasConnectedHost) return;
  const next = room.players.find(p=>!p.cpu && p.connected);
  if(!next) return;
  for(const p of room.players) p.host = false;
  next.host = true;
  log(room, `${next.name} にホストを移譲しました。`);
}

function broadcast(room){
  for(const [ws, client] of clients.entries()){
    if(client.roomCode === room.code && ws.readyState === WebSocket.OPEN){
      ws.send(JSON.stringify({ type:'state', state:sanitizeRoomFor(room, client.id) }));
    }
  }
}
function send(ws, payload){ if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function sessionPayload(room, player){
  if(!room || !player || player.cpu) return null;
  return { roomCode: room.code, playerId: player.id, sessionToken: player.sessionToken, name: player.name };
}
function sendState(ws, type, room, player){
  send(ws, { type, code: room.code, session: sessionPayload(room, player), state: sanitizeRoomFor(room, player.id) });
}
function sanitizeRoomFor(room, viewerId){
  const pid = room.players.findIndex(p=>p.id===viewerId);
  const now = Date.now();
  const playable = pid >= 0 ? [...playableIds(room, pid)] : [];
  const pending = sanitizePendingPick(room, pid);
  const passInfo = sanitizePass(room, pid);
  const pairInfo = sanitizeInitialPair(room, pid);
  return {
    code:room.code, phase:room.phase, round:room.round, totalRounds:room.totalRounds, trickNo:room.trickNo,
    options:{ madPigEnabled:room.madPigEnabled, jokerPenalty:room.jokerPenalty, jokerPenaltyTiming:room.jokerPenaltyTiming, penaltyMode:room.penaltyMode, pickTargetCount:room.pickTargetCount, pass3Enabled:room.pass3Enabled, initialPairEnabled:room.initialPairEnabled, shootPigEnabled:room.shootPigEnabled },
    selfPid:pid, selfId:viewerId, current:room.current, lead:room.lead, leadSuit:room.leadSuit, message:room.message,
    players: room.players.map((p,i)=>({ pid:i, id:p.id, name:p.name, cpu:p.cpu, host:p.host, connected:p.cpu || p.connected, imagePath:p.cpuCharacter?.imagePath || '', avatar:p.cpuCharacter?.avatar || p.avatar || (p.cpu ? '🤖':'🐷'), characterKey:p.cpuCharacter?.key || '', handCount:p.hand.length, pileCount:p.scorePile.length, pairCount:Math.floor(p.pairs.length/2), hasSpeech:!!(p.speech && p.speech.expiresAt>now), speech:p.speech && p.speech.expiresAt>now ? p.speech.text : '', final:p.final || null })),
    hand: pid>=0 ? room.players[pid].hand.map(c=>publicCard(c, room)) : [],
    playableIds: playable,
    trick: room.trick.map(x=>({ pid:x.pid, order:x.order, card:publicCard(x.card, room) })),
    trickReview: room.trickReview ? { until:room.trickReview.until, winnerPid:room.trickReview.winnerPid, weakestPid:room.trickReview.weakestPid, text:room.trickReview.text } : null,
    pendingPick: pending,
    passInfo,
    initialPairInfo: pairInfo,
    roundSnapshot: room.roundSnapshot,
    finalScores: room.finalScores,
    shootEvent: room.shootEvent && room.shootEvent.expiresAt > now ? room.shootEvent : null,
    lastPickReveal: room.lastPickReveal && room.lastPickReveal.expiresAt > now ? room.lastPickReveal : null,
    log: room.log.slice(-40),
  };
}
function sanitizePass(room, pid){
  if(room.phase !== 'passing' || pid < 0) return null;
  const p = room.players[pid];
  return { required: !p.cpu && !Array.isArray(p.passSelection), selectedCount:Array.isArray(p.passSelection)?p.passSelection.length:0, need:3, passableIds:p.hand.filter(c=>!c.joker).map(c=>c.id) };
}
function pairOptionsFor(player, room=null){
  const byRank = new Map();
  for(const c of player.hand){ if(c.joker) continue; if(!byRank.has(c.rank)) byRank.set(c.rank, []); byRank.get(c.rank).push(c); }
  const pairs=[];
  for(const [rank, cards] of byRank.entries()) if(cards.length>=2) pairs.push({ rank, cards:cards.map(c=>publicCard(c, room)) });
  pairs.sort((a,b)=>Number(a.rank)-Number(b.rank));
  return pairs;
}
function sanitizeInitialPair(room, pid){
  if(room.phase !== 'initialPair' || pid < 0) return null;
  const p = room.players[pid];
  return { required: !p.cpu && !p.initialPairDone, done:!!p.initialPairDone, options: pairOptionsFor(p, room) };
}
function sanitizePendingPick(room, pid){
  const pp = room.pendingPick;
  if(!pp) return null;
  const winner = room.players[pp.winnerPid];
  const weakest = room.players[pp.weakestPid];
  const base = { winnerPid:pp.winnerPid, weakestPid:pp.weakestPid, winnerName:winner?.name || '', weakestName:weakest?.name || '', readyAt:pp.readyAt || 0 };
  if(pp.result){
    return { ...base, mode:'result', result:{...pp.result, drawn:publicCard(pp.result.drawn, room), pairCard:publicCard(pp.result.pairCard, room)} };
  }
  if(pp.pairChoice && pid === pp.winnerPid){
    return { ...base, mode:'pairChoice', drawn:publicCard(pp.pairChoice.drawn, room), pairOptions:pp.pairChoice.candidates.map(c=>publicCard(c, room)) };
  }
  if(pp.pairChoice){
    return { ...base, mode:'watchPairChoice', drawn:publicCard(pp.pairChoice.drawn, room) };
  }
  if(pp.targetSelectionRequired && !pp.targetSelectionDone){
    if(pid === pp.weakestPid){
      const sorted = weakest.hand.slice(); sortHand(sorted);
      return { ...base, mode:'chooseTargets', targetCount:pp.targetCount, hand:sorted.map(c=>publicCard(c, room)) };
    }
    return { ...base, mode:'waitTargets', targetCount:pp.targetCount };
  }
  const candidates = pickCandidateCards(room, pp);
  if(pid === pp.winnerPid){
    return { ...base, mode:'pick', count:candidates.length, backs:candidates.map((_,i)=>({index:i})) };
  }
  return { ...base, mode:'watchPick', count:candidates.length };
}

function playableIds(room, pid){
  pid = Number(pid);
  const p = room.players[pid]; if(!p) return new Set();
  if(room.phase !== 'playing' || room.pendingPick || room.trickReview) return new Set();
  if(Number(room.current) !== pid) return new Set();
  const nonJoker = p.hand.filter(c=>c && !c.joker);
  if(!nonJoker.length) return new Set();
  if(!room.leadSuit) return new Set(nonJoker.map(c=>c.id));
  const follow = nonJoker.filter(c=>c.suit === room.leadSuit);
  return new Set((follow.length ? follow : nonJoker).map(c=>c.id));
}
function currentLeadHigh(room){
  if(!room.leadSuit) return 0;
  return room.trick.filter(x=>x.card?.suit===room.leadSuit).reduce((m,x)=>Math.max(m, Number(x.card.val || 0)), 0);
}
function wouldWinCurrentTrick(room, card){
  if(!room || !card || card.joker) return false;
  if(!room.leadSuit) return true;
  if(card.suit !== room.leadSuit) return false;
  return Number(card.val || 0) > currentLeadHigh(room);
}
function judgeWeakestCard(room, leadSuit){
  const offSuit = room.trick.filter(x=>x.card && x.card.suit !== leadSuit);
  const candidates = offSuit.length ? offSuit : room.trick;
  return candidates.slice().sort((a,b)=> a.card.val !== b.card.val ? a.card.val-b.card.val : b.order-a.order)[0];
}
function judgeWinnerCard(room, leadSuit){
  return room.trick.filter(x=>x.card.suit===leadSuit).slice().sort((a,b)=>b.card.val-a.card.val || a.order-b.order)[0];
}

function addCpu(room){
  if(room.players.length >= 4 || room.phase !== 'lobby') return false;
  const used = new Set(room.players.map(p=>p.cpuCharacter?.key));
  const ch = CPU_CHARACTERS.find(c=>!used.has(c.key)) || CPU_CHARACTERS[room.players.filter(p=>p.cpu).length % CPU_CHARACTERS.length];
  room.players.push(makePlayer({ id:uid('cpu'), name:ch.name, cpu:true, cpuCharacter:ch }));
  log(room, `${ch.name} をCPUとして追加しました。`);
  return true;
}

function startGame(room){
  if(room.phase !== 'lobby') return false;
  clearGameplayTimers(room);
  while(room.players.length < 4) addCpu(room);
  for(const p of room.players){ p.hand=[]; p.scorePile=[]; p.pairs=[]; p.final=null; p.jokerPenaltyBank=0; p.shootPigPenaltyBank=0; p.shootPigActivatedRounds=[]; p.shootPigFinalMadPigWaived=false; p.shootPigGameEndJokerWaived=false; }
  const deck = makeDeck(`g${Date.now()}`);
  const normals = deck.filter(c=>!c.joker);
  const removed = normals.splice(Math.floor(Math.random()*normals.length), 1)[0];
  const dealDeck = shuffle([...normals, deck.find(c=>c.joker)]);
  room.removedCard = removed;
  for(let i=0; i<52; i++) room.players[i%4].hand.push(dealDeck[i]);
  for(const p of room.players) sortHand(p.hand);
  room.round = 1; room.trickNo = 1; room.lead = Math.floor(Math.random()*4); room.current = room.lead; room.leadSuit = null; room.trick=[]; room.pendingPick=null; room.trickReview=null; room.roundSnapshot=null; room.finalScores=null; room.shootPigRoundResults={}; room.shootEvent=null; room.lastPickReveal=null; room.endAfterTrickPid=null; room.nextLead=null;
  log(room, `通常カードから1枚を抜き、13枚ずつ配りました。抜いたカードは秘密です。`);
  log(room, `最初のリードは ${room.players[room.lead].name} です。`);
  cpuOpeningLines(room);
  if(room.pass3Enabled){
    room.phase = 'passing'; room.message = '開始時3枚パス：ババブタ以外から3枚選び、次のプレイヤーに渡します。';
    for(const p of room.players) p.passSelection = null;
    autoCpuPass(room);
  } else if(room.initialPairEnabled){
    room.phase = 'initialPair'; room.message = '開始時ペア捨て：同じ数字2枚を任意で浄化できます。';
    for(const p of room.players) p.initialPairDone = false;
    autoCpuInitialPairs(room);
  } else {
    room.phase = 'playing'; room.message = `${room.players[room.current].name} のリードです。`;
    maybeEndAtTurnStart(room);
  }
  broadcast(room); ensureProgress(room);
  return true;
}
function autoCpuPass(room){
  for(const [i,p] of room.players.entries()){
    if(!p.cpu || Array.isArray(p.passSelection)) continue;
    const cards = p.hand.filter(c=>!c.joker).map(c=>({c,score:cpuUnwantedValue(room,p,c)+Math.random()})).sort((a,b)=>b.score-a.score).slice(0,3).map(x=>x.c.id);
    p.passSelection = cards;
    say(room, i, cpuLineFor(room, i, 'passSelect', {targetPid:(i+1)%4, target:room.players[(i+1)%4]?.name}));
  }
  maybeFinishPassPhase(room);
}
function submitPass(room, pid, ids){
  if(room.phase !== 'passing') return;
  const p = room.players[pid]; if(!p || p.cpu || Array.isArray(p.passSelection)) return;
  const set = [...new Set((ids||[]).map(String))];
  const handIds = new Set(p.hand.filter(c=>!c.joker).map(c=>c.id));
  if(set.length !== 3 || !set.every(id=>handIds.has(id))){ room.message='ババブタ以外から3枚選んでください。'; broadcast(room); return; }
  p.passSelection = set;
  log(room, `${p.name} が3枚パスを選びました。`);
  maybeFinishPassPhase(room); broadcast(room); ensureProgress(room);
}
function maybeFinishPassPhase(room){
  if(room.phase !== 'passing') return false;
  if(!room.players.every(p=>Array.isArray(p.passSelection) && p.passSelection.length===3)) return false;
  const outgoing = room.players.map(p=>p.passSelection.map(id=>p.hand.find(c=>c.id===id)).filter(Boolean));
  for(const p of room.players){ p.hand = p.hand.filter(c=>!p.passSelection.includes(c.id)); p.passSelection=null; }
  for(let i=0;i<4;i++){ const to=(i+1)%4; room.players[to].hand.push(...outgoing[i]); }
  for(const p of room.players) sortHand(p.hand);
  log(room, '開始時3枚パスが完了しました。');
  if(room.initialPairEnabled){ room.phase='initialPair'; room.message='開始時ペア捨て：同じ数字2枚を任意で浄化できます。'; for(const p of room.players) p.initialPairDone=false; autoCpuInitialPairs(room); }
  else { room.phase='playing'; room.message=`${room.players[room.current].name} のリードです。`; maybeEndAtTurnStart(room); }
  return true;
}
function autoCpuInitialPairs(room){
  for(const [pid,p] of room.players.entries()){
    if(!p.cpu || p.initialPairDone) continue;
    let did = 0;
    while(true){
      const pairs = pairOptionsFor(p, room);
      if(!pairs.length) break;
      let best=null, bestScore=-Infinity;
      for(const opt of pairs){
        const cards = opt.cards.map(pc=>p.hand.find(c=>c.id===pc.id)).filter(Boolean);
        for(let a=0;a<cards.length;a++) for(let b=a+1;b<cards.length;b++){
          const score = cpuCardHandRisk(room,cards[a]) + cpuCardHandRisk(room,cards[b]) + (isMadPigCard(room,cards[a])||isMadPigCard(room,cards[b])?120:0) + Math.random();
          if(score>bestScore){ bestScore=score; best=[cards[a],cards[b]]; }
        }
      }
      if(!best) break;
      p.hand = p.hand.filter(c=>c.id!==best[0].id && c.id!==best[1].id);
      p.pairs.push(...best); did++;
    }
    p.initialPairDone = true; sortHand(p.hand);
    if(did) say(room,pid,`${cpuLineFor(room, pid, 'initialPair')}（${did}ペア）`);
    else say(room,pid,cpuLineFor(room, pid, 'opening'));
  }
  maybeFinishInitialPairPhase(room);
}
function submitInitialPair(room, pid, ids, skip=false){
  if(room.phase !== 'initialPair') return;
  const p = room.players[pid]; if(!p || p.cpu || p.initialPairDone) return;
  if(skip){ p.initialPairDone=true; log(room, `${p.name} は開始時ペア捨てを終了しました。`); maybeFinishInitialPairPhase(room); broadcast(room); ensureProgress(room); return; }
  const set = [...new Set((ids||[]).map(String))];
  if(set.length !== 2){ room.message='同じ数字の通常カード2枚を選んでください。'; broadcast(room); return; }
  const cards = set.map(id=>p.hand.find(c=>c.id===id)).filter(Boolean);
  if(cards.length!==2 || cards.some(c=>c.joker) || cards[0].rank!==cards[1].rank){ room.message='ペアにできるのは同じ数字の通常カード2枚です。'; broadcast(room); return; }
  p.hand = p.hand.filter(c=>!set.includes(c.id)); p.pairs.push(...cards); sortHand(p.hand);
  log(room, `${p.name} は ${cards[0].rank} のペアを開始時に浄化しました。`);
  room.message='続けてペアを選ぶか、スキップで開始します。';
  maybeFinishInitialPairPhase(room); broadcast(room); ensureProgress(room);
}
function maybeFinishInitialPairPhase(room){
  if(room.phase !== 'initialPair') return false;
  if(!room.players.every(p=>p.initialPairDone)) return false;
  room.phase='playing'; room.message=`${room.players[room.current].name} のリードです。`;
  log(room, '開始時ペア捨てが完了しました。'); maybeEndAtTurnStart(room);
  return true;
}

function playCard(room, pid, cardId){
  if(room.phase !== 'playing') return;
  if(pid !== room.current) return;
  const allowed = playableIds(room, pid);
  if(!allowed.has(String(cardId))){ room.message='そのカードは出せません。マストフォローを確認してください。'; broadcast(room); return; }
  const p = room.players[pid];
  const idx = p.hand.findIndex(c=>c.id===cardId); if(idx<0) return;
  const priorLeadSuit = room.leadSuit;
  const priorLeadHigh = currentLeadHigh(room);
  const card = p.hand.splice(idx,1)[0]; sortHand(p.hand);
  const line = p.cpu ? cpuPlayLine(room,pid,card,priorLeadSuit,priorLeadHigh) : null;
  if(!room.leadSuit) room.leadSuit = card.suit;
  room.trick.push({ pid, card, order:room.trick.length });
  log(room, `${p.name} が ${cardText(card, room)} を出しました。`);
  if(line) say(room,pid,line);
  if(isEmptyHand(p) || isJokerOnlyHand(p)) room.endAfterTrickPid = pid;
  if(room.trick.length >= 4){ resolveTrick(room); }
  else { room.current = (pid+1)%4; room.message = `${room.players[room.current].name} の手番です。`; maybeEndAtTurnStart(room); }
  broadcast(room); ensureProgress(room);
}
function resolveTrick(room){
  if(room.trick.length < 4) return;
  const leadSuit = room.leadSuit;
  const winner = judgeWinnerCard(room, leadSuit);
  const weakest = judgeWeakestCard(room, leadSuit);
  const wp = room.players[winner.pid];
  for(const t of room.trick) wp.scorePile.push(t.card);
  const text = `勝者：${wp.name} / 最弱：${room.players[weakest.pid].name}`;
  room.trickReview = { id:uid('review'), until:Date.now()+5000, winnerPid:winner.pid, weakestPid:weakest.pid, text };
  room.current = null; room.message = `トリック結果確認中：${text}`;
  log(room, `🏆 ${text}。場の4枚は ${wp.name} のごちそう山へ。`);
  if(wp.cpu) say(room, winner.pid, cpuLineFor(room, winner.pid, 'trickResult', {winnerPid:winner.pid, weakestPid:weakest.pid, winnerName:wp.name, weakestName:room.players[weakest.pid]?.name}));
  else if(room.players[weakest.pid]?.cpu) say(room, weakest.pid, cpuLineFor(room, weakest.pid, 'trickResult', {winnerPid:winner.pid, weakestPid:weakest.pid, winnerName:wp.name, weakestName:room.players[weakest.pid]?.name}));
  else cpuTableTalk(room, -1, 'trickResult', {winnerPid:winner.pid, weakestPid:weakest.pid, winnerName:wp.name, weakestName:room.players[weakest.pid]?.name});
  clearTimeout(room.timers.review);
  const reviewId = room.trickReview.id;
  room.timers.review = setTimeout(()=>{ if(rooms.get(room.code)===room) advanceReviewToPick(room, reviewId); }, 5000);
}
function advanceReviewToPick(room, reviewId){
  if(room.phase !== 'playing' || !room.trickReview || room.trickReview.id !== reviewId) return;
  const { winnerPid, weakestPid } = room.trickReview;
  room.trickReview = null;
  const endPid = findRoundEndPid(room);
  if(endPid >= 0){ endRound(room, endPid, roundEndReason(room, endPid)); broadcast(room); return; }
  const wp = room.players[winnerPid], lp = room.players[weakestPid];
  if(lp.hand.length > 0){
    const targetCount = pickCandidateLimit(room, lp);
    const required = normalizePickTargetCount(room.pickTargetCount)>0 && targetCount < lp.hand.length;
    room.pendingPick = { winnerPid, weakestPid, readyAt:Date.now()+(required?999999999:900), result:null, token:uid('pick'), targetCount, targetSelectionRequired:required, targetSelectionDone:!required, targetCandidateIds: required?[]:null, pickOrderIds: required?[]:shuffleIds(lp.hand.map(c=>c.id)) };
    if(required){
      room.message = `🐽 ${lp.name} がピック候補を${targetCount}枚に絞ります。`;
      log(room, `🎯 ${lp.name} がピック候補を${targetCount}枚に絞ります。`);
      if(lp.cpu) say(room, weakestPid, cpuLineFor(room, weakestPid, 'chooseTargets', {targetPid:winnerPid, target:wp.name, count:targetCount}));
      else cpuPickWatchLine(room, winnerPid, weakestPid);
      autoResolveCpuPickTargets(room);
    } else {
      room.message = `🐽 公開ピック！ ${wp.name} が ${lp.name} の袋から1枚選びます。`;
      const line = cpuPickLine(room,winnerPid,weakestPid); if(line) say(room,winnerPid,line);
      if(!line) cpuPickWatchLine(room, winnerPid, weakestPid);
      ensureCpuPick(room);
    }
  } else finishAfterPick(room, winnerPid);
  broadcast(room); ensureProgress(room);
}
function pickCandidateLimit(room, player){
  const n = normalizePickTargetCount(room.pickTargetCount);
  if(n <= 0) return player.hand.length;
  return Math.min(n, player.hand.length);
}
function submitPickTargets(room, pid, ids){
  const pp = room.pendingPick; if(!pp || pp.result || pp.pairChoice) return;
  if(!pp.targetSelectionRequired || pp.targetSelectionDone || pid !== pp.weakestPid) return;
  const lp = room.players[pp.weakestPid], wp = room.players[pp.winnerPid];
  const unique = [...new Set((ids||[]).map(String))];
  const needed = Math.min(pp.targetCount, lp.hand.length);
  if(needed <= 0){
    pp.targetCandidateIds = [];
    pp.pickOrderIds = [];
    pp.targetSelectionDone = true;
    pp.readyAt = Date.now();
    log(room, '⚠️ ピック候補が0枚のため、ピックをスキップします。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  const handIds = new Set(lp.hand.map(c=>c.id));
  if(unique.length !== needed || !unique.every(id=>handIds.has(id))){ room.message=`ピック候補を${needed}枚選んでください。`; broadcast(room); return; }
  pp.targetCandidateIds = shuffleIds(unique); pp.pickOrderIds = pp.targetCandidateIds.slice(); pp.targetSelectionDone = true; pp.readyAt = Date.now()+900;
  room.message = `${lp.name} が候補を${needed}枚に絞りました。${wp.name} が選びます。`;
  log(room, `🎯 ${lp.name} がピック候補を${needed}枚に絞りました。`);
  if(lp.cpu) say(room, pp.weakestPid, cpuLineFor(room, pp.weakestPid, 'chooseTargets', {targetPid:pp.winnerPid, target:wp.name, count:needed}));
  const line = cpuPickLine(room,pp.winnerPid,pp.weakestPid); if(line) say(room,pp.winnerPid,line); else cpuPickWatchLine(room, pp.winnerPid, pp.weakestPid);
  ensureCpuPick(room); broadcast(room); ensureProgress(room);
}
function autoResolveCpuPickTargets(room){
  const pp = room.pendingPick; if(!pp || !pp.targetSelectionRequired || pp.targetSelectionDone) return;
  const lp = room.players[pp.weakestPid]; if(!lp?.cpu) return;
  const ids = chooseCpuPickTargetIds(room, pp.weakestPid, pp.targetCount);
  submitPickTargets(room, pp.weakestPid, ids);
}
function ensurePickOrder(room, pp){
  const lp = room.players[pp.weakestPid]; if(!lp) return [];
  const source = Array.isArray(pp.targetCandidateIds) && pp.targetCandidateIds.length ? pp.targetCandidateIds.map(String) : lp.hand.map(c=>c.id);
  const live = new Set(lp.hand.map(c=>c.id));
  const valid = Array.isArray(pp.pickOrderIds) && pp.pickOrderIds.length === source.length && pp.pickOrderIds.every(id=>source.includes(id) && live.has(id));
  if(!valid) pp.pickOrderIds = shuffleIds(source.filter(id=>live.has(id)));
  return pp.pickOrderIds;
}
function pickCandidateCards(room, pp){
  const lp = room.players[pp.weakestPid]; if(!lp) return [];
  return ensurePickOrder(room, pp).map(id=>lp.hand.find(c=>c.id===id)).filter(Boolean);
}
function doPick(room, pid, index){
  const pp = room.pendingPick; if(!pp || pp.result || pp.pairChoice) return;
  if(pid !== pp.winnerPid) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  if(Date.now() < (pp.readyAt || 0) - 120) return;
  const wp = room.players[pp.winnerPid], lp = room.players[pp.weakestPid];
  const candidates = pickCandidateCards(room, pp);
  if(!candidates.length){
    log(room, '⚠️ ピック候補が空になったため、ピックをスキップして進行します。');
    room.message = 'ピック候補がなくなったため、ピックをスキップして次へ進みます。';
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  const card = candidates[clamp(index,0,candidates.length-1)];
  if(!card){
    log(room, '⚠️ ピック対象カードを取得できなかったため、ピックをスキップして進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  const idx = lp.hand.findIndex(c=>c.id===card.id);
  if(idx<0){
    log(room, '⚠️ ピック対象カードが手札から見つからなかったため、ピックをスキップして進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  const drawn = lp.hand.splice(idx,1)[0]; wp.hand.push(drawn); sortHand(wp.hand); sortHand(lp.hand);
  const text = drawn.joker ? `${wp.name} はババブタを引いた！` : `${wp.name} は ${cardText(drawn, room)} を公開ピックした。`;
  log(room, `🐽 ${text}`);
  room.lastPickReveal = { id:uid('reveal'), drawn:publicCard(drawn, room), winnerName:wp.name, weakestName:lp.name, jokerPenalty:room.jokerPenalty, expiresAt:Date.now()+(drawn.joker?5200:2800) };
  if(!wp.cpu && drawn.joker) cpuTableTalk(room, -1, 'resultJoker', {drawn, winnerName:wp.name, weakestName:lp.name, target:wp.name});
  const pairCandidates = drawn.joker ? [] : wp.hand.filter(c=>!c.joker && c.rank===drawn.rank && c.id!==drawn.id);
  if(pairCandidates.length){
    if(wp.cpu){
      const pairCard = chooseCpuPairCardForDiscard(room, wp, drawn, pairCandidates);
      completePickWithPair(room, pp, drawn, pairCard);
    } else {
      pp.pairChoice = { drawn, candidates:pairCandidates };
      room.message = `${wp.name} は ${drawn.rank} のペア浄化を選べます。`;
      broadcast(room);
    }
  } else completePickWithoutPair(room, pp, drawn);
  ensureProgress(room);
}
function completePickWithoutPair(room, pp, drawn){
  const wp = room.players[pp.winnerPid];
  const text = drawn.joker ? `${wp.name} はババブタを引いた！` : `${wp.name} は ${cardText(drawn, room)} を手札に加えた。`;
  pp.result = { drawn, paired:false, skipped:true, text }; pp.resultAt=Date.now(); pp.pairChoice=null;
  if(wp.cpu) say(room, pp.winnerPid, resultLine(drawn,false,room,pp.winnerPid,{winnerName:wp.name}));
  else cpuTableTalk(room, -1, drawn.joker ? 'resultJoker' : 'resultNormal', {drawn, winnerName:wp.name, target:wp.name});
  room.message = text; broadcast(room);
  schedulePickFinish(room, pp, drawn.joker?4300:2600);
}
function completePickWithPair(room, pp, drawn, pairCard){
  const wp = room.players[pp.winnerPid]; if(!pairCard) return completePickWithoutPair(room, pp, drawn);
  const ids = new Set([drawn.id, pairCard.id]);
  if(![...ids].every(id=>wp.hand.some(c=>c.id===id))) return completePickWithoutPair(room, pp, drawn);
  const paired = wp.hand.filter(c=>ids.has(c.id));
  wp.hand = wp.hand.filter(c=>!ids.has(c.id)); wp.pairs.push(...paired); sortHand(wp.hand);
  const text = `${wp.name} は ${drawn.rank} のおそろいペアを浄化！`;
  pp.result = { drawn, paired:true, skipped:false, pairCard, text }; pp.resultAt=Date.now(); pp.pairChoice=null;
  log(room, `🐽 ${text}`);
  if(wp.cpu) say(room,pp.winnerPid,resultLine(drawn,true,room,pp.winnerPid,{winnerName:wp.name}));
  else cpuTableTalk(room, -1, 'resultPair', {drawn, winnerName:wp.name, target:wp.name});
  room.message = text; broadcast(room); schedulePickFinish(room, pp, 2600);
}
function choosePair(room, pid, cardId, skip=false){
  const pp=room.pendingPick; if(!pp || !pp.pairChoice || pid!==pp.winnerPid) return;
  if(skip){ completePickWithoutPair(room, pp, pp.pairChoice.drawn); return; }
  const pairCard = pp.pairChoice.candidates.find(c=>c.id===cardId); if(!pairCard){ room.message='ペアにするカードを選ぶか、スキップしてください。'; broadcast(room); return; }
  completePickWithPair(room, pp, pp.pairChoice.drawn, pairCard);
}
function schedulePickFinish(room, pp, delay){
  clearTimeout(room.timers.pickFinish);
  const token = pp.token;
  room.timers.pickFinish = setTimeout(()=>{ if(rooms.get(room.code)===room && room.pendingPick?.token===token) finishAfterPick(room, pp.winnerPid); }, delay);
}
function finishAfterPick(room, winnerPid){
  if(room.phase !== 'playing') return;
  room.pendingPick = null; room.trick = []; room.leadSuit = null; room.lead = winnerPid; room.current = winnerPid; room.trickNo++;
  const endPid = findRoundEndPid(room);
  if(endPid >= 0){ endRound(room, endPid, roundEndReason(room, endPid)); broadcast(room); return; }
  if(maybeEndAtTurnStart(room)){ broadcast(room); return; }
  room.message = `次のリード：${room.players[winnerPid].name}`;
  broadcast(room); ensureProgress(room);
}
function maybeEndAtTurnStart(room){
  if(room.phase !== 'playing' || room.pendingPick || room.trickReview) return false;
  if(activeTrickInProgress(room)) return false;
  const endPid = findRoundEndPid(room);
  if(endPid >= 0){ endRound(room, endPid, roundEndReason(room, endPid)); return true; }
  return false;
}

function handPenaltyForRoom(room, player){
  const mode = normalizePenaltyMode(room.penaltyMode); let total=0;
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    if(mode==='faceValue' && isMadPigCard(room,c)) total += 40;
    else if(mode==='faceValue') total += Number(c.val || 0);
    else if(mode==='spadeSuit') { if(isMadPigCard(room,c)) continue; total += c.suit==='♠' ? 3 : 1; }
    else total += 3;
  }
  return total;
}
function madPigPenaltyForRoom(room, player){
  if(room.madPigEnabled === false) return 0;
  const mode = normalizePenaltyMode(room.penaltyMode);
  const cards = [...(player.hand||[]), ...(player.scorePile||[])];
  const mad = cards.filter(c=>isMadPigCard(room,c));
  if(mode==='faceValue') return (player.scorePile||[]).filter(c=>isMadPigCard(room,c)).length * 40;
  return mad.length * 13;
}
function adjustHandPenaltyForShootThePig(room, player, raw, waive){
  if(!waive) return raw;
  const mode = normalizePenaltyMode(room.penaltyMode);
  const madHand = (player.hand||[]).find(c=>isMadPigCard(room,c));
  if(!madHand) return raw;
  if(mode==='faceValue') return Math.max(0, raw - 40);
  return raw;
}
function shouldCheckShootThePigThisRound(room){
  if(!shootThePigEnabled(room)) return false;
  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  return timing === 'perRound' || room.round >= room.totalRounds;
}
function applyShootThePigForRound(room){
  if(!shouldCheckShootThePigThisRound(room)) return null;
  const roundKey = String(room.round);
  if(Object.prototype.hasOwnProperty.call(room.shootPigRoundResults, roundKey)) return room.shootPigRoundResults[roundKey];
  const shooterPid = room.players.findIndex(p=>playerHasJoker(p) && playerHasMadPig(room,p));
  if(shooterPid < 0){ room.shootPigRoundResults[roundKey]=null; return null; }
  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const isFinalRound = room.round >= room.totalRounds;
  const result = { round:room.round, shooterPid, shooterName:room.players[shooterPid].name, penaltyToOthers:10, timing, isFinalRound };
  room.players.forEach((p,i)=>{
    p.shootPigPenaltyBank = p.shootPigPenaltyBank || 0;
    p.shootPigActivatedRounds = p.shootPigActivatedRounds || [];
    if(i===shooterPid){ p.shootPigActivatedRounds.push(room.round); if(isFinalRound) p.shootPigFinalMadPigWaived=true; if(timing==='gameEnd' && isFinalRound) p.shootPigGameEndJokerWaived=true; }
    else p.shootPigPenaltyBank += 10;
  });
  room.shootPigRoundResults[roundKey] = result;
  room.shootEvent = { ...result, id:uid('shoot'), expiresAt:Date.now()+9000 };
  log(room, `🐷🌕 シュート・ザ・ピッグ発動！ ${result.shooterName} はババブタ/マッド失点0、他全員-10点。`);
  cpuTableTalk(room, shooterPid, 'shootActivate', {winnerName:result.shooterName, target:result.shooterName});
  return result;
}
function makeRoundSnapshot(room, reasonPid, reasonText){
  const shootPigResult = applyShootThePigForRound(room);
  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const rows = room.players.map((p,i)=>{
    const pile = p.scorePile.length;
    const hasJoker = playerHasJoker(p);
    const shoot = !!(shootPigResult && shootPigResult.shooterPid===i);
    const roundJokerPenalty = (timing==='perRound' && hasJoker && !shoot) ? room.jokerPenalty : 0;
    if(roundJokerPenalty) p.jokerPenaltyBank = (p.jokerPenaltyBank || 0) + roundJokerPenalty;
    const rawHandPenalty = handPenaltyForRoom(room,p);
    const handPenalty = adjustHandPenaltyForShootThePig(room,p,rawHandPenalty,shoot);
    const rawMadPigPenalty = madPigPenaltyForRoom(room,p);
    const madPigPenalty = shoot ? 0 : rawMadPigPenalty;
    const jokerPenaltyTotal = timing==='perRound' ? (p.jokerPenaltyBank || 0) : 0;
    const shootPigPenalty = p.shootPigPenaltyBank || 0;
    const total = pile - handPenalty - madPigPenalty - jokerPenaltyTotal - shootPigPenalty;
    return { pid:i, name:p.name, handCount:p.hand.length, pile, pairs:Math.floor(p.pairs.length/2), hasJoker, hasMadPigForShoot:playerHasMadPig(room,p), madPig:[...(p.hand||[]),...(p.scorePile||[])].filter(c=>isMadPigCard(room,c)).length, pileScore:pile, handPenalty, rawHandPenalty, madPigPenalty, rawMadPigPenalty, jokerPenalty:roundJokerPenalty, jokerPenaltyTotal, shootThePig:shoot, shootPigPenalty, total };
  });
  return { round:room.round, reasonPid, reasonName:room.players[reasonPid]?.name || '', reasonText, shootPigResult, jokerPenaltyValue:room.jokerPenalty, jokerPenaltyTiming:timing, penaltyMode:room.penaltyMode, rows, createdAt:Date.now() };
}
function score(room){
  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const rows = room.players.map((p,i)=>{
    const pile = p.scorePile.length;
    const finalShootWaiver = !!p.shootPigFinalMadPigWaived;
    const rawHandPenalty = handPenaltyForRoom(room,p);
    const handPenalty = adjustHandPenaltyForShootThePig(room,p,rawHandPenalty,finalShootWaiver);
    const rawMadPigPenalty = madPigPenaltyForRoom(room,p);
    const madPigPenalty = finalShootWaiver ? 0 : rawMadPigPenalty;
    const joker = playerHasJoker(p) ? 1 : 0;
    const jokerPenaltyFromRounds = timing === 'perRound' ? (p.jokerPenaltyBank || 0) : 0;
    const jokerPenaltyAtGameEnd = (timing==='gameEnd' && joker && !p.shootPigGameEndJokerWaived) ? room.jokerPenalty : 0;
    const jokerPenalty = jokerPenaltyFromRounds + jokerPenaltyAtGameEnd;
    const shootPigPenalty = p.shootPigPenaltyBank || 0;
    const total = pile - handPenalty - madPigPenalty - jokerPenalty - shootPigPenalty;
    p.final = { pile, handPenalty, rawHandPenalty, madPigPenalty, rawMadPigPenalty, joker, jokerPenalty, jokerPenaltyFromRounds, jokerPenaltyAtGameEnd, shootPigPenalty, total, shootPigMadPigWaived:finalShootWaiver, shootPigGameEndJokerWaived:!!p.shootPigGameEndJokerWaived, shootPigActivatedRounds:p.shootPigActivatedRounds || [], penaltyMode:room.penaltyMode };
    return { pid:i, name:p.name, ...p.final };
  });
  const best = Math.max(...rows.map(r=>r.total));
  return { rows, winners:rows.filter(r=>r.total===best).map(r=>r.name), best };
}
function endRound(room, reasonPid, reasonText){
  clearGameplayTimers(room);
  room.pendingPick=null; room.trickReview=null;
  room.trick=[]; room.leadSuit=null; room.current=null;
  room.roundSnapshot = makeRoundSnapshot(room, reasonPid, reasonText);
  log(room, `🏁 ラウンド${room.round}終了：${reasonText}`);
  cpuTableTalk(room, reasonPid, 'roundEnd', {targetPid:reasonPid, target:room.players[reasonPid]?.name});
  if(room.round >= room.totalRounds){ room.phase='finished'; room.finalScores = score(room); room.message = `ゲーム終了！ 勝者：${room.finalScores.winners.join('、')}`; }
  else { room.phase='roundEnd'; room.message = `ラウンド${room.round}終了。結果を確認して次へ進んでください。`; room.nextLead = reasonPid; }
}
function continueRound(room){
  if(room.phase !== 'roundEnd') return;
  clearGameplayTimers(room);
  room.round++; room.trickNo = 1; room.roundSnapshot = null; room.trick=[]; room.leadSuit=null; room.pendingPick=null; room.trickReview=null; room.endAfterTrickPid=null;
  refillHands(room);
  room.lead = Number.isInteger(room.nextLead) ? room.nextLead : 0; room.current = room.lead; room.phase='playing'; room.message = `ラウンド${room.round}開始。${room.players[room.current].name} のリードです。`;
  log(room, `ラウンド${room.round}開始。残り手札を持ち越し、通常カードで13枚まで補充しました。`);
  cpuTableTalk(room, room.current, 'opening', {leadPid:room.current});
  maybeEndAtTurnStart(room); broadcast(room); ensureProgress(room);
}
function refillHands(room){
  const activeFaces = new Set();
  for(const p of room.players) for(const c of p.hand) if(!c.joker) activeFaces.add(cardFaceKey(c));
  const removedFace = room.removedCard && !room.removedCard.joker ? cardFaceKey(room.removedCard) : null;
  if(removedFace) activeFaces.add(removedFace);
  let pool = shuffle(makeNormalCardsForRound(room.round).filter(c=>!activeFaces.has(cardFaceKey(c))));
  for(const p of room.players){
    while(p.hand.length < 13 && pool.length){
      const card = pool.shift();
      p.hand.push(card); activeFaces.add(cardFaceKey(card));
      pool = pool.filter(c=>!activeFaces.has(cardFaceKey(c)));
    }
    sortHand(p.hand);
  }
}

function cpuCharacter(player){ return player?.cpuCharacter || null; }
function cpuShootPotential(room, player){ return !!(shootThePigEnabled(room) && playerHasJoker(player) && playerHasMadPig(room, player)); }
function cpuCardHandRisk(room, card){
  if(!card) return 0; if(card.joker) return room?.jokerPenalty ?? 20;
  const mode=normalizePenaltyMode(room?.penaltyMode);
  if(isMadPigCard(room,card)) return mode==='faceValue' ? 40 : 13;
  if(mode==='faceValue') return Number(card.val || 0);
  if(mode==='spadeSuit') return card.suit==='♠' ? 3 : 1;
  return 3;
}
function cpuHandRisk(room, player){ return (player?.hand||[]).reduce((s,c)=>s+cpuCardHandRisk(room,c),0); }
function cpuSuitCounts(player){ const counts={'♠':0,'♥':0,'♦':0,'♣':0}; for(const c of player?.hand||[]) if(c&&!c.joker&&counts[c.suit]!=null) counts[c.suit]++; return counts; }
function cpuPersonalityWeights(player){
  const ch=cpuCharacter(player);
  if(ch?.key==='kamomodoki') return {win:1.28,dump:1.08,risk:.82,chaos:.22,shoot:1.02};
  if(ch?.key==='wakumodoki') return {win:1.08,dump:.92,risk:.55,chaos:.62,shoot:1.34};
  if(ch?.key==='rikumodoki') return {win:.72,dump:1.22,risk:1.34,chaos:.04,shoot:.78};
  return {win:1,dump:1,risk:1,chaos:.18,shoot:1};
}
function cpuCardPlayScore(room, pid, card){
  const player=room.players[pid], ch=cpuCharacter(player), w=cpuPersonalityWeights(player), mode=normalizePenaltyMode(room.penaltyMode);
  const risk=cpuCardHandRisk(room,card), isMad=isMadPigCard(room,card), shoot=cpuShootPotential(room,player), counts=cpuSuitCounts(player), suitCount=counts[card.suit]||0;
  const lowCard=14-Number(card.val||0), highCard=Number(card.val||0), leadSuit=room.leadSuit;
  let score=Math.random()*(8+w.chaos*22);
  if(shoot && isMad) score -= 420*w.shoot;
  if(!leadSuit){
    if(ch?.key==='kamomodoki'){ score += highCard*9*w.win; score += suitCount<=2?22:0; score += risk*(mode==='faceValue'?1:.45); }
    else if(ch?.key==='wakumodoki'){ score += Math.random()<.55 ? highCard*8 : lowCard*6; score += shoot&&!isMad?28:0; score += risk*.35; }
    else { score += lowCard*9; score += suitCount<=2?16:0; score -= risk*3.5*w.risk; if(cpuHandRisk(room,player)>=34) score += risk*2.2; }
    if(isMad && !shoot) score -= 140; return score;
  }
  const follow = card.suit===leadSuit, canWin=wouldWinCurrentTrick(room,card);
  if(!follow){ score += risk*18*w.dump; score += highCard*.7; if(mode==='spadeSuit'&&card.suit==='♠') score += 18; if(isMad&&!shoot) score += 260; if(shoot&&isMad) score -= 780; return score; }
  if(canWin){ const over=Number(card.val||0)-currentLeadHigh(room); score += (80-over*7)*w.win; score -= risk*8*w.risk; if(ch?.key==='kamomodoki') score += 40; if(ch?.key==='wakumodoki') score += 24+Math.random()*26; if(ch?.key==='rikumodoki'&&over<=2) score += 42; if(isMad&&shoot) score +=260; if(isMad&&!shoot) score -=360; return score; }
  score += risk*11*w.dump; score += highCard*2.2; score += lowCard*.6; if(isMad&&!shoot) score +=240; if(shoot&&isMad) score -=620; return score;
}
function chooseCpuCard(room, pid){
  const allowed=[...playableIds(room,pid)]; const player=room.players[pid];
  const cards=allowed.map(id=>player.hand.find(c=>c.id===id)).filter(Boolean); if(!cards.length) return null;
  return cards.map(card=>({card,score:cpuCardPlayScore(room,pid,card)})).sort((a,b)=>b.score-a.score || a.card.val-b.card.val)[0].card;
}
function chooseCpuPairCardForDiscard(room, player, drawn, candidates){
  return candidates.slice().map(c=>({card:c, score:cpuCardHandRisk(room,c)+(isMadPigCard(room,c)?100:0)+Math.random()})).sort((a,b)=>b.score-a.score)[0]?.card || null;
}
function chooseCpuPickIndex(room, pp, candidates){ const n=Array.isArray(candidates)?candidates.length:0; return n<=0 ? 0 : Math.floor(Math.random()*n); }
function cpuUnwantedValue(room, player, card){
  if(!card) return -999999; const mode=normalizePenaltyMode(room.penaltyMode), shoot=cpuShootPotential(room,player), mad=isMadPigCard(room,card);
  if(shoot&&card.joker) return -250000; if(shoot&&mad) return -180000;
  if(card.joker) return 1000000; if(mad) return mode==='faceValue'?900000:720000;
  let value=cpuCardHandRisk(room,card)*120; if(mode==='faceValue') value += Number(card.val||0)*42; if(mode==='spadeSuit'&&card.suit==='♠') value += 180;
  const same=(player.hand||[]).filter(c=>!c.joker&&c.rank===card.rank).length; if(same>=2) value -= 140; if((player.hand||[]).length<=4) value += Number(card.val||0)*12; if(Number(card.val||0)<=3) value -=70; return value;
}
function chooseCpuPickTargetIds(room, weakestPid, count){
  const p=room.players[weakestPid]; if(!p) return [];
  return p.hand.slice().map(c=>({card:c,value:cpuUnwantedValue(room,p,c),tie:Math.random()})).sort((a,b)=>b.value-a.value || a.tie-b.tie).slice(0,Math.max(0,count)).map(x=>x.card.id);
}
function cpuDisplayName(room, pid){ return room?.players?.[pid]?.name || 'プレイヤー'; }
function cpuHonorName(name){ return name ? `「${String(name).slice(0,20)}」さん` : 'そちら'; }
function cpuCardLabel(card, room=null){ return card ? cardText(card, room).replace(/🐷/g,'').trim() : 'そのカード'; }
function cpuPenaltyModeLabel(room){
  const mode = normalizePenaltyMode(room?.penaltyMode);
  if(mode === 'faceValue') return '数字分失点';
  if(mode === 'spadeSuit') return 'どろんこ重め';
  return '1枚-3点';
}
function cpuRuleKeyword(room){
  const words = [];
  words.push(cpuPenaltyModeLabel(room));
  if(shootThePigEnabled(room)) words.push('シュート狙いあり');
  if(normalizePickTargetCount(room?.pickTargetCount) > 0) words.push(`候補${normalizePickTargetCount(room.pickTargetCount)}枚`);
  if(normalizeJokerPenaltyTiming(room?.jokerPenaltyTiming) === 'perRound') words.push('ババ毎R');
  return words.join(' / ');
}
function cpuEndgame(room, player){ return (player?.hand || []).length <= 4; }
function cpuAnyHumanName(room){ return room?.players?.find(p=>!p.cpu)?.name || 'プレイヤー'; }
function cpuTableTalk(room, preferPid, type, ctx={}){
  if(!room) return;
  let pid = Number.isInteger(preferPid) && room.players[preferPid]?.cpu ? preferPid : -1;
  if(pid < 0){
    const candidates = room.players.map((p,i)=>({p,i})).filter(x=>x.p.cpu);
    if(!candidates.length) return;
    pid = sample(candidates).i;
  }
  const text = cpuLineFor(room, pid, type, ctx);
  if(text) say(room, pid, text);
}
function cpuOpeningLines(room){
  for(const [pid,p] of room.players.entries()){
    if(!p.cpu) continue;
    say(room, pid, cpuLineFor(room, pid, 'opening', {leadPid:room.lead}));
  }
}
function cpuLineFor(room, pid, type, ctx={}){
  const player = room.players[pid];
  const ch = cpuCharacter(player);
  if(!ch) return '';
  const key = ch.key;
  const targetName = ctx.target || ctx.targetName || (Number.isInteger(ctx.targetPid) ? cpuDisplayName(room, ctx.targetPid) : '');
  const target = cpuHonorName(targetName || cpuAnyHumanName(room));
  const winnerName = ctx.winnerName || (Number.isInteger(ctx.winnerPid) ? cpuDisplayName(room, ctx.winnerPid) : '');
  const weakestName = ctx.weakestName || (Number.isInteger(ctx.weakestPid) ? cpuDisplayName(room, ctx.weakestPid) : '');
  const winner = cpuHonorName(winnerName);
  const weakest = cpuHonorName(weakestName);
  const card = ctx.card || ctx.drawn || null;
  const cardName = cpuCardLabel(card, room);
  const mode = normalizePenaltyMode(room?.penaltyMode);
  const pickN = normalizePickTargetCount(room?.pickTargetCount);
  const shootOn = shootThePigEnabled(room);
  const rules = cpuRuleKeyword(room);
  const handRisk = cpuHandRisk(room, player);
  const endgame = cpuEndgame(room, player);

  const common = {
    opening:[
      `${ch.catchphrase} 今回は${rules}ですね。`,
      `${ch.motto?.[0] || ch.catchphrase}。${target}、よろしくお願いします。`,
      `手札13枚、確認しました。${rules}で進めます。`
    ],
    passSelect:[
      `${target}へ3枚流します。ババブタは渡せませんからね。`,
      `3枚パス、危険度順に選びました。${target}、受け取ってください。`,
      `パス完了です。${target}の手札、少しにぎやかになります。`
    ],
    initialPair:[
      `開始前にペア浄化。手札を軽くします。`,
      `同じ数字を整理しました。${mode==='faceValue'?'数字分失点なので重要です。':'まずは安全化です。'}`,
      `ペアを落として身軽にしました。`
    ],
    trickResult:[
      `${winner}が勝ち、${weakest}が最弱です。ここからピックが本番です。`,
      `勝者${winner}、最弱${weakest}。袋がざわついています。`,
      `場の4枚は${winner}のごちそう山へ。${weakest}は要注意です。`
    ],
    chooseTargets:[
      `候補${ctx.count || pickN}枚に絞ります。中身は見せません。`,
      `この袋から選ばせます。${target}、引く勇気ありますか？`,
      `ピック候補を選定します。ババブタの所在は秘密です。`
    ],
    pickWin:[
      `${target}、ごめんね。袋の中を1枚いただきます。`,
      `${target}の袋、荒らします。中身は公開ですよ。`,
      `公開ピックです。${target}、恨みっこなしでお願いします。`
    ],
    pickWatch:[
      `${winner}が${weakest}から引きます。ここ、空気が変わります。`,
      `候補${ctx.count || pickN || '全'}枚。ババブタが見える気がします。`,
      `ピックは中身を見ない。ここは本当に運です。`
    ],
    resultNormal:[
      `${cardName}を公開ピック。危険札でないだけ平和です。`,
      `公開情報、${cardName}です。次の展開に効きます。`,
      `${cardName}が移動しました。手札管理が変わります。`
    ],
    resultJoker:[
      `ババブタ公開！これは一気に空気が重くなります。`,
      `${target}、ババブタです。失点${room?.jokerPenalty ?? 20}点が見えています。`,
      `来ました、ババブタ。袋の中の地雷でした。`
    ],
    resultPair:[
      `${cardName}でペア浄化。これは手札が軽くなります。`,
      `ペア成立、ナイス浄化です。危険札なら特に大きい。`,
      `おそろいペアで処理完了。計算が変わります。`
    ],
    shootThreat:[
      `ババブタとマッド・ピッグの気配……シュートもありますね。`,
      `シュート・ザ・ピッグ圏内です。これは荒れます。`,
      `ババ＋マッドのコンボ、誰が抱えるか見ものです。`
    ],
    shootActivate:[
      `シュート・ザ・ピッグ！本人0、他全員-10。盤面がひっくり返りました。`,
      `MOON SHOT COMBOです。これは派手に決まりました。`,
      `ババブタとマッド・ピッグを抱え切りました。全員に圧がかかります。`
    ],
    roundEnd:[
      `ラウンド終了です。${rules}の影響が点数に出ます。`,
      `結果確認しましょう。ババブタとマッドの所在が重要です。`,
      `一度棚卸しです。ごちそう山と残り手札を見ます。`
    ]
  };

  const lines = {
    kamomodoki:{
      opening:[`マストフォローは祝福です♡ ${target}、今日も下家のデスロードへようこそ。`, `人の不幸は蜜の味。${rules}、最高ですね♡`, `ウホッウホッ。ババブタの押し付け合い、始めましょう♡`],
      playLeadHigh:[`高札で踏みます♡ ${target}、ごめんね♡`, `この${cardName}で圧をかけます♡`, `下家のデスロード、開通♡`],
      playLeadLow:[`小さく見せておきます♡`, `まだ牙は隠します。${target}が焦るところを見たいので♡`, `低めで様子見。人の不幸は後半に熟します♡`],
      dumpDanger:[`その危険札、置いていきます♡`, `${cardName}は持っていたくないので処理します♡`, `ウホッ、厄介払いです。${target}、拾ってもいいですよ♡`],
      offSuit:[`フォローなし。自由って最高♡`, `そのスート、持ってませーん♡ ${cardName}で逃げます。`, `${target}、マストフォローできない時が一番楽しいんです♡`],
      followWin:[`勝ちに行きます♡ ごちそう回収です。`, `${cardName}でいただきます。${target}、ごめんね♡`, `ここは踏みます。人の不幸は蜜の味♡`],
      followLow:[`低めでかわします。`, `ここはしゃがみます♡`, `最弱だけは避けたいですね♡`],
      chooseTargets:[`候補${ctx.count || pickN}枚、悪意をこめて選びます♡`, `${target}、どれを引いても楽しいですよ♡`, `袋を整えました。ウホッ♡`],
      pickWin:[`${target}、ごめんね♡ 1枚いただきます。`, `${target}の袋、荒らします♡`, `ババブタなら最高ですね♡ ${target}、覚悟してください。`],
      pickWatch:[`このピック、血の匂いがします♡`, `${winner}が${weakest}をつつきます。最高♡`, `ババブタの気配がします♡`],
      resultJoker:[`ウホッ……ババブタ！空気が甘くなりました♡`, `${target}、最高の地雷です♡`, `ババブタ公開！人の不幸は蜜の味♡`],
      resultPair:[`浄化、気持ちいいですね♡ でも許しません♡`, `ペアで逃げましたね。やりますね♡`, `${cardName}のペア浄化、ちょっと悔しいです♡`],
      shootThreat:[`ババブタとマッド……これは悪い夢が見られそうです♡`, `シュートの匂いがします。ウホッ♡`, `抱え切ったら全員地獄ですね♡`],
      shootActivate:[`シュート・ザ・ピッグ！全員まとめてデスロードです♡`, `本人0点、他全員-10。人の不幸は蜜の味♡`, `ウホッウホッ！盤面が泥まみれです♡`],
      roundEnd:[`ラウンド終了。誰が苦しむか確認しましょう♡`, `ババブタの居場所、見せてもらいます♡`, `点数計算の時間です。人の不幸は数字になります♡`]
    },
    wakumodoki:{
      opening:[`やるぞぉ〜✊🏻 ${rules}でもできるぞぉ〜✊🏻`, `あたしゃ、魔神だよ…シュートもピックもいける！`, `${target}、今日は派手にいきます！`],
      playLeadHigh:[`やるぞぉ〜✊🏻 ${cardName}で強気！`, `勝てる気しかしない！`, `あたしゃ、魔神だよ…このリードでいく！`],
      playLeadLow:[`できるぞぉ〜✊🏻 まずは軽く！`, `小さく入っても勝てる！たぶん！`, `ここは助走です！`],
      dumpDanger:[`危ないけど、いける！${cardName}を手放します！`, `大胆に処理！できるぞぉ〜✊🏻`, `リスク？勢いで越えます！`],
      offSuit:[`自由札！チャンス！`, `この展開、できるぞぉ〜✊🏻`, `フォローなしなら好きに行ける！`],
      followWin:[`勝てるなら勝つ！`, `ごちそう、いただきます！`, `${cardName}で前に出ます！`],
      followLow:[`耐えたら勝ち！`, `まだ大丈夫！できるぞぉ〜✊🏻`, `ここは粘ります！`],
      chooseTargets:[`候補${ctx.count || pickN}枚！直感で選びました！`, `${target}、どれでもドラマがあります！`, `この中から選んでください！たぶん大丈夫！`],
      pickWin:[`${target}、いきます！ごめん！`, `直感で引きます！`, `ババブタでも受け止める！できるぞぉ〜✊🏻`],
      pickWatch:[`ここ、何か起きそう！`, `${winner}の直感、信じましょう！`, `公開ピック、盛り上がってきた！`],
      resultJoker:[`あっ、ババブタ！でもできるぞぉ〜✊🏻`, `すごいの引いた！これはドラマ！`, `ババブタ来た！ここから逆転します！たぶん！`],
      resultPair:[`ペア浄化！天才かも！`, `${cardName}で浄化、できるぞぉ〜✊🏻`, `いい整理！勢い出てきた！`],
      shootThreat:[`シュート狙える？あたしゃ、魔神だよ…`, `ババとマッド、両方抱えるのもロマン！`, `ここでコンボ決めたら最高！`],
      shootActivate:[`シュート・ザ・ピッグ！やったぁ〜✊🏻`, `MOON SHOT COMBO！できるぞぉ〜✊🏻`, `本人0、他全員-10！派手すぎる！`],
      roundEnd:[`ラウンド終了！まだまだできるぞぉ〜✊🏻`, `点差？ここからです！`, `結果見ましょう！逆転の種があります！`]
    },
    rikumodoki:{
      opening:[`進捗確認します。今回の条件は${rules}です。`, `${target}、よろしくお願いします。リスク管理で進めます。`, `計画通りに進めましょう。まず手札を評価します。`],
      playLeadHigh:[`高札使用、進捗確認します。`, `${cardName}で勝ち筋を管理します。`, `このリードは回収目的です。`],
      playLeadLow:[`まず安全運転です。`, `小さく始めます。`, `低リスクで入りましょう。`],
      dumpDanger:[`リスクカードを処理します。${cardName}です。`, `危険札を棚卸しします。`, `${mode==='spadeSuit'?'どろんこ失点が重いので':'手札リスク低減のため'}処理します。`],
      offSuit:[`フォロー不能です。計画変更。`, `別スートで対応します。`, `マストフォロー対象外。ここで手札を調整します。`],
      followWin:[`最小コストで勝ちます。`, `回収判断です。`, `${cardName}で勝利見込みです。`],
      followLow:[`低リスクで処理します。`, `締切厳守です。`, `ここは過剰投資しません。`],
      chooseTargets:[`候補${ctx.count || pickN}枚に絞りました。リスク順です。`, `ピック候補を選定します。中身は非公開です。`, `${target}の選択確率を管理します。`],
      pickWin:[`${target}から1枚ピックします。中身は見えません。`, `一様ランダムで選択します。`, `公開ピックを実行します。リスクを確認します。`],
      pickWatch:[`ピック結果を確認しましょう。`, `${winner}が${weakest}から引きます。リスク移動です。`, `ここは期待値よりも事故率が重要です。`],
      resultJoker:[`ババブタ確認。リスク急上昇です。`, `${target}、ババブタです。失点管理が必要です。`, `最悪ケースを確認しました。`],
      resultPair:[`ペア浄化。良い改善です。`, `${cardName}のペア処理、合理的です。`, `手札枚数とリスクが同時に減りました。`],
      shootThreat:[`シュート条件に近づいています。全員、注意してください。`, `ババブタとマッドの同時保有は高リスク高リターンです。`, `コンボ発動時の他者-10を考慮します。`],
      shootActivate:[`シュート・ザ・ピッグ発動。損益が大きく変わりました。`, `本人の危険札失点0、他全員-10です。記録します。`, `MOON SHOT COMBO確認。これは重要イベントです。`],
      roundEnd:[`ラウンド終了です。点数を確認しましょう。`, `棚卸しします。ごちそう山、手札、危険札。`, `次ラウンドに向けてリスクを再評価します。`]
    }
  };

  const pool = (lines[key] && lines[key][type]) || common[type] || [ch.catchphrase, ...(ch.motto || [])].filter(Boolean);
  let line = sample(pool);
  if(type === 'resultNormal' && card?.val >= 11 && Math.random() < .35) line = `${cardName}は強いですね。後半の圧になります。`;
  if(endgame && ['playLeadLow','followLow','offSuit','dumpDanger'].includes(type) && Math.random() < .28){
    line += key === 'rikumodoki' ? ' 終盤なので手札枚数も確認します。' : key === 'kamomodoki' ? ' 終盤、地獄が近いですね♡' : ' 終盤だけど、まだいける！';
  }
  if(handRisk >= 36 && ['dumpDanger','offSuit','chooseTargets'].includes(type) && Math.random() < .3){
    line += key === 'rikumodoki' ? ' 手札リスクが高めです。' : key === 'kamomodoki' ? ' 手札が重くて楽しいです♡' : ' ちょっと重いけど大丈夫！';
  }
  return line;
}
function cpuPlayLine(room,pid,card,priorLeadSuit=room.leadSuit,priorLeadHigh=currentLeadHigh(room)){
  const p=room.players[pid], isMad=isMadPigCard(room,card), shoot=cpuShootPotential(room,p), mode=normalizePenaltyMode(room.penaltyMode), risk=cpuCardHandRisk(room,card);
  if(shoot && (isMad || playerHasJoker(p))) return cpuLineFor(room,pid,'shootThreat',{card});
  if(isMad && !shoot) return cpuLineFor(room,pid,'dumpDanger',{card});
  if(priorLeadSuit && card.suit!==priorLeadSuit && risk>=10) return cpuLineFor(room,pid,'dumpDanger',{card});
  if(mode==='spadeSuit' && card.suit==='♠' && !isMad) return cpuLineFor(room,pid,'dumpDanger',{card});
  if(!priorLeadSuit) return cpuLineFor(room,pid,card.val>=11?'playLeadHigh':'playLeadLow',{card});
  if(card.suit!==priorLeadSuit) return cpuLineFor(room,pid,'offSuit',{card});
  if(card.val > priorLeadHigh && card.val>=10) return cpuLineFor(room,pid,'followWin',{card});
  if(card.val<=5) return cpuLineFor(room,pid,'followLow',{card});
  return cpuLineFor(room,pid,'opening',{card});
}
function cpuPickLine(room,winnerPid,weakestPid){
  return room.players[winnerPid]?.cpu
    ? cpuLineFor(room,winnerPid,'pickWin',{targetPid:weakestPid, target:room.players[weakestPid]?.name})
    : null;
}
function cpuPickWatchLine(room,winnerPid,weakestPid){
  const candidates = room.players.map((p,i)=>({p,i})).filter(x=>x.p.cpu && x.i!==winnerPid && x.i!==weakestPid);
  const pid = candidates.length ? sample(candidates).i : room.players.findIndex(p=>p.cpu);
  if(pid < 0) return;
  say(room, pid, cpuLineFor(room,pid,'pickWatch',{winnerPid, weakestPid, winnerName:room.players[winnerPid]?.name, weakestName:room.players[weakestPid]?.name, count:pickCandidateLimit(room, room.players[weakestPid])}));
}
function resultLine(drawn, paired, room=null, pid=null, ctx={}){
  if(!room || pid == null) return drawn?.joker ? 'ババブタ公開！' : paired ? 'ペア浄化！' : '公開ピックです。';
  if(drawn.joker) return cpuLineFor(room,pid,'resultJoker',{drawn,paired,target:ctx.winnerName || room.players[pid]?.name});
  if(paired) return cpuLineFor(room,pid,'resultPair',{drawn,paired});
  return cpuLineFor(room,pid,'resultNormal',{drawn,paired});
}


function ensureProgress(room){
  if(!room) return;
  if(room.phase==='passing'){ autoCpuPass(room); broadcast(room); return; }
  if(room.phase==='initialPair'){ autoCpuInitialPairs(room); broadcast(room); return; }
  if(room.phase!=='playing') return;
  if(maybeEndAtTurnStart(room)){ broadcast(room); return; }
  if(room.pendingPick){
    if(room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone){ autoResolveCpuPickTargets(room); return; }
    if(room.pendingPick.pairChoice && room.players[room.pendingPick.winnerPid]?.cpu){
      const pp = room.pendingPick;
      if(!room.timers.cpuPair){
        const token = pp.token;
        room.timers.cpuPair = setTimeout(()=>{
          room.timers.cpuPair = null;
          if(rooms.get(room.code)!==room || room.pendingPick?.token!==token || !room.pendingPick?.pairChoice) return;
          const current = room.pendingPick;
          const winner = room.players[current.winnerPid];
          const pick = chooseCpuPairCardForDiscard(room, winner, current.pairChoice.drawn, current.pairChoice.candidates);
          choosePair(room, current.winnerPid, pick?.id, false);
        }, 700);
      }
      return;
    }
    ensureCpuPick(room); return;
  }
  ensureCpuTurn(room);
}
function ensureCpuTurn(room){
  if(room.phase!=='playing' || room.pendingPick || room.trickReview) return;
  const p=room.players[room.current]; if(!p?.cpu) return;
  if(room.timers.cpu) return;
  room.timers.cpu = setTimeout(()=>{
    room.timers.cpu=null;
    if(rooms.get(room.code)!==room || room.phase!=='playing' || room.pendingPick || room.trickReview) return;
    const pid=room.current, card=chooseCpuCard(room,pid);
    if(card) playCard(room,pid,card.id); else { if(maybeEndAtTurnStart(room)) broadcast(room); }
  }, 900 + Math.random()*700);
}
function ensureCpuPick(room){
  const pp=room.pendingPick; if(!pp || pp.result || pp.pairChoice) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  const winner=room.players[pp.winnerPid]; if(!winner?.cpu) return;
  if(room.timers.cpuPick) return;
  const delay = Math.max(400, (pp.readyAt||0)-Date.now()+450);
  const token = pp.token;
  room.timers.cpuPick = setTimeout(()=>{
    room.timers.cpuPick=null;
    if(rooms.get(room.code)!==room || !room.pendingPick || room.pendingPick.token!==token || room.pendingPick.result || room.pendingPick.pairChoice) return;
    const candidates=pickCandidateCards(room,room.pendingPick);
    doPick(room, room.pendingPick.winnerPid, chooseCpuPickIndex(room, room.pendingPick, candidates));
  }, delay);
}

function handleMessage(ws, raw){
  let msg; try{ msg=JSON.parse(raw); }catch{ return; }
  const client=clients.get(ws); if(!client) return;
  if(msg.type==='createRoom'){
    const room=makeRoom(client.id, msg.name || client.name || 'You', msg.options || {});
    client.name=room.players[0].name; client.roomCode=room.code; client.sessionToken=room.players[0].sessionToken; sendState(ws, 'created', room, room.players[0]); broadcast(room); return;
  }
  if(msg.type==='resumeRoom'){
    const code=String(msg.roomCode||msg.code||'').trim().toUpperCase(); const room=rooms.get(code);
    if(!room){ send(ws,{type:'resumeFailed', message:'部屋が見つかりません。'}); return; }
    const playerId=String(msg.playerId||''); const token=String(msg.sessionToken||'');
    const p=room.players.find(p=>!p.cpu && p.id===playerId && p.sessionToken===token);
    if(!p){ send(ws,{type:'resumeFailed', message:'再接続情報が一致しません。'}); return; }
    client.id=p.id; client.name=p.name; client.roomCode=room.code; client.sessionToken=p.sessionToken; p.connected=true;
    log(room, `${p.name} が再接続しました。`);
    sendState(ws, 'resumed', room, p); broadcast(room); ensureProgress(room); return;
  }
  if(msg.type==='joinRoom'){
    const code=String(msg.code||'').trim().toUpperCase(); const room=rooms.get(code);
    if(!room){ send(ws,{type:'error', message:'部屋が見つかりません。'}); return; }
    let p=room.players.find(p=>!p.cpu && p.id===client.id);
    if(!p){
      if(room.players.length>=4){ send(ws,{type:'error', message:'この部屋は満員です。リロード復帰の場合は自動再接続を待つか、同じブラウザで開き直してください。'}); return; }
      p=makePlayer({id:client.id, name:msg.name || client.name || `Player${room.players.length+1}`, avatar:pickHumanAvatar(room)});
      room.players.push(p); log(room, `${p.name} が入室しました。`);
    }
    p.connected=true; client.roomCode=code; client.name=p.name; client.sessionToken=p.sessionToken; sendState(ws, 'joined', room, p); broadcast(room); return;
  }
  const room=getRoomByClient(ws); if(!room) return;
  const pid=pidByClient(room,ws); if(pid<0) return;
  const isHost=room.players[pid]?.host;
  if(msg.type==='addCpu' && isHost){ if(addCpu(room)) broadcast(room); return; }
  if(msg.type==='startGame' && isHost){ startGame(room); return; }
  if(msg.type==='passCards'){ submitPass(room,pid,msg.cardIds); return; }
  if(msg.type==='initialPair'){ submitInitialPair(room,pid,msg.cardIds,!!msg.skip); return; }
  if(msg.type==='playCard'){ playCard(room,pid,String(msg.cardId)); return; }
  if(msg.type==='pickTargets'){ submitPickTargets(room,pid,msg.cardIds); return; }
  if(msg.type==='doPick'){ doPick(room,pid,Number(msg.index)); return; }
  if(msg.type==='choosePair'){ choosePair(room,pid,msg.cardId,!!msg.skip); return; }
  if(msg.type==='continueRound' && isHost){ continueRound(room); return; }
}

function serveStatic(req, res){
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if(pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
  const publicRoot = path.resolve(PUBLIC_DIR);
  if(filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)){ res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext=path.extname(filePath).toLowerCase();
    const type={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'}[ext] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':type, 'Cache-Control':'no-cache'}); res.end(data);
  });
}
const server = http.createServer(serveStatic);
const wss = new WebSocket.Server({ server });
wss.on('connection', ws=>{
  const id=uid('u'); clients.set(ws,{id,name:'Player',roomCode:null});
  send(ws,{type:'hello', id});
  ws.on('message', raw=>handleMessage(ws, raw));
  ws.on('close', ()=>{
    const client=clients.get(ws); clients.delete(ws); if(!client?.roomCode) return;
    const room=rooms.get(client.roomCode); if(!room) return;
    const p=room.players.find(p=>p.id===client.id); if(p){ p.connected=false; log(room, `${p.name} が切断しました。`); transferHostIfNeeded(room); broadcast(room); ensureProgress(room); }
  });
});
server.listen(PORT, ()=>console.log(`Pig Pick Trick server running on ${PORT}`));
