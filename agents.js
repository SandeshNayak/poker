'use strict';

/**
 * Autonomous agents for Planning Poker.
 * Spawns simulated team members into a room that:
 * 1. Join the room with realistic developer roles.
 * 2. Keep polling /api/state to stay alive and avoid being pruned.
 * 3. Automatically vote when a new round is active with fast, responsive delays.
 * 4. Send emoji reactions and chat messages when cards are revealed.
 *
 * Usage:
 *   node agents.js [roomId] [count]
 */

const http = require('http');

const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 3000;
const ROOM_ID = process.argv[2] || process.env.ROOM || 'zlrpwcj2';
const AGENT_COUNT = Math.min(20, Math.max(1, parseInt(process.argv[3], 10) || 14));

const AGENT_PERSONAS = [
  {
    id: 'agent-bot-ada',
    name: '🤖 Ada (Frontend)',
    votes: ['2', '3', '3', '5'],
    chatQuotes: [
      'UI layout is clear, looks like a 3 to me.',
      'A bit of responsive styling needed, voting 3.',
      'Straightforward UI work, voted 2.'
    ],
  },
  {
    id: 'agent-bot-alan',
    name: '🤖 Alan (Backend)',
    votes: ['3', '5', '5', '8'],
    chatQuotes: [
      'Need to ensure schema migrations and API latency are solid.',
      'Backend endpoints should be fairly clean, going with 5.',
      'Voted! Just need to make sure we cache responses.'
    ],
  },
  {
    id: 'agent-bot-grace',
    name: '🤖 Grace (QA)',
    votes: ['3', '5', '5'],
    chatQuotes: [
      'I will prep the test cases and check edge cases.',
      'Looks good, voting 5 for automated test coverage.',
      'Edge cases need attention, but looks manageable.'
    ],
  },
  {
    id: 'agent-bot-sam',
    name: '🤖 Sam (DevOps)',
    votes: ['1', '2', '3', '5'],
    chatQuotes: [
      'CI/CD pipeline and deployments look ready for this.',
      'Config changes only, voting 2.',
      'All set from the infra side 👍'
    ],
  },
  {
    id: 'agent-bot-linus',
    name: '🤖 Linus (Systems)',
    votes: ['3', '5', '8'],
    chatQuotes: [
      'Low-level plumbing and concurrency look involved, 5 points.',
      'Memory checks and async handling needed, voting 5.',
      'Solid systems work, going with 3.'
    ],
  },
  {
    id: 'agent-bot-maya',
    name: '🤖 Maya (UI/UX)',
    votes: ['1', '2', '3'],
    chatQuotes: [
      'Design tokens and micro-interactions ready, voting 2.',
      'Clean user flow, straightforward 2.',
      'Accessibility and contrast look great, voting 3.'
    ],
  },
  {
    id: 'agent-bot-raj',
    name: '🤖 Raj (Mobile)',
    votes: ['2', '3', '5'],
    chatQuotes: [
      'Both iOS and Android viewports look solid, voting 3.',
      'Touch target handling is quick, going with 2.',
      'Mobile responsive breakpoints covered, voted 3.'
    ],
  },
  {
    id: 'agent-bot-elena',
    name: '🤖 Elena (Data)',
    votes: ['3', '5', '5', '8'],
    chatQuotes: [
      'Event telemetry and analytics schema needed, voting 5.',
      'Metrics and dashboard events look straightforward, 3.',
      'Data pipeline integration looks manageable, voting 5.'
    ],
  },
  {
    id: 'agent-bot-kai',
    name: '🤖 Kai (Security)',
    votes: ['2', '3', '5'],
    chatQuotes: [
      'Auth validation and CORS headers checked, voting 3.',
      'Zero security vulnerabilities identified, voting 2.',
      'Sanitization looks tight, going with 3.'
    ],
  },
  {
    id: 'agent-bot-olivia',
    name: '🤖 Olivia (Fullstack)',
    votes: ['2', '3', '5'],
    chatQuotes: [
      'Full stack flow connects smoothly, voting 3.',
      'Clean component lifecycle and API contracts, voted 3.',
      'End-to-end integration looks straightforward, 2.'
    ],
  },
  {
    id: 'agent-bot-devon',
    name: '🤖 Devon (SRE)',
    votes: ['1', '2', '3'],
    chatQuotes: [
      'Observability and health probes look good, 2.',
      'Alert thresholds and latency look nominal, voting 2.',
      'Reliability targets are covered, voting 3.'
    ],
  },
  {
    id: 'agent-bot-clara',
    name: '🤖 Clara (Product)',
    votes: ['2', '3', '5'],
    chatQuotes: [
      'Acceptance criteria are well defined, voting 3.',
      'Clear sprint goal alignment, looks like a 3!',
      'Great value-to-effort ratio, voting 2.'
    ],
  },
  {
    id: 'agent-bot-leo',
    name: '🤖 Leo (Architect)',
    votes: ['3', '5', '8'],
    chatQuotes: [
      'Architectural decoupling looks clean, voting 5.',
      'Boundary contracts are well respected, 5.',
      'Modular architecture makes this clean, voting 3.'
    ],
  },
  {
    id: 'agent-bot-zara',
    name: '🤖 Zara (AI / ML)',
    votes: ['3', '5', '8'],
    chatQuotes: [
      'Inference latency and caching are manageable, voting 5.',
      'Model prompt tokens look minimal, voting 3.',
      'Embeddings and context window look solid, voting 5.'
    ],
  },
];

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
const getState = (roomId, playerId) =>
  request(
    'GET',
    `/api/state?roomId=${encodeURIComponent(roomId)}&playerId=${encodeURIComponent(playerId)}`
  ).then((r) => r.body);

