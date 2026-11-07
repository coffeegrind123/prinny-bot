import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { MemoryWebhookStore } from '../src/webhook/store.js';
import { WebhookServer } from '../src/webhook/server.js';
import { ButtonStyle, ComponentType } from '../src/webhook/types.js';

type SentEvent = { roomId: string; content: Record<string, unknown> };

/**
 * The smallest MatrixClient the server actually touches. Deliberately not a
 * mock of the whole SDK: the point of the test is the HTTP contract, and a
 * stub that records sends makes an assertion about what reached Matrix
 * possible without a homeserver.
 */
const fakeClient = (sent: SentEvent[]) =>
  ({
    getUserId: () => '@bot:example.org',
    sendMessage: async (roomId: string, content: Record<string, unknown>) => {
      sent.push({ roomId, content });
      return { event_id: `$event${sent.length}` };
    },
    sendEvent: async (roomId: string, _type: string, content: Record<string, unknown>) => {
      sent.push({ roomId, content });
      return { event_id: `$event${sent.length}` };
    },
    redactEvent: async () => ({ event_id: '$redaction' }),
    fetchRoomEvent: async () => ({ content: { body: 'hello' } }),
    getRoom: () => undefined,
    uploadContent: async () => ({ content_uri: 'mxc://example.org/abc' }),
  }) as unknown as MatrixClient;

