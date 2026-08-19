/**
 * A Discord-compatible webhook server in front of a Matrix room.
 *
 * Run it, then point anything that posts to a Discord webhook at the URL it
 * prints. curl, a CI job, a Grafana alert, a Slack-shaped integration, a GitHub
 * repository webhook - all of them work unchanged.
 *
 *   MATRIX_HOMESERVER=https://matrix.example.org \
 *   MATRIX_USER_ID=@hooks:example.org \
 *   MATRIX_PASSWORD=... \
 *   MATRIX_OWNER=@you:example.org \
 *   WEBHOOK_ROOM='!room:example.org' \
 *   WEBHOOK_ADMIN_TOKEN=$(openssl rand -hex 32) \
 *   npx tsx examples/webhook/server.ts
 */

import { Bot } from '../../src/index.js';
import { FileWebhookStore, WebhookServer } from '../../src/webhook/index.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const bot = new Bot({
  homeserverUrl: required('MATRIX_HOMESERVER'),
  userId: required('MATRIX_USER_ID'),
  password: required('MATRIX_PASSWORD'),
  access: { ownerUserId: required('MATRIX_OWNER') },
});

await bot.start();

const webhooks = new WebhookServer({
  client: bot.matrixClient,
  // Tokens survive restarts, so a URL handed to a CI job keeps working.
  store: new FileWebhookStore('./webhooks.json'),
  // Without this every management route is closed, and existing webhook URLs
  // still work - which is the right posture for a server that only needs to
  // mint webhooks occasionally.
  authTokens: [required('WEBHOOK_ADMIN_TOKEN')],
  publicUrl: process.env.WEBHOOK_PUBLIC_URL ?? 'http://127.0.0.1:8080',
  applicationId: '1',
});

const port = Number(process.env.WEBHOOK_PORT ?? 8080);
await webhooks.listen(port, process.env.WEBHOOK_HOST ?? '127.0.0.1');

// Addressing the room directly registers a channel id for it on the spot.
const channel = webhooks.registerChannel(required('WEBHOOK_ROOM'), { name: 'general' });

console.log(`webhook server listening on ${port}`);
console.log(`channel id for ${channel.roomId}: ${channel.id}`);
console.log('');
console.log('Create a webhook:');
console.log(
  `  curl -X POST http://127.0.0.1:${port}/api/channels/${channel.id}/webhooks \\\n` +
    `    -H "authorization: Bot $WEBHOOK_ADMIN_TOKEN" \\\n` +
    `    -H 'content-type: application/json' \\\n` +
    `    -d '{"name":"ci"}'`
);
console.log('');
console.log('Then post to the `url` it returns, exactly as you would to Discord:');
console.log(
  `  curl -X POST "$URL" -H 'content-type: application/json' \\\n` +
    `    -d '{"username":"CI","content":"Build **passed**","embeds":[{"title":"main","color":3066993}]}'`
);
