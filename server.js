// server.js
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, "users.json");
const GIVE_FILE = path.join(DATA_DIR, "giveaways.json");

function loadJSON(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file)); } catch(e){ return def; }
}
function saveJSON(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

let users = loadJSON(USERS_FILE, {}); // username -> { username, passwordHash, balance }
let giveaways = loadJSON(GIVE_FILE, []); // array of giveaways

// ensure initial test user for convenience
if (!users["alice"]) {
  const hash = bcrypt.hashSync("password", 8);
  users["alice"] = { username: "alice", passwordHash: hash, balance: 100 };
  users["bob"] = { username: "bob", passwordHash: bcrypt.hashSync("password",8), balance: 100 };
  saveJSON(USERS_FILE, users);
}

app.use(express.json());
app.get("/", (req,res)=> res.send({ ok:true }));

/* ---------- AUTH ENDPOINTS ---------- */
app.post("/signup", async (req,res)=>{
  const { username, password } = req.body;
  if(!username||!password) return res.json({ ok:false, error:"missing fields" });
  if (users[username]) return res.json({ ok:false, error:"username taken" });
  const hash = await bcrypt.hash(password, 8);
  users[username] = { username, passwordHash: hash, balance: 100 };
  saveJSON(USERS_FILE, users);
  // return a simplistic token (not JWT) — in prod use JWT
  const token = Buffer.from(username + ":" + Date.now()).toString("base64");
  const user = { username, balance: users[username].balance, token };
  res.json({ ok:true, user });
});

app.post("/signin", async (req,res)=>{
  const { username, password } = req.body;
  const u = users[username];
  if(!u) return res.json({ ok:false, error:"no user" });
  const ok = await bcrypt.compare(password, u.passwordHash);
  if(!ok) return res.json({ ok:false, error:"bad credentials" });
  const token = Buffer.from(username + ":" + Date.now()).toString("base64");
  const user = { username, balance: u.balance, token };
  return res.json({ ok:true, user });
});

/* ---------- SOCKETS ---------- */
let sockets = {}; // socket.id -> username
let online = {}; // username -> { id, username }

function broadcastState() {
  io.emit("state", { players: Object.values(online).map(u => ({ username: u.username, balance: users[u.username].balance })), giveaways });
}

io.on("connection", (socket)=>{
  console.log("connect", socket.id);

  socket.on("auth", ({ token }) => {
    // token format was simple base64(username:ts)
    try {
      const decoded = Buffer.from(token, "base64").toString();
      const username = decoded.split(":")[0];
      if (users[username]) {
        sockets[socket.id] = username;
        online[username] = { id: socket.id, username };
        socket.emit("auth_ok", { username, balance: users[username].balance, token });
        socket.emit("system", "Welcome back, " + username);
        broadcastState();
      }
    } catch(e){}
  });

  socket.on("chat", ({ text })=>{
    const from = sockets[socket.id] || "guest";
    const ts = Date.now();
    // handle commands locally
    if (text.startsWith("/giveaway ")) {
      const parts = text.split(" ");
      const amt = Number(parts[1]);
      if (!amt || amt <= 0) { socket.emit("system", "Invalid giveaway amount"); return; }
      if (!users[from] || users[from].balance < amt) { socket.emit("system", "Not enough balance"); return; }
      // subtract immediately, host pays cost
      users[from].balance -= amt; saveJSON(USERS_FILE, users);
      const gid = (giveaways.length?giveaways[giveaways.length-1].id+1:1);
      const g = { id: gid, host: from, amount: amt, entrants: [], createdAt: Date.now() };
      giveaways.push(g); saveJSON(GIVE_FILE, giveaways);
      io.emit("chat_message", { from: "system", text: `${from} started a giveaway for $${amt}! Type /enter to join.`, ts });
      broadcastState();
      return;
    }
    if (text.trim() === "/enter") {
      const g = giveaways[giveaways.length-1];
      if (!g) { socket.emit("system","No active giveaway to enter"); return; }
      if (g.entrants.includes(from)) { socket.emit("system","You already entered"); return; }
      g.entrants.push(from); saveJSON(GIVE_FILE, giveaways);
      io.emit("chat_message", { from: "system", text: `${from} entered giveaway #${g.id} (${g.entrants.length} entrants)` , ts });
      return;
    }

    // normal chat broadcast
    io.emit("chat_message", { from, text, ts });
  });

  socket.on("send_coins", ({ to, amount })=>{
    const from = sockets[socket.id];
    if (!from) { socket.emit("system","Login required"); return; }
    const amt = Number(amount);
    if (!amt || amt<=0) { socket.emit("system","Invalid amount"); return; }
    if (!users[to]) { socket.emit("system","Recipient not found"); return; }
    if (users[from].balance < amt) { socket.emit("system","Not enough funds"); return; }
    users[from].balance -= amt;
    users[to].balance = (users[to].balance||0) + amt;
    saveJSON(USERS_FILE, users);
    io.to(socket.id).emit("system", `Sent $${amt} to ${to}`);
    if (online[to]) io.to(online[to].id).emit("system", `You received $${amt} from ${from}`);
    broadcastState();
  });

  /* Trades (simplified): trade request create -> receiver accept -> swap no items: just demonstrate flow */
  let tradeCounter = 1;
  let trades = {}; // id -> { id, from, to, status }
  socket.on("trade_start", ({ to })=>{
    const from = sockets[socket.id];
    if(!from) return socket.emit("system","login required");
    if(!users[to]) return socket.emit("system","user not found");
    const id = tradeCounter++;
    trades[id] = { id, from, to, status: "pending" };
    if (online[to]) io.to(online[to].id).emit("trade_request", { from, id });
    socket.emit("system","Trade request sent");
  });
  socket.on("trade_accept", ({ id })=>{
    const t = trades[id];
    if(!t) return;
    if(t.status !== "pending") return;
    t.status = "accepted";
    // For demo: swap a small sample: transfer $1 from both to each other (no change) — show acceptance
    io.emit("system", `${t.to} accepted trade with ${t.from}! (Demo trade)`);
  });
  socket.on("trade_decline", ({ id })=>{
    const t = trades[id];
    if(!t) return;
    t.status = "declined";
    io.emit("system", `${t.to} declined trade with ${t.from}`);
  });

  /* BLACKJACK (very simplified single-hand) */
  const deck = () => {
    const suits = ['♠','♥','♦','♣'];
    const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const d=[];
    suits.forEach(s=>ranks.forEach(r=>d.push({r,s})));
    for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
    return d;
  };
  function valueHand(h){
    let sum=0, aces=0;
    h.forEach(c=>{
      if(c.r==='A') { aces++; sum+=11; }
      else if(['K','Q','J'].includes(c.r)) sum+=10;
      else sum+=Number(c.r);
    });
    while(sum>21 && aces>0){ sum-=10; aces--; }
    return sum;
  }
  const bjStates = {}; // username -> { deck, player, dealer, bet, done }

  socket.on("bj_start", ({ bet })=>{
    const user = sockets[socket.id];
    if(!user) return socket.emit("system","login required");
    if(!users[user] || users[user].balance < bet) return socket.emit("system","not enough funds");
    users[user].balance -= bet; saveJSON(USERS_FILE, users);
    const d = deck();
    bjStates[user] = { deck:d, player:[d.pop(), d.pop()], dealer:[d.pop(), d.pop()], bet, done:false, socketid: socket.id };
    io.to(socket.id).emit("bj_update", `Your hand: ${renderHand(bjStates[user].player)} (${valueHand(bjStates[user].player)})\nDealer shows: ${card2str(bjStates[user].dealer[0])}`);
    broadcastState();
  });

  socket.on("bj_action", ({ action })=>{
    const user = sockets[socket.id];
    if(!user) return;
    const s = bjStates[user];
    if(!s) return;
    if(action === "hit"){
      s.player.push(s.deck.pop());
      const v = valueHand(s.player);
      if(v>21){
        s.done=true;
        io.to(socket.id).emit("bj_update", `BUST! Your hand: ${renderHand(s.player)} (${v}). You lose $${s.bet}.`);
      } else {
        io.to(socket.id).emit("bj_update", `Your hand: ${renderHand(s.player)} (${v}).`);
      }
    } else if (action==="stand"){
      // reveal dealer
      while(valueHand(s.dealer) < 17) s.dealer.push(s.deck.pop());
      const pv = valueHand(s.player), dv = valueHand(s.dealer);
      let result = "";
      if (pv>21) result = `Bust — you lose $${s.bet}.`;
      else if (dv>21 || pv>dv) { result = `You win! +$${s.bet*2}`; users[user].balance += s.bet*2; }
      else if (pv === dv) { result = `Push. $${s.bet} returned.`; users[user].balance += s.bet; }
      else result = `Dealer wins — you lose $${s.bet}.`;
      saveJSON(USERS_FILE, users);
      io.to(socket.id).emit("bj_update", `Dealer: ${renderHand(s.dealer)} (${dv})\n${result}`);
      delete bjStates[user];
      broadcastState();
    }
  });

  /* POKER (5-card compare) */
  socket.on("poker_start", ({ bet })=>{
    const user = sockets[socket.id];
    if(!user) return socket.emit("system","login required");
    if(!users[user] || users[user].balance < bet) return socket.emit("system","not enough funds");
    // collect participants: all online players who can join automatically (for demo)
    const participants = Object.keys(online).filter(u => users[u].balance >= bet);
    if (participants.length === 0) return socket.emit("system","no players with enough funds.");
    // deduct bet from each participant
    participants.forEach(u => users[u].balance -= bet);
    saveJSON(USERS_FILE, users);
    const d = deck();
    const results = [];
    participants.forEach(u=>{
      const hand = [d.pop(),d.pop(),d.pop(),d.pop(),d.pop()];
      results.push({ user: u, hand, rank: rankHand(hand) });
    });
    // determine winner (highest rank comparator)
    results.sort((a,b)=> compareRank(b.rank, a.rank));
    const winner = results[0].user;
    users[winner].balance += bet * participants.length;
    saveJSON(USERS_FILE, users);
    const summary = results.map(r => `${r.user}: ${handToStr(r.hand)} (${r.rank.name})`).join("\n");
    io.emit("poker_result", `Poker results (bet $${bet}):\n${summary}\nWinner: ${winner} (+$${bet*participants.length})`);
    broadcastState();
  });

  /* Periodically pick giveaway winners (naive) -- for demo, pick last giveaway after 60 seconds */
  socket.on("disconnect", ()=>{
    const username = sockets[socket.id];
    if(username) delete online[username];
    delete sockets[socket.id];
    broadcastState();
  });
});

/* Pickup giveaways: simple interval to close oldest giveaways after 45s */
setInterval(()=>{
  if (giveaways.length === 0) return;
  const g = giveaways[0];
  if (!g) return;
  // if created > 45s ago or entrants >= 5 choose winner
  if (Date.now() - g.createdAt > 45000 || g.entrants.length >= 5) {
    if (g.entrants.length === 0) {
      // refund host
      users[g.host].balance = (users[g.host].balance||0) + g.amount;
    } else {
      const w = g.entrants[Math.floor(Math.random()*g.entrants.length)];
      users[w].balance = (users[w].balance||0) + g.amount;
    }
    giveaways.shift();
    saveJSON(GIVE_FILE, giveaways);
    saveJSON(USERS_FILE, users);
    io.emit("system", `Giveaway #${g.id} closed. Check balances.`);
    // broadcast updated state
    io.emit("state", { players: Object.values(online).map(u => ({ username: u.username, balance: users[u.username].balance })), giveaways });
  }
}, 5000);

/* ---------- HELPERS: card render & poker ranking ---------- */
function card2str(c){ return `${c.r}${c.s}`; }
function renderHand(h){ return h.map(card2str).join(" "); }
function handToStr(h){ return h.map(card2str).join(" "); }

/* Poker ranking */
function rankHand(hand){
  // convert to ranks and suits
  const counts = {}, suits = {};
  const order = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
  const vals = hand.map(c=>order[c.r]).sort((a,b)=>b-a);
  hand.forEach(c=>{ counts[c.r] = (counts[c.r]||0)+1; suits[c.s] = (suits[c.s]||0)+1; });
  const isFlush = Object.keys(suits).length === 1;
  const isStraight = vals[0]-vals[4] === 4 && new Set(vals).size===5;
  // check counts
  const freq = Object.values(counts).sort((a,b)=>b-a);
  let name = "High Card", score = [0].concat(vals);
  if(isStraight && isFlush){ name = "Straight Flush"; score = [9, vals[0]]; }
  else if(freq[0]===4){ name = "Four of a Kind"; score = [8, getKeyByValue(counts,4)]; }
  else if(freq[0]===3 && freq[1]===2){ name = "Full House"; score = [7, getKeyByValue(counts,3)]; }
  else if(isFlush){ name = "Flush"; score = [6].concat(vals); }
  else if(isStraight){ name = "Straight"; score = [5, vals[0]]; }
  else if(freq[0]===3){ name = "Three of a Kind"; score = [4, getKeyByValue(counts,3)]; }
  else if(freq[0]===2 && freq[1]===2){ name = "Two Pair"; score = [3].concat(pairValues(counts)); }
  else if(freq[0]===2){ name = "One Pair"; score = [2, getKeyByValue(counts,2)]; }
  else { name = "High Card"; score = [1].concat(vals); }
  return { name, score, vals };
}
function getKeyByValue(obj, val){
  for (let k in obj) if (obj[k]===val) return k;
  return null;
}
function pairValues(counts){
  const pairs = [];
  for(const k in counts) if(counts[k]===2) pairs.push(k);
  // convert face to numeric weight order (A high)
  const map = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
  pairs.sort((a,b)=>map[b]-map[a]);
  return pairs;
}
function compareRank(a,b){
  // compare score arrays lexicographically
  for(let i=0;i<Math.max(a.score.length,b.score.length);i++){
    const ai = a.score[i]||0, bi = b.score[i]||0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

/* Start server */
server.listen(PORT, ()=> console.log("Server running on port", PORT));
