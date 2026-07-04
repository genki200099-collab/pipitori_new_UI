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
  { key:'kamomodoki', name:'かももどき', avatar:'🦆', imagePath:'/cpu_characters/kamomodoki.jpg', style:'attack', catchphrase:'マストフォローは祝福です♡', motto:['人の不幸は蜜の味','下家のデスロード','ウホッウホッ','そこが地獄の入り口です♡'] },
  { key:'wakumodoki', name:'ワクもどき', avatar:'✊🏻', imagePath:'/cpu_characters/wakumodoki.jpg', style:'bold', catchphrase:'やるぞぉ〜✊🏻', motto:['できるぞぉ〜✊🏻','あたしゃ、魔神だよ…','いける気しかしない！','大胆に行きます！'] },
  { key:'rikumodoki', name:'リクもどき', avatar:'📋', imagePath:'/cpu_characters/rikumodoki.png', style:'steady', catchphrase:'進捗確認します。', motto:['締切厳守です','計画通りに進めましょう','リスクを洗い出します','想定外です、落ち着きましょう'] },
];

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
function suitOrder(s){ return {'♥':0,'♠':1,'♣':2,'♦':3}[s] ?? 99; }
function sortHand(hand){
  hand.sort((a,b)=>{
    if(a.joker && b.joker) return 0;
    if(a.joker) return 1;
    if(b.joker) return -1;
    return suitOrder(a.suit)-suitOrder(b.suit) || a.val-b.val;
  });
}
function cardText(c){
  if(!c) return '';
  if(c.joker) return '🐷ババブタ';
  const m = SUIT_META[c.suit] || {emoji:c.suit, name:c.suit};
  return `${m.emoji}${c.rank}${isMadPigCard({madPigEnabled:true}, c) ? ' / マッド・ピッグ' : ''}`;
}
function publicCard(c){
  if(!c) return null;
  if(c.joker) return { id:c.id, joker:true, label:'ババブタ', name:'ババブタ', emoji:'🐷', color:'#7b4cf6' };
  const m = SUIT_META[c.suit];
  return { id:c.id, joker:false, suit:c.suit, suitKey:m.key, suitName:m.name, emoji:m.emoji, color:m.color, rank:c.rank, val:c.val, mad:c.suit==='♠' && c.rank==='11', label:`${m.name}${c.rank}` };
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

function makePlayer({id, name, cpu=false, host=false, cpuCharacter=null, sessionToken=null}){
  return { id, name: (name || 'Player').slice(0,20), cpu, host, sessionToken: cpu ? null : (sessionToken || uid('sess')), cpuCharacter, hand:[], scorePile:[], pairs:[], connected:!cpu, speech:null, final:null, passSelection:null, initialPairDone:false, jokerPenaltyBank:0, shootPigPenaltyBank:0, shootPigActivatedRounds:[] };
}
function makeRoom(hostId, hostName, options){
  const code = roomCode();
  const opts = defaultOptions(options);
  const room = {
    code, phase:'lobby', round:1, totalRounds:opts.totalRounds, ...opts,
    players:[makePlayer({id:hostId, name:hostName || 'You', host:true})],
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
    players: room.players.map((p,i)=>({ pid:i, id:p.id, name:p.name, cpu:p.cpu, host:p.host, connected:p.cpu || p.connected, imagePath:p.cpuCharacter?.imagePath || '', avatar:p.cpuCharacter?.avatar || (p.cpu ? '🐷':'🙂'), characterKey:p.cpuCharacter?.key || '', handCount:p.hand.length, pileCount:p.scorePile.length, pairCount:Math.floor(p.pairs.length/2), hasSpeech:!!(p.speech && p.speech.expiresAt>now), speech:p.speech && p.speech.expiresAt>now ? p.speech.text : '', final:p.final || null })),
    hand: pid>=0 ? room.players[pid].hand.map(publicCard) : [],
    playableIds: playable,
    trick: room.trick.map(x=>({ pid:x.pid, order:x.order, card:publicCard(x.card) })),
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
function pairOptionsFor(player){
  const byRank = new Map();
  for(const c of player.hand){ if(c.joker) continue; if(!byRank.has(c.rank)) byRank.set(c.rank, []); byRank.get(c.rank).push(c); }
  const pairs=[];
  for(const [rank, cards] of byRank.entries()) if(cards.length>=2) pairs.push({ rank, cards:cards.map(publicCard) });
  pairs.sort((a,b)=>Number(a.rank)-Number(b.rank));
  return pairs;
}
function sanitizeInitialPair(room, pid){
  if(room.phase !== 'initialPair' || pid < 0) return null;
  const p = room.players[pid];
  return { required: !p.cpu && !p.initialPairDone, done:!!p.initialPairDone, options: pairOptionsFor(p) };
}
function sanitizePendingPick(room, pid){
  const pp = room.pendingPick;
  if(!pp) return null;
  const winner = room.players[pp.winnerPid];
  const weakest = room.players[pp.weakestPid];
  const base = { winnerPid:pp.winnerPid, weakestPid:pp.weakestPid, winnerName:winner?.name || '', weakestName:weakest?.name || '', readyAt:pp.readyAt || 0 };
  if(pp.result){
    return { ...base, mode:'result', result:{...pp.result, drawn:publicCard(pp.result.drawn), pairCard:publicCard(pp.result.pairCard)} };
  }
  if(pp.pairChoice && pid === pp.winnerPid){
    return { ...base, mode:'pairChoice', drawn:publicCard(pp.pairChoice.drawn), pairOptions:pp.pairChoice.candidates.map(publicCard) };
  }
  if(pp.pairChoice){
    return { ...base, mode:'watchPairChoice', drawn:publicCard(pp.pairChoice.drawn) };
  }
  if(pp.targetSelectionRequired && !pp.targetSelectionDone){
    if(pid === pp.weakestPid){
      const sorted = weakest.hand.slice(); sortHand(sorted);
      return { ...base, mode:'chooseTargets', targetCount:pp.targetCount, hand:sorted.map(publicCard) };
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
  room.round = 1; room.trickNo = 1; room.lead = Math.floor(Math.random()*4); room.current = room.lead; room.leadSuit = null; room.trick=[]; room.pendingPick=null; room.trickReview=null; room.roundSnapshot=null; room.finalScores=null; room.shootPigRoundResults={};
  log(room, `通常カードから1枚を抜き、13枚ずつ配りました。抜いたカードは秘密です。`);
  log(room, `最初のリードは ${room.players[room.lead].name} です。`);
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
    say(room, i, sample(['3枚、選別しました。','この3枚を流します。','次の方へお渡しします。']));
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
      const pairs = pairOptionsFor(p);
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
    if(did) say(room,pid,`開始前に${did}ペア浄化しました。`);
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
  const card = p.hand.splice(idx,1)[0]; sortHand(p.hand);
  if(!room.leadSuit) room.leadSuit = card.suit;
  room.trick.push({ pid, card, order:room.trick.length });
  log(room, `${p.name} が ${cardText(card)} を出しました。`);
  const line = p.cpu ? cpuPlayLine(room,pid,card) : null; if(line) say(room,pid,line);
  if(isEmptyHand(p)) room.endAfterTrickPid = pid;
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
  clearTimeout(room.timers.review);
  const reviewId = room.trickReview.id;
  room.timers.review = setTimeout(()=>{ if(rooms.get(room.code)===room) advanceReviewToPick(room, reviewId); }, 5000);
}
function advanceReviewToPick(room, reviewId){
  if(room.phase !== 'playing' || !room.trickReview || room.trickReview.id !== reviewId) return;
  const { winnerPid, weakestPid } = room.trickReview;
  room.trickReview = null;
  const emptyPid = room.players.findIndex(isEmptyHand);
  if(emptyPid >= 0){ endRound(room, emptyPid, `${room.players[emptyPid].name} の手札が0枚になりました。`); broadcast(room); return; }
  const wp = room.players[winnerPid], lp = room.players[weakestPid];
  if(lp.hand.length > 0){
    const targetCount = pickCandidateLimit(room, lp);
    const required = normalizePickTargetCount(room.pickTargetCount)>0 && targetCount < lp.hand.length;
    room.pendingPick = { winnerPid, weakestPid, readyAt:Date.now()+(required?999999999:900), result:null, token:uid('pick'), targetCount, targetSelectionRequired:required, targetSelectionDone:!required, targetCandidateIds: required?[]:null, pickOrderIds: required?[]:shuffleIds(lp.hand.map(c=>c.id)) };
    if(required){
      room.message = `🐽 ${lp.name} がピック候補を${targetCount}枚に絞ります。`;
      log(room, `🎯 ${lp.name} がピック候補を${targetCount}枚に絞ります。`);
      autoResolveCpuPickTargets(room);
    } else {
      room.message = `🐽 公開ピック！ ${wp.name} が ${lp.name} の袋から1枚選びます。`;
      const line = cpuPickLine(room,winnerPid,weakestPid); if(line) say(room,winnerPid,line);
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
  const handIds = new Set(lp.hand.map(c=>c.id));
  if(unique.length !== needed || !unique.every(id=>handIds.has(id))){ room.message=`ピック候補を${needed}枚選んでください。`; broadcast(room); return; }
  pp.targetCandidateIds = shuffleIds(unique); pp.pickOrderIds = pp.targetCandidateIds.slice(); pp.targetSelectionDone = true; pp.readyAt = Date.now()+900;
  room.message = `${lp.name} が候補を${needed}枚に絞りました。${wp.name} が選びます。`;
  log(room, `🎯 ${lp.name} がピック候補を${needed}枚に絞りました。`);
  const line = cpuPickLine(room,pp.winnerPid,pp.weakestPid); if(line) say(room,pp.winnerPid,line);
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
  const card = candidates[clamp(index,0,candidates.length-1)]; if(!card) return;
  const idx = lp.hand.findIndex(c=>c.id===card.id); if(idx<0) return;
  const drawn = lp.hand.splice(idx,1)[0]; wp.hand.push(drawn); sortHand(wp.hand); sortHand(lp.hand);
  const text = drawn.joker ? `${wp.name} はババブタを引いた！` : `${wp.name} は ${cardText(drawn)} を公開ピックした。`;
  log(room, `🐽 ${text}`);
  room.lastPickReveal = { id:uid('reveal'), drawn:publicCard(drawn), winnerName:wp.name, weakestName:lp.name, jokerPenalty:room.jokerPenalty, expiresAt:Date.now()+(drawn.joker?5200:2800) };
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
  const text = drawn.joker ? `${wp.name} はババブタを引いた！` : `${wp.name} は ${cardText(drawn)} を手札に加えた。`;
  pp.result = { drawn, paired:false, skipped:true, text }; pp.resultAt=Date.now(); pp.pairChoice=null;
  if(wp.cpu) say(room, pp.winnerPid, resultLine(drawn,false,room,pp.winnerPid));
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
  log(room, `🐽 ${text}`); if(wp.cpu) say(room,pp.winnerPid,resultLine(drawn,true,room,pp.winnerPid));
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
  const emptyPid = room.players.findIndex(isEmptyHand);
  if(emptyPid >= 0){ endRound(room, emptyPid, `${room.players[emptyPid].name} の手札が0枚になりました。`); broadcast(room); return; }
  if(maybeEndAtTurnStart(room)){ broadcast(room); return; }
  room.message = `次のリード：${room.players[winnerPid].name}`;
  broadcast(room); ensureProgress(room);
}
function maybeEndAtTurnStart(room){
  if(room.phase !== 'playing' || room.pendingPick || room.trickReview) return false;
  const emptyPid = room.players.findIndex(isEmptyHand);
  if(emptyPid >= 0){ endRound(room, emptyPid, `${room.players[emptyPid].name} の手札が0枚です。`); return true; }
  if(Number.isInteger(room.current) && isJokerOnlyHand(room.players[room.current])){
    endRound(room, room.current, `${room.players[room.current].name} が手番開始時にババブタ1枚だけです。`); return true;
  }
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
  room.pendingPick=null; room.trickReview=null; room.roundSnapshot = makeRoundSnapshot(room, reasonPid, reasonText);
  log(room, `🏁 ラウンド${room.round}終了：${reasonText}`);
  if(room.round >= room.totalRounds){ room.phase='finished'; room.finalScores = score(room); room.message = `ゲーム終了！ 勝者：${room.finalScores.winners.join('、')}`; }
  else { room.phase='roundEnd'; room.message = `ラウンド${room.round}終了。結果を確認して次へ進んでください。`; room.nextLead = reasonPid; }
}
function continueRound(room){
  if(room.phase !== 'roundEnd') return;
  clearGameplayTimers(room);
  room.round++; room.trickNo = 1; room.roundSnapshot = null; room.trick=[]; room.leadSuit=null; room.pendingPick=null; room.trickReview=null;
  refillHands(room);
  room.lead = Number.isInteger(room.nextLead) ? room.nextLead : 0; room.current = room.lead; room.phase='playing'; room.message = `ラウンド${room.round}開始。${room.players[room.current].name} のリードです。`;
  log(room, `ラウンド${room.round}開始。残り手札を持ち越し、通常カードで13枚まで補充しました。`);
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
function cpuLineFor(room, pid, type, ctx={}){
  const ch=cpuCharacter(room.players[pid]);
  const lines={
    kamomodoki:{ playLeadHigh:['高札で踏みます♡','人の不幸は蜜の味。','下家のデスロード、開通♡'], playLeadLow:['小さく見せておきます♡','まだ牙は隠します。'], dumpDanger:['その危険札、置いていきます♡','ウホッ、厄介払いです。'], offSuit:['フォローなし。自由って最高♡','そのスート、持ってませーん♡'], followWin:['勝ちに行きます♡','ごちそう回収します。'], followLow:['低めでかわします。','ここはしゃがみます♡'], pickWin:[`袋の中、荒らします♡`], pickWatch:['ババブタの匂いがします♡'], resultJoker:['ウホッ……これは事故です。','ババブタ！空気が甘くなりました♡'], resultPair:['浄化、気持ちいいですね♡'] },
    wakumodoki:{ playLeadHigh:['やるぞぉ〜✊🏻','強気でいける！','あたしゃ、魔神だよ…'], playLeadLow:['できるぞぉ〜✊🏻','まずは軽くいきます！'], dumpDanger:['危ないけど、いける！','大胆に手放します！'], offSuit:['自由札！チャンス！','この展開、できるぞぉ〜✊🏻'], followWin:['勝てるなら勝つ！','ごちそう、いただきます！'], followLow:['耐えたら勝ち！','まだ大丈夫！'], pickWin:['直感で引きます！'], pickWatch:['ここ、何か起きそう！'], resultJoker:['あっ、ババブタ！でもできるぞぉ〜✊🏻'], resultPair:['ペア浄化！天才かも！'] },
    rikumodoki:{ playLeadHigh:['高札使用、進捗確認します。','勝ち筋を管理します。'], playLeadLow:['まず安全運転です。','小さく始めます。'], dumpDanger:['リスクカードを処理します。','危険札を棚卸しします。'], offSuit:['フォロー不能です。計画変更。','別スートで対応します。'], followWin:['最小コストで勝ちます。','回収判断です。'], followLow:['低リスクで処理します。','締切厳守です。'], pickWin:['中身は見えません。一様ランダムです。'], pickWatch:['ピック結果を確認しましょう。'], resultJoker:['ババブタ確認。リスク急上昇です。'], resultPair:['ペア浄化。良い改善です。'] }
  };
  return sample(lines[ch?.key]?.[type] || [ch?.catchphrase, ...(ch?.motto || [])].filter(Boolean));
}
function cpuPlayLine(room,pid,card){
  const p=room.players[pid], isMad=isMadPigCard(room,card), shoot=cpuShootPotential(room,p), mode=normalizePenaltyMode(room.penaltyMode), risk=cpuCardHandRisk(room,card);
  if(shoot && (isMad || playerHasJoker(p))) return cpuLineFor(room,pid,'playLeadHigh',{card});
  if(isMad && !shoot) return cpuLineFor(room,pid,'dumpDanger',{card});
  if(room.leadSuit && card.suit!==room.leadSuit && risk>=10) return cpuLineFor(room,pid,'dumpDanger',{card});
  if(mode==='spadeSuit' && card.suit==='♠' && !isMad) return cpuLineFor(room,pid,'dumpDanger',{card});
  if(!room.leadSuit) return cpuLineFor(room,pid,card.val>=11?'playLeadHigh':'playLeadLow',{card});
  if(card.suit!==room.leadSuit) return cpuLineFor(room,pid,'offSuit',{card});
  if(card.val > currentLeadHigh(room) && card.val>=10) return cpuLineFor(room,pid,'followWin',{card});
  if(card.val<=5) return cpuLineFor(room,pid,'followLow',{card});
  return sample([cpuCharacter(p)?.catchphrase || '進めます。','マストフォロー、了解。']);
}
function cpuPickLine(room,winnerPid,weakestPid){ return room.players[winnerPid]?.cpu ? cpuLineFor(room,winnerPid,'pickWin',{target:room.players[weakestPid]?.name}) : null; }
function resultLine(drawn, paired, room=null, pid=null){
  if(drawn.joker) return cpuLineFor(room,pid,'resultJoker',{drawn,paired});
  if(paired) return cpuLineFor(room,pid,'resultPair',{drawn,paired});
  if(drawn.val>=11) return sample(['強いカードを拾いました。','後半で効きそうです。']);
  return sample(['まずまずの1枚です。','危険札ではないだけ助かりました。']);
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
      p=makePlayer({id:client.id, name:msg.name || client.name || `Player${room.players.length+1}`});
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
  const filePath = path.join(PUBLIC_DIR, pathname);
  if(!filePath.startsWith(PUBLIC_DIR)){ res.writeHead(403); res.end('Forbidden'); return; }
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
    const p=room.players.find(p=>p.id===client.id); if(p){ p.connected=false; log(room, `${p.name} が切断しました。`); transferHostIfNeeded(room); broadcast(room); }
  });
});
server.listen(PORT, ()=>console.log(`Pig Pick Trick server running on ${PORT}`));