async function main() {
  console.log(`Starting ${AGENT_COUNT} agents for room: "${ROOM_ID}" at http://${HOST}:${PORT}/?room=${ROOM_ID}`);

  const activeAgents = AGENT_PERSONAS.slice(0, AGENT_COUNT);

  // 1. Join each agent
  for (const agent of activeAgents) {
    console.log(`- Joining: ${agent.name} (${agent.id})`);
    await action({
      type: 'join',
      roomId: ROOM_ID,
      playerId: agent.id,
      name: agent.name,
      isSpectator: false,
    });
  }

  // Greet in chat once
  await action({
    type: 'chat',
    roomId: ROOM_ID,
    playerId: activeAgents[0].id,
    text: 'Hey team! Virtual agents joined and ready to estimate 🚀',
  });

  // Track state for autonomous behavior
  const agentState = {};
  for (const a of activeAgents) {
    agentState[a.id] = {
      hasVotedThisRound: false,
      voteTimeout: null,
      lastRevealed: false,
    };
  }

  // Graceful shutdown on Ctrl+C
  const cleanup = async () => {
    console.log('\nLeaving room...');
    for (const a of activeAgents) {
      try {
        await action({ type: 'leave', roomId: ROOM_ID, playerId: a.id });
      } catch (_) {}
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  console.log(`\nAgents running! Press Ctrl+C to stop.\n`);

  // Main loop: poll state every 1 second (snappy response on new rounds)
  while (true) {
    await Promise.all(
      activeAgents.map(async (agent) => {
        try {
          const st = agentState[agent.id];
          if (st && st.kicked) return;

          const res = await getState(ROOM_ID, agent.id);
          if (res && res.kicked) {
            if (st) st.kicked = true;
            return;
          }
          if (!res || !res.players) return;

          const p = res.players.find((pl) => pl.id === agent.id);
          if (!p) {
            const joinRes = await action({
              type: 'join',
              roomId: ROOM_ID,
              playerId: agent.id,
              name: agent.name,
              isSpectator: false,
            });
            if (joinRes && !joinRes.ok && joinRes.error && joinRes.error.indexOf('removed') !== -1) {
              if (st) st.kicked = true;
            }
            return;
          }

          const isRevealed = !!res.revealed;

          // Round reset or new round detected: vote quickly (400ms to 1400ms)
          if (!isRevealed && !p.hasVoted && !st.voteTimeout) {
            const delay = 400 + Math.random() * 1000;
            const voteVal = agent.votes[Math.floor(Math.random() * agent.votes.length)];

            st.voteTimeout = setTimeout(async () => {
              try {
                console.log(`[${agent.name}] Casting vote: ${voteVal}`);
                await action({
                  type: 'vote',
                  roomId: ROOM_ID,
                  playerId: agent.id,
                  value: voteVal,
                });

                // Occasionally post rationale in chat (25% chance)
                if (Math.random() < 0.25 && agent.chatQuotes.length > 0) {
                  const quote = agent.chatQuotes[Math.floor(Math.random() * agent.chatQuotes.length)];
                  await action({
                    type: 'chat',
                    roomId: ROOM_ID,
                    playerId: agent.id,
                    text: quote,
                  });
                }
              } catch (err) {
                console.error(`Error casting vote for ${agent.id}:`, err.message);
              } finally {
                st.voteTimeout = null;
              }
            }, delay);
          }

          // Just revealed -> drop reaction
          if (isRevealed && !st.lastRevealed) {
            st.lastRevealed = true;
            if (Math.random() < 0.5) {
              setTimeout(async () => {
                const emojis = ['🎉', '👍', '🔥', '👏', '🤔'];
                const emoji = emojis[Math.floor(Math.random() * emojis.length)];
                try {
                  await action({
                    type: 'react',
                    roomId: ROOM_ID,
                    playerId: agent.id,
                    emoji,
                  });
                } catch (_) {}
              }, 400 + Math.random() * 1000);
            }
          } else if (!isRevealed) {
            st.lastRevealed = false;
          }
        } catch (err) {
          // network or server glitch, retry next tick
        }
      })
    );

    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((err) => {
  console.error('Fatal error in agent runner:', err);
  process.exit(1);
});

