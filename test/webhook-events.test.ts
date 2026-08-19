import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WebhookEventType,
  deliverWebhookEvent,
  handleWebhookEventRequest,
  signWebhookBody,
  verifyWebhookSignature,
} from '../src/webhook/events.js';

/** A raw Ed25519 seed/public key pair, in the hex form the API uses. */
const keyPair = (): { privateKey: string; publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    // The last 32 bytes of each DER blob are the raw key material.
    privateKey: pkcs8.subarray(pkcs8.length - 32).toString('hex'),
    publicKey: spki.subarray(spki.length - 32).toString('hex'),
  };
};

describe('webhook event signatures', () => {
  it('verifies a signature it produced', () => {
    const { privateKey, publicKey } = keyPair();
    const body = JSON.stringify({ type: 0 });
    const timestamp = '1700000000';
    const signature = signWebhookBody({ privateKey, timestamp, body });
    expect(verifyWebhookSignature({ publicKey, signature, timestamp, body })).toBe(true);
  });

  it('rejects a body that changed after signing', () => {
    const { privateKey, publicKey } = keyPair();
    const timestamp = '1700000000';
    const signature = signWebhookBody({ privateKey, timestamp, body: '{"type":0}' });
    expect(
      verifyWebhookSignature({ publicKey, signature, timestamp, body: '{"type":1}' })
    ).toBe(false);
  });

  it('rejects a signature bound to a different timestamp', () => {
    const { privateKey, publicKey } = keyPair();
    const body = '{"type":0}';
    const signature = signWebhookBody({ privateKey, timestamp: '1700000000', body });
    expect(
      verifyWebhookSignature({ publicKey, signature, timestamp: '1700000001', body })
    ).toBe(false);
  });

  it('rejects garbage without throwing', () => {
    const { publicKey } = keyPair();
    expect(
      verifyWebhookSignature({ publicKey, signature: 'zz', timestamp: '1', body: 'x' })
    ).toBe(false);
    expect(
      verifyWebhookSignature({ publicKey, signature: undefined, timestamp: '1', body: 'x' })
    ).toBe(false);
    expect(verifyWebhookSignature({ publicKey: 'nothex', signature: 'ab', timestamp: '1', body: 'x' })).toBe(
      false
    );
  });
});

describe('webhook event receiver', () => {
  it('answers a valid PING with 204', () => {
    const { privateKey, publicKey } = keyPair();
    const body = JSON.stringify({ version: 1, application_id: '1', type: WebhookEventType.Ping });
    const timestamp = '1700000000';
    const signature = signWebhookBody({ privateKey, timestamp, body });
    const result = handleWebhookEventRequest({ publicKey, signature, timestamp, body });
    expect(result.status).toBe(204);
    expect(result.status === 204 && result.ping).toBe(true);
  });

  it('answers 401 before parsing anything', () => {
    const { publicKey } = keyPair();
    const result = handleWebhookEventRequest({
      publicKey,
      signature: 'ab'.repeat(32),
      timestamp: '1',
      body: 'not json at all',
    });
    expect(result.status).toBe(401);
  });

  it('hands an event body back once the signature checks out', () => {
    const { privateKey, publicKey } = keyPair();
    const body = JSON.stringify({
      version: 1,
      application_id: '1',
      type: WebhookEventType.Event,
      event: { type: 'ENTITLEMENT_CREATE', timestamp: '2024-10-18T18:41:21.109604', data: { id: '5' } },
    });
    const timestamp = '1700000000';
    const signature = signWebhookBody({ privateKey, timestamp, body });
    const result = handleWebhookEventRequest({ publicKey, signature, timestamp, body });
    expect(result.status === 204 && result.event?.type).toBe('ENTITLEMENT_CREATE');
  });
});

describe('webhook event delivery', () => {
  const payload = {
    version: 1 as const,
    application_id: '1',
    type: WebhookEventType.Event,
    event: { type: 'X', timestamp: '2024-01-01T00:00:00Z' },
  };

  it('signs every attempt and stops on 2xx', async () => {
    const { privateKey, publicKey } = keyPair();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(
        verifyWebhookSignature({
          publicKey,
          signature: headers[SIGNATURE_HEADER],
          timestamp: headers[TIMESTAMP_HEADER],
          body: init.body as string,
        })
      ).toBe(true);
      return new Response(null, { status: 204 });
    });

    const result = await deliverWebhookEvent(payload, {
      url: 'https://app.example/hook',
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ delivered: true, attempts: 1, status: 204 });
  });

  it('gives up immediately on a 4xx, which will not become a 2xx', async () => {
    const { privateKey } = keyPair();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 400 }));
    const result = await deliverWebhookEvent(payload, {
      url: 'https://app.example/hook',
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.delivered).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx with doubling backoff and gives up at the deadline', async () => {
    const { privateKey } = keyPair();
    const delays: number[] = [];
    let clock = 0;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));

    const result = await deliverWebhookEvent(payload, {
      url: 'https://app.example/hook',
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxElapsedMs: 7000,
      initialDelayMs: 1000,
      sleep: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    // 0 -> sleep 1000 -> 1000 -> sleep 2000 -> 3000 -> sleep 4000 -> 7000, which
    // is the deadline exactly, so the next step (8000) is refused.
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(4);
  });

  it('retries a network failure', async () => {
    const { privateKey } = keyPair();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return new Response(null, { status: 204 });
    });
    const result = await deliverWebhookEvent(payload, {
      url: 'https://app.example/hook',
      privateKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result).toMatchObject({ delivered: true, attempts: 2 });
  });
});
