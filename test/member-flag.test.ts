/**
 * Spec §7: a client shows a BOT badge when the user's `m.room.member` content
 * carries `"app.prinny.bot": true`. The library defined the key but never set
 * it, so a bot without the power to publish its info had no badge at all.
 */

import { describe, expect, it, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { Api } from '../src/Api.js';
import { BotContentKey } from '../src/protocol/constants.js';

const BOT = '@bot:hs';

const fakeClient = (memberContent: Record<string, unknown> | undefined) => {
  const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$1' });
  const client = {
    getUserId: () => BOT,
    getRoom: () => ({
      getMember: () =>
        memberContent ? { events: { member: { getContent: () => memberContent } } } : null,
    }),
    sendStateEvent,
  } as unknown as MatrixClient;
  return { client, sendStateEvent };
};

describe('Api.markAsBot', () => {
  it('sets the flag on the bot member event, keeping its profile', async () => {
    const { client, sendStateEvent } = fakeClient({
      membership: 'join',
      displayname: 'Deploy Bot',
      avatar_url: 'mxc://hs/a',
    });
    expect(await new Api(client).markAsBot('!r:hs')).toBe(true);
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      'm.room.member',
      {
        membership: 'join',
        displayname: 'Deploy Bot',
        avatar_url: 'mxc://hs/a',
        [BotContentKey.MemberFlag]: true,
      },
      BOT
    );
  });

  it('does nothing when the flag is already set', async () => {
    const { client, sendStateEvent } = fakeClient({
      membership: 'join',
      [BotContentKey.MemberFlag]: true,
    });
    expect(await new Api(client).markAsBot('!r:hs')).toBe(true);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('does nothing unless the bot is joined', async () => {
    const { client, sendStateEvent } = fakeClient({ membership: 'invite' });
    expect(await new Api(client).markAsBot('!r:hs')).toBe(false);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing', async () => {
    const { client, sendStateEvent } = fakeClient({ membership: 'join' });
    sendStateEvent.mockRejectedValue(new Error('M_FORBIDDEN'));
    expect(await new Api(client).markAsBot('!r:hs')).toBe(false);
  });
});