describe('webhook server', () => {
  let server: WebhookServer;
  let base: string;
  let sent: SentEvent[];
  let store: MemoryWebhookStore;

  beforeEach(async () => {
    sent = [];
    store = new MemoryWebhookStore();
    server = new WebhookServer({
      client: fakeClient(sent),
      store,
      authTokens: ['secret-bot-token'],
      publicUrl: 'https://prinny.example',
      applicationId: '999',
    });
    await server.listen(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const address = (server as any).server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  const createWebhook = async (): Promise<{ id: string; token: string }> => {
    const response = await fetch(`${base}/api/v10/channels/${encodeURIComponent('!room:example.org')}/webhooks`, {
      method: 'POST',
      headers: { authorization: 'Bot secret-bot-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ci' }),
    });
    expect(response.status).toBe(200);
    const webhook = (await response.json()) as { id: string; token: string; url: string };
    expect(webhook.url).toBe(`https://prinny.example/api/webhooks/${webhook.id}/${webhook.token}`);
    return webhook;
  };

  it('refuses to create a webhook without a bot token', async () => {
    const response = await fetch(`${base}/api/channels/${encodeURIComponent('!room:example.org')}/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ci' }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects the webhook names Discord rejects', async () => {
    const response = await fetch(`${base}/api/channels/${encodeURIComponent('!room:example.org')}/webhooks`, {
      method: 'POST',
      headers: { authorization: 'Bot secret-bot-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'discord-relay' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe(50035);
  });

  it('executes a webhook and answers 204 without wait', async () => {
    const { id, token } = await createWebhook();
    const response = await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '**hello** from CI' }),
    });
    expect(response.status).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.roomId).toBe('!room:example.org');
    expect(sent[0]?.content.formatted_body).toContain('<strong>hello</strong>');
  });

  it('returns a message object with wait=true', async () => {
    const { id, token } = await createWebhook();
    const response = await fetch(`${base}/api/webhooks/${id}/${token}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', username: 'CI Bot' }),
    });
    expect(response.status).toBe(200);
    const message = (await response.json()) as { id: string; webhook_id: string; author: { username: string } };
    expect(message.webhook_id).toBe(id);
    expect(message.author.username).toBe('CI Bot');
    expect(/^\d+$/.test(message.id)).toBe(true);
  });

  it('carries username and an mxc avatar as a per-message identity', async () => {
    const { id, token } = await createWebhook();
    await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'hi',
        username: 'Deploy',
        avatar_url: 'mxc://example.org/abc',
      }),
    });
    expect(sent[0]?.content['in.prinny.webhook']).toEqual({
      id,
      username: 'Deploy',
      avatar_url: 'mxc://example.org/abc',
    });
  });

  // README: "The same rule applies to `avatar_url`, where only `mxc://` is
  // honoured" - rendering an arbitrary remote URL would leak every reader's IP
  // address to whoever holds the webhook token.
  it('drops a non-mxc avatar_url rather than relaying it', async () => {
    const { id, token } = await createWebhook();
    await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', username: 'Deploy', avatar_url: 'https://x/y.png' }),
    });
    expect(sent[0]?.content['in.prinny.webhook']).toEqual({ id, username: 'Deploy' });
  });

  it('refuses more attachments than Discord permits', async () => {
    const { id, token } = await createWebhook();
    const boundary = 'testboundary';
    const parts = Array.from({ length: 12 }, (_, i) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="files[${i}]"; filename="f${i}.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nx\r\n`
    ).join('');
    const response = await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: `${parts}--${boundary}--\r\n`,
    });
    expect(response.status).toBe(400);
  });

  // A malformed percent-escape used to throw URIError out of the async handler,
  // which Node turns into an unhandled rejection and a dead process.
  it('answers a malformed percent-escape instead of dying', async () => {
    const response = await fetch(`${base}/%zz`);
    expect(response.status).toBe(404);
    // Still serving: the process survived the previous request.
    const after = await fetch(`${base}/api/webhooks/does-not-exist/nope`, { method: 'POST' });
    expect(after.status).toBe(404);
  });

  it('refuses an empty message', async () => {
    const { id, token } = await createWebhook();
    const response = await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe(50006);
  });

  it('answers the same 404 for a wrong token as for an unknown id', async () => {
    const { id } = await createWebhook();
    const wrongToken = await fetch(`${base}/api/webhooks/${id}/not-the-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    const unknownId = await fetch(`${base}/api/webhooks/123456/whatever`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(wrongToken.status).toBe(404);
    expect(unknownId.status).toBe(404);
    expect(await wrongToken.json()).toEqual(await unknownId.json());
  });

  it('accepts a multipart upload with payload_json', async () => {
    const { id, token } = await createWebhook();
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: 'see attached' }));
    form.append('files[0]', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }), 'a.bin');

    const response = await fetch(`${base}/api/webhooks/${id}/${token}?wait=true`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);
    // One text event and one file event.
    expect(sent).toHaveLength(2);
    expect(sent[1]?.content.msgtype).toBe('m.file');
    expect(sent[1]?.content.url).toBe('mxc://example.org/abc');
  });

  it('renders components as an inline keyboard when asked', async () => {
    const { id, token } = await createWebhook();
    await fetch(`${base}/api/webhooks/${id}/${token}?with_components=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Deploy?',
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: ButtonStyle.Primary, label: 'Go', custom_id: 'go' },
            ],
          },
        ],
      }),
    });
    expect(sent[0]?.content['app.prinny.bot.reply_markup']).toEqual({
      inline_keyboard: [[{ text: 'Go', style: 'primary', callback_data: 'go' }]],
    });
  });

  it('ignores components without with_components, as Discord does', async () => {
    const { id, token } = await createWebhook();
    await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Deploy?',
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: ButtonStyle.Primary, label: 'Go', custom_id: 'go' },
            ],
          },
        ],
      }),
    });
    expect(sent[0]?.content['app.prinny.bot.reply_markup']).toBeUndefined();
  });

  it('edits a message it sent', async () => {
    const { id, token } = await createWebhook();
    const created = await fetch(`${base}/api/webhooks/${id}/${token}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'before' }),
    });
    const message = (await created.json()) as { id: string };

    const edited = await fetch(`${base}/api/webhooks/${id}/${token}/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'after' }),
    });
    expect(edited.status).toBe(200);
    const replacement = sent[sent.length - 1]?.content;
    expect((replacement?.['m.relates_to'] as { rel_type: string }).rel_type).toBe('m.replace');
    expect(String(replacement?.body).startsWith('* ')).toBe(true);
  });

  it('keeps the per-message identity through an edit', async () => {
    const { id, token } = await createWebhook();
    const created = await fetch(`${base}/api/webhooks/${id}/${token}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'before',
        username: 'Deploy',
        avatar_url: 'mxc://example.org/abc',
      }),
    });
    const message = (await created.json()) as { id: string };

    await fetch(`${base}/api/webhooks/${id}/${token}/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'after' }),
    });
    const replacement = sent[sent.length - 1]?.content ?? {};
    const newContent = replacement['m.new_content'] as Record<string, unknown>;
    const identity = { id, username: 'Deploy', avatar_url: 'mxc://example.org/abc' };
    // Clients render an edited event from `m.new_content`, so that is where it matters.
    expect(newContent['in.prinny.webhook']).toEqual(identity);
    expect(replacement['in.prinny.webhook']).toEqual(identity);
  });

  it('puts the identity on attachments, polls and a new thread root too', async () => {
    const { id, token } = await createWebhook();
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        username: 'Deploy',
        thread_name: 'Release 1.2',
        poll: { question: { text: 'Ship?' }, answers: [{ poll_media: { text: 'yes' } }] },
      })
    );
    form.append('files[0]', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'a.png');
    const response = await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(204);
    // thread root, poll, file
    expect(sent).toHaveLength(3);
    sent.forEach(({ content }) => {
      expect(content['in.prinny.webhook']).toEqual({ id, username: 'Deploy' });
    });
  });

  describe('MSC4144 per-message profile', () => {
    const PROFILE = 'com.beeper.per_message_profile';

    const post = async (id: string, token: string, body: unknown, query = '') =>
      fetch(`${base}/api/webhooks/${id}/${token}${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('writes the profile with the name fallback, and keeps the legacy key', async () => {
      const { id, token } = await createWebhook();
      await post(id, token, {
        content: '**hi**',
        username: 'Deploy',
        avatar_url: 'mxc://example.org/abc',
      });
      const content = sent[0]?.content ?? {};
      const profile = content[PROFILE] as Record<string, unknown>;
      expect(profile.id).toMatch(new RegExp(`^${id}:[0-9a-f]{16}$`));
      expect(profile).toMatchObject({
        displayname: 'Deploy',
        avatar_url: 'mxc://example.org/abc',
        has_fallback: true,
        'in.prinny.webhook': { id },
      });
      expect(content.body).toBe('Deploy: hi');
      // Inside the leading <p>, so the name stays on the first line.
      expect(content.formatted_body).toBe(
        '<p><strong data-mx-profile-fallback>Deploy: </strong><strong>hi</strong></p>'
      );
      expect(content['in.prinny.webhook']).toEqual({
        id,
        username: 'Deploy',
        avatar_url: 'mxc://example.org/abc',
      });
    });

    it('gives each identity of a webhook its own id, and the same id each time', async () => {
      const { id, token } = await createWebhook();
      await post(id, token, { content: 'a', username: 'CI' });
      await post(id, token, { content: 'b', username: 'Deploy' });
      await post(id, token, { content: 'c', username: 'CI' });
      const ids = sent.map(({ content }) => (content[PROFILE] as { id: string }).id);
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[0]).toBe(ids[2]);
    });

    it('normalises the name the way readers do before prefixing it', async () => {
      const { id, token } = await createWebhook();
      await post(id, token, { content: 'x', username: `  Build\n\t ${'y'.repeat(100)}` });
      const content = sent[0]?.content ?? {};
      const name = (content[PROFILE] as { displayname: string }).displayname;
      expect(name.startsWith('Build y')).toBe(true);
      expect(Array.from(name)).toHaveLength(80);
      expect(String(content.body).startsWith(`${name}: `)).toBe(true);
    });

    it('escapes the name in the HTML fallback exactly as the Prinny client expects', async () => {
      const { id, token } = await createWebhook();
      await post(id, token, { content: 'x', username: `<O'Brien & "co">` });
      expect(String(sent[0]?.content.formatted_body)).toContain(
        '<strong data-mx-profile-fallback>&lt;O&#39;Brien &amp; &quot;co&quot;&gt;: </strong>'
      );
    });

    it('prefixes captions but not bare file names, and never polls', async () => {
      const { id, token } = await createWebhook();
      const form = new FormData();
      form.append(
        'payload_json',
        JSON.stringify({
          username: 'Deploy',
          attachments: [{ id: 1, description: 'the build log' }],
          poll: { question: { text: 'Ship?' }, answers: [{ poll_media: { text: 'yes' } }] },
        })
      );
      form.append('files[0]', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'a.png');
      form.append('files[1]', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'b.png');
      const response = await fetch(`${base}/api/webhooks/${id}/${token}`, { method: 'POST', body: form });
      expect(response.status).toBe(204);
      // poll, a.png (no caption), b.png (caption)
      expect(sent).toHaveLength(3);
      const [poll, bare, captioned] = sent.map(({ content }) => content);
      expect((poll?.[PROFILE] as { has_fallback: boolean }).has_fallback).toBe(false);
      expect(bare?.body).toBe('a.png');
      expect((bare?.[PROFILE] as { has_fallback: boolean }).has_fallback).toBe(false);
      expect(captioned?.body).toBe('Deploy: the build log');
      expect((captioned?.[PROFILE] as { has_fallback: boolean }).has_fallback).toBe(true);
    });

    it('puts the profile and fallback in an edit\'s new content', async () => {
      const { id, token } = await createWebhook();
      const created = await post(id, token, { content: 'before', username: 'Deploy' }, '?wait=true');
      const message = (await created.json()) as { id: string };
      await fetch(`${base}/api/webhooks/${id}/${token}/messages/${message.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'after' }),
      });
      const replacement = sent[sent.length - 1]?.content ?? {};
      const newContent = replacement['m.new_content'] as Record<string, unknown>;
      expect(newContent.body).toBe('Deploy: after');
      expect((newContent[PROFILE] as { has_fallback: boolean }).has_fallback).toBe(true);
      expect(replacement.body).toBe('* Deploy: after');
    });

    it('hands the text back without the fallback over the Discord API', async () => {
      const { id, token } = await createWebhook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).client.fetchRoomEvent = async () => ({ content: sent[0]?.content });
      const response = await post(id, token, { content: 'hello', username: 'Deploy' }, '?wait=true');
      const message = (await response.json()) as { content: string };
      expect(message.content).toBe('hello');
    });

    it('leaves the text alone when profileFallback is off', async () => {
      const quietSent: SentEvent[] = [];
      const quiet = new WebhookServer({
        client: fakeClient(quietSent),
        store,
        authTokens: ['secret-bot-token'],
        profileFallback: false,
      });
      await quiet.listen(0);
      try {
        const { id, token } = await createWebhook();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const port = ((quiet as any).server.address() as AddressInfo).port;
        await fetch(`http://127.0.0.1:${port}/api/webhooks/${id}/${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'hi', username: 'Deploy' }),
        });
        const content = quietSent[0]?.content ?? {};
        expect(content.body).toBe('hi');
        expect((content[PROFILE] as { has_fallback: boolean }).has_fallback).toBe(false);
      } finally {
        await quiet.close();
      }
    });
  });

  it('deletes a message it sent', async () => {
    const { id, token } = await createWebhook();
    const created = await fetch(`${base}/api/webhooks/${id}/${token}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'bye' }),
    });
    const message = (await created.json()) as { id: string };
    const response = await fetch(`${base}/api/webhooks/${id}/${token}/messages/${message.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(204);
    expect(store.getMessage(message.id)).toBeUndefined();
  });

  it('refuses to edit a message belonging to another webhook', async () => {
    const first = await createWebhook();
    const second = await createWebhook();
    const created = await fetch(`${base}/api/webhooks/${first.id}/${first.token}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'mine' }),
    });
    const message = (await created.json()) as { id: string };
    const response = await fetch(
      `${base}/api/webhooks/${second.id}/${second.token}/messages/${message.id}`,
      { method: 'DELETE' }
    );
    expect(response.status).toBe(404);
  });

  it('accepts a Slack payload and defaults wait to true', async () => {
    const { id, token } = await createWebhook();
    const response = await fetch(`${base}/api/webhooks/${id}/${token}/slack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'from slack' }),
    });
    expect(response.status).toBe(200);
    expect(sent[0]?.content.body).toContain('from slack');
  });

  it('accepts a GitHub payload and says nothing for ping', async () => {
    const { id, token } = await createWebhook();
    const ping = await fetch(`${base}/api/webhooks/${id}/${token}/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
      body: JSON.stringify({ zen: 'hi' }),
    });
    expect(ping.status).toBe(204);
    expect(sent).toHaveLength(0);

    const push = await fetch(`${base}/api/webhooks/${id}/${token}/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({
        ref: 'refs/heads/main',
        repository: { full_name: 'o/r' },
        commits: [{ id: 'abc1234', message: 'hi', url: 'https://x' }],
      }),
    });
    expect(push.status).toBe(200);
    expect(sent[0]?.content.formatted_body).toContain('o/r:main');
  });

  it('lists a channel webhooks and reads one back by token without a user', async () => {
    const { id, token } = await createWebhook();
    const list = await fetch(`${base}/api/channels/${encodeURIComponent('!room:example.org')}/webhooks`, {
      headers: { authorization: 'Bot secret-bot-token' },
    });
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const byToken = await fetch(`${base}/api/webhooks/${id}/${token}`);
    const webhook = (await byToken.json()) as { user?: unknown };
    expect(webhook.user).toBeUndefined();
  });

  it('deletes a webhook and stops accepting its token', async () => {
    const { id, token } = await createWebhook();
    const deleted = await fetch(`${base}/api/webhooks/${id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bot secret-bot-token' },
    });
    expect(deleted.status).toBe(204);

    const after = await fetch(`${base}/api/webhooks/${id}/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(after.status).toBe(404);
  });

  it('answers 405 for a known path with the wrong method', async () => {
    const response = await fetch(`${base}/api/webhooks/1/2`, { method: 'PUT' });
    expect(response.status).toBe(405);
  });
});
