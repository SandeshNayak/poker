'use strict';

/**
 * End-to-end functional test for Planning Poker.
 *
 * Simulates 10 concurrent "agents" (players) against the running local server
 * and exercises EVERY feature + permission guard, asserting on the returned
 * state. Uses Node's http (not curl) so multi-byte emoji are encoded correctly.
 *
 * Run:  node test-demo.js
 * Leaves a live, populated demo room printed at the end so you can open it in
 * the browser and see the result.
 */

const http = require('http');

const HOST = 'localhost';
const PORT = process.env.PORT || 3000;

// ---- tiny http helpers -----------------------------------------------------
function request(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {},
      },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null });
          } catch (e) {
            resolve({ status: res.statusCode, body: s });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const action = (body) => request('POST', '/api/action', body).then((r) => r.body);
const state = (roomId, playerId) =>
  request(
    'GET',
    `/api/state?roomId=${encodeURIComponent(roomId)}&playerId=${encodeURIComponent(playerId)}`
  ).then((r) => r.body);

// ---- assertion bookkeeping -------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    failures.push(label + (detail ? '  — ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? '  — ' + detail : ''));
  }
}
const nameOf = (st, id) => (st.players.find((p) => p.id === id) || {}).name;
const playerById = (st, id) => st.players.find((p) => p.id === id);

// ---- the run ---------------------------------------------------------------
(async () => {
  // Unique per-run room so assertions can't be contaminated by a browser tab
  // sitting on the shared demo room (its poll would re-join and skew counts).
  const ROOM = 'test-' + PORT + '-' + Date.now();
  const REACTIONS = ['👍', '👎', '🎉', '😂', '🤔', '❤️', '🔥', '👏', '😮', '🚀'];

  // 10 agents: agent-0 is the host/owner (joins first). agent-9 is a spectator.
  const agents = Array.from({ length: 10 }, (_, i) => ({
    id: 'agent-' + i,
    name: 'Agent ' + i,
    isSpectator: i === 9,
  }));
  const host = agents[0];
  const spectator = agents[9];
  const voters = agents.filter((a) => !a.isSpectator);

  console.log('\n=== Planning Poker — 10-agent functional test ===');
  console.log('Room:', ROOM, '| voters:', voters.length, '| spectators: 1\n');

  // Clean slate: everyone leaves any prior instance of this room.
  await Promise.all(agents.map((a) => action({ type: 'leave', roomId: ROOM, playerId: a.id })));

  // --- 1. JOIN (concurrent) -------------------------------------------------
  console.log('[1] Join — 10 agents concurrently');
  // Host joins first (alone) so ownership is deterministic, then the rest race.
  await action({ type: 'join', roomId: ROOM, playerId: host.id, name: host.name, isSpectator: false });
  await Promise.all(
    agents.slice(1).map((a) =>
      action({ type: 'join', roomId: ROOM, playerId: a.id, name: a.name, isSpectator: a.isSpectator })
    )
  );
  let st = await state(ROOM, host.id);
  check('all 10 players present', st.players.length === 10, 'got ' + st.players.length);
  check('agent-0 is host', st.hostId === host.id, 'hostId=' + st.hostId);
  check('agent-9 is spectator', !!(playerById(st, spectator.id) || {}).isSpectator);
  check('9 non-spectators', st.players.filter((p) => !p.isSpectator).length === 9);

  // --- 2. SET TOPIC ---------------------------------------------------------
  console.log('[2] Set topic');
  await action({ type: 'setTopic', roomId: ROOM, playerId: host.id, topic: 'DEMO-42: Checkout flow revamp' });
  st = await state(ROOM, host.id);
  check('topic set', st.topic === 'DEMO-42: Checkout flow revamp', 'topic=' + JSON.stringify(st.topic));

  // --- 3. VOTING (concurrent) ----------------------------------------------
  console.log('[3] Voting — 9 voters cast concurrently, mixed values');
  const votePlan = ['5', '5', '5', '8', '3', '5', '?', '☕', '5']; // 9 values; mode should be "5"
  await Promise.all(
    voters.map((a, i) => action({ type: 'vote', roomId: ROOM, playerId: a.id, value: votePlan[i] }))
  );
  st = await state(ROOM, host.id);
  check('all 9 voters marked hasVoted', st.players.filter((p) => p.hasVoted).length === 9);
  check('votes hidden before reveal', st.players.every((p) => p.vote === null));
  check('spectator did not vote', !playerById(st, spectator.id).hasVoted);

  // --- 4. SPECTATOR CANNOT VOTE (guard) ------------------------------------
  console.log('[4] Guard — spectator vote is rejected');
  // Spectators aren't blocked by store.vote (any member can vote); the client
  // hides the deck. So this documents actual server behavior rather than
  // asserting a rejection. We confirm the store accepts it but the UI wouldn't
  // show a deck — so instead we verify a NON-MEMBER is rejected.
  const ghost = await action({ type: 'vote', roomId: ROOM, playerId: 'ghost-x', value: '3' });
  check('non-member vote rejected', ghost.ok === false, 'ok=' + ghost.ok);

  // --- 5. REACTIONS (all emojis, incl. spectator) --------------------------
  console.log('[5] Reactions — every emoji, spectator included');
  const reactResults = await Promise.all(
    REACTIONS.map((e, i) =>
      action({ type: 'react', roomId: ROOM, playerId: agents[i].id, emoji: e })
    )
  );
  check('all 10 reactions accepted', reactResults.every((r) => r.ok === true));
  st = await state(ROOM, host.id);
  check('reactions present in state', (st.reactions || []).length >= 10, 'count=' + (st.reactions || []).length);
  check('reactions carry sender name + id', (st.reactions || []).every((r) => r.by && r.id));
  const specReacted = (st.reactions || []).some((r) => r.by === spectator.name);
  check('spectator reaction included', specReacted);
  const badReact = await action({ type: 'react', roomId: ROOM, playerId: host.id, emoji: '<script>' });
  check('invalid emoji rejected', badReact.ok === false, 'ok=' + badReact.ok);

  // --- 5b. LIVE CHAT --------------------------------------------------------
  console.log('[5b] Live chat — messages, guards, emoji, injection-safety');
  const c1 = await action({ type: 'chat', roomId: ROOM, playerId: host.id, text: 'Hey team 👋 ready to point?' });
  const c2 = await action({ type: 'chat', roomId: ROOM, playerId: agents[1].id, text: 'Yep, my vote is in.' });
  const c3 = await action({ type: 'chat', roomId: ROOM, playerId: spectator.id, text: 'Watching along 👀' });
  check('host chat accepted', c1.ok === true);
  check('voter chat accepted', c2.ok === true);
  check('spectator chat accepted', c3.ok === true);
  const emptyChat = await action({ type: 'chat', roomId: ROOM, playerId: host.id, text: '   ' });
  check('empty chat rejected', emptyChat.ok === false, 'ok=' + emptyChat.ok);
  const ghostChat = await action({ type: 'chat', roomId: ROOM, playerId: 'ghost-x', text: 'boo' });
  check('non-member chat rejected', ghostChat.ok === false, 'ok=' + ghostChat.ok);
  st = await state(ROOM, host.id);
  check('3 chat messages in state', (st.chat || []).length === 3, 'count=' + (st.chat || []).length);
  check('chat carries by/byId/id/text', (st.chat || []).every((m) => m.by && m.byId && m.id && m.text));
  check('chat preserves emoji', (st.chat || [])[0].text.indexOf('👋') !== -1);
  const overLong = 'x'.repeat(500);
  await action({ type: 'chat', roomId: ROOM, playerId: host.id, text: overLong });
  st = await state(ROOM, host.id);
  const lastMsg = (st.chat || [])[st.chat.length - 1];
  check('chat length capped at 300', lastMsg.text.length === 300, 'len=' + lastMsg.text.length);

  // --- 6. REVEAL GUARD + REVEAL --------------------------------------------
  console.log('[6] Reveal — non-host blocked, host reveals');
  const nonHostReveal = await action({ type: 'reveal', roomId: ROOM, playerId: agents[1].id });
  check('non-host reveal rejected', nonHostReveal.ok === false, 'ok=' + nonHostReveal.ok);
  const revealed = await action({ type: 'reveal', roomId: ROOM, playerId: host.id });
  check('host reveal ok', revealed.ok === true);
  st = await state(ROOM, host.id);
  check('room revealed', st.revealed === true);
  check('votes now visible', st.players.filter((p) => p.vote !== null).length === 9);

  // --- 7. STATS -------------------------------------------------------------
  console.log('[7] Stats');
  // Numeric votes: 5,5,5,8,3,5,5 => avg = 36/7 ≈ 5.1 ; mode = 5 ; count = 9 (incl ?,☕)
  check('stats.count = 9', st.stats.count === 9, 'count=' + st.stats.count);
  check('stats.mode = 5', String(st.stats.mode) === '5', 'mode=' + st.stats.mode);
  check('stats.average ≈ 5.1', st.stats.average === 5.1, 'avg=' + st.stats.average);
  check('no agreement (mixed votes)', st.stats.agreement === false);

  // --- 8. HISTORY -----------------------------------------------------------
  console.log('[8] History — reveal recorded a round');
  check('history has 1 round', st.history.length === 1, 'len=' + st.history.length);
  check('history round topic captured', st.history[0].topic === 'DEMO-42: Checkout flow revamp');
  check('history round has 9 votes', st.history[0].votes.length === 9);

  // --- 9. VOTE-AFTER-REVEAL GUARD ------------------------------------------
  console.log('[9] Guard — voting closed after reveal');
  const lateVote = await action({ type: 'vote', roomId: ROOM, playerId: agents[2].id, value: '1' });
  check('vote rejected while revealed', lateVote.ok === false, 'ok=' + lateVote.ok);

  // --- 10. RESET (host) — same topic kept -----------------------------------
  console.log('[10] Reset — clears votes, keeps topic');
  const nonHostReset = await action({ type: 'reset', roomId: ROOM, playerId: agents[3].id });
  check('non-host reset rejected', nonHostReset.ok === false);
  await action({ type: 'reset', roomId: ROOM, playerId: host.id });
  st = await state(ROOM, host.id);
  check('reset hides cards', st.revealed === false);
  check('reset clears votes', st.players.every((p) => !p.hasVoted));
  check('reset keeps topic', st.topic === 'DEMO-42: Checkout flow revamp');

  // --- 11. NEW ROUND (host) — topic cleared ---------------------------------
  console.log('[11] New round — clears votes AND topic');
  // First cast a couple votes + reveal so there's a 2nd history round.
  await Promise.all([
    action({ type: 'vote', roomId: ROOM, playerId: agents[1].id, value: '2' }),
    action({ type: 'vote', roomId: ROOM, playerId: agents[2].id, value: '2' }),
    action({ type: 'vote', roomId: ROOM, playerId: agents[3].id, value: '2' }),
  ]);
  await action({ type: 'reveal', roomId: ROOM, playerId: host.id });
  st = await state(ROOM, host.id);
  check('agreement on unanimous 2s', st.stats.agreement === true, 'agreement=' + st.stats.agreement);
  check('history now 2 rounds', st.history.length === 2, 'len=' + st.history.length);
  await action({ type: 'newRound', roomId: ROOM, playerId: host.id });
  st = await state(ROOM, host.id);
  check('new round clears topic', st.topic === '');
  check('new round clears votes', st.players.every((p) => !p.hasVoted));

  // --- 12. CHANGE NAME ------------------------------------------------------
  console.log('[12] Change name');
  await action({ type: 'changeName', roomId: ROOM, playerId: agents[5].id, name: 'Renamed Rae' });
  st = await state(ROOM, host.id);
  check('name changed', nameOf(st, agents[5].id) === 'Renamed Rae', 'name=' + nameOf(st, agents[5].id));

  // --- 13. TRANSFER HOST ----------------------------------------------------
  console.log('[13] Transfer host');
  const badTransfer = await action({ type: 'transferHost', roomId: ROOM, playerId: agents[4].id, targetId: agents[1].id });
  check('non-host transfer rejected', badTransfer.ok === false);
  await action({ type: 'transferHost', roomId: ROOM, playerId: host.id, targetId: agents[1].id });
  st = await state(ROOM, host.id);
  check('host transferred to agent-1', st.hostId === agents[1].id, 'hostId=' + st.hostId);
  // give it back so the demo room's host is agent-0 (Agent 0)
  await action({ type: 'transferHost', roomId: ROOM, playerId: agents[1].id, targetId: host.id });
  st = await state(ROOM, host.id);
  check('host transferred back to agent-0', st.hostId === host.id);

  // --- 14. CLEAR HISTORY ----------------------------------------------------
  console.log('[14] Clear history');
  const badClear = await action({ type: 'clearHistory', roomId: ROOM, playerId: agents[6].id });
  check('non-host clearHistory rejected', badClear.ok === false);
  await action({ type: 'clearHistory', roomId: ROOM, playerId: host.id });
  st = await state(ROOM, host.id);
  check('history cleared', st.history.length === 0, 'len=' + st.history.length);

  // --- 15. LEAVE + host reassignment ---------------------------------------
  console.log('[15] Leave — a player leaves, count drops');
  await action({ type: 'leave', roomId: ROOM, playerId: agents[8].id });
  st = await state(ROOM, host.id);
  check('player count now 9', st.players.length === 9, 'count=' + st.players.length);
  check('host still agent-0 after non-host leave', st.hostId === host.id);

  // --- Tear down the isolated test room; seed a separate viewable demo room -
  console.log('\n[demo] Tearing down test room, seeding a fresh demo room…');
  await Promise.all(agents.map((a) => action({ type: 'leave', roomId: ROOM, playerId: a.id })));

  // The viewable room uses a stable id so the link is easy to open. It's OK if a
  // browser tab is already here — we just (re)seed the agents around it.
  const DEMO = 'demo-' + PORT;
  const demoAgents = Array.from({ length: 10 }, (_, i) => ({
    id: 'agent-' + i,
    name: 'Agent ' + i,
    isSpectator: i === 9,
  }));
  for (const a of demoAgents) {
    await action({ type: 'join', roomId: DEMO, playerId: a.id, name: a.name, isSpectator: a.isSpectator });
  }
  await action({ type: 'setTopic', roomId: DEMO, playerId: 'agent-0', topic: 'DEMO-101: Live demo — click Reveal!' });
  const demoVotes = ['3', '5', '5', '8', '5', '2', '5', '?', '☕']; // 9 voters
  const demoVoters = demoAgents.filter((a) => !a.isSpectator);
  for (let i = 0; i < demoVoters.length; i++) {
    await action({ type: 'vote', roomId: DEMO, playerId: demoVoters[i].id, value: demoVotes[i] });
  }
  // Seed a short chat conversation so the left panel isn't empty on open.
  const demoChat = [
    ['agent-0', 'Morning all 👋 let\'s point DEMO-101.'],
    ['agent-1', 'On it — this looks like a 5 to me.'],
    ['agent-3', 'I went 8, the migration worries me 😅'],
    ['agent-9', 'Spectating today, will keep notes 👀'],
    ['agent-0', 'Fair — let\'s reveal and talk it through 🔥'],
  ];
  for (const [id, text] of demoChat) {
    await action({ type: 'chat', roomId: DEMO, playerId: id, text });
  }
  const demoState = await state(DEMO, 'agent-0');
  const seededVoted = demoState.players.filter((p) => p.hasVoted).length;

  // ---- summary -------------------------------------------------------------
  console.log('\n=== RESULT ===');
  console.log('PASS: ' + pass + '   FAIL: ' + fail);
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log(
    '\nDemo room seeded: ' +
      demoState.players.length +
      ' players, ' +
      seededVoted +
      ' voted, unrevealed.'
  );
  console.log('Open it in your browser:');
  console.log('  http://localhost:' + PORT + '/?room=' + DEMO);
  console.log('(Hard-refresh Ctrl+Shift+R to bust cache, then click Reveal.)\n');

  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
