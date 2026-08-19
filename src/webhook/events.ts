/**
 * Webhook Events - the outgoing direction, where Discord POSTs to an app.
 *
 * Both halves are here because both are needed for a round trip to be testable
 * without the network: the SENDER signs and delivers events with the same
 * retry policy Discord documents, and the RECEIVER verifies a signature and
 * answers a PING the way Discord requires before it will accept an endpoint.
 *
 * Ed25519 is used exactly as Discord specifies: the message signed is the raw
 * request body prefixed by the timestamp header, and the signature travels
 * hex-encoded in `X-Signature-Ed25519`.
 */

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-signature-ed25519';
export const TIMESTAMP_HEADER = 'x-signature-timestamp';

/** https://discord.com/developers/docs/events/webhook-events#webhook-types */
export enum WebhookEventType {
  Ping = 0,
  Event = 1,
}

export type WebhookEventBody<T = unknown> = {
  type: string;
  timestamp: string;
  data?: T;
};

export type WebhookEventPayload<T = unknown> = {
  version: 1;
  application_id: string;
  type: WebhookEventType;
  event?: WebhookEventBody<T>;
};

/**
 * A raw 32-byte Ed25519 key is not a format `node:crypto` accepts, so it is
 * wrapped in the fixed SPKI/PKCS#8 prefix for the algorithm.
 *
 * The prefixes are constant for Ed25519 - the DER is entirely determined by the
 * algorithm and the key length - which is what makes this safe rather than a
 * hand-rolled ASN.1 encoder.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const publicKeyFromHex = (hexKey: string) =>
  createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(hexKey, 'hex')]),
    format: 'der',
    type: 'spki',
  });

const privateKeyFromHex = (hexKey: string) =>
  createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(hexKey, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });

/**
 * Verifies a signed request.
 *
 * Never throws: a malformed key, a truncated signature and a wrong signature
 * all have to reach the caller as the same answer, which is 401. Distinguishing
 * them in the response would tell an attacker which part they got wrong.
 */
export function verifyWebhookSignature(params: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: Buffer | string;
}): boolean {
  const { publicKey, signature, timestamp, body } = params;
  if (!signature || !timestamp) return false;
  try {
    const message = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
    ]);
    return cryptoVerify(
      null,
      message,
      publicKeyFromHex(publicKey),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

/** Signs a body the way a sender must, returning the hex signature. */
export function signWebhookBody(params: {
  privateKey: string;
  timestamp: string;
  body: Buffer | string;
}): string {
  const message = Buffer.concat([
    Buffer.from(params.timestamp, 'utf8'),
    typeof params.body === 'string' ? Buffer.from(params.body, 'utf8') : params.body,
  ]);
  return cryptoSign(null, message, privateKeyFromHex(params.privateKey)).toString('hex');
}

export type WebhookEventDeliveryOptions = {
  url: string;
  /** Hex-encoded Ed25519 private key seed (32 bytes). */
  privateKey: string;
  /**
   * Total time to keep retrying, in milliseconds. Discord gives up after ten
   * minutes of exponential backoff, and so does this.
   */
  maxElapsedMs?: number;
  /** First backoff step; each retry doubles it. */
  initialDelayMs?: number;
  /** Per-attempt timeout. Discord expects an ack within 3 seconds. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable so tests do not actually wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type DeliveryResult = {
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Delivers one event, retrying on anything that is not a definitive answer.
 *
 * "Definitive" is the load-bearing word. A 2xx is success and a 4xx means the
 * endpoint understood and refused - retrying either is pointless, and retrying
 * a 4xx for ten minutes turns one bad payload into a small flood. 5xx, network
 * failures and timeouts are the retryable set, because they carry no
 * information about whether the event was accepted.
 */
export async function deliverWebhookEvent(
  payload: WebhookEventPayload,
  options: WebhookEventDeliveryOptions
): Promise<DeliveryResult> {
  const {
    url,
    privateKey,
    maxElapsedMs = 10 * 60 * 1000,
    initialDelayMs = 1000,
    requestTimeoutMs = 3000,
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = Date.now,
  } = options;

  const body = JSON.stringify(payload);
  const started = now();
  let delay = initialDelayMs;
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (;;) {
    attempts += 1;
    // A fresh timestamp per attempt: a receiver is entitled to reject a stale
    // one as replay protection, and reusing the first attempt's timestamp
    // would make every retry look older than the last.
    const timestamp = Math.floor(now() / 1000).toString();
    const signature = signWebhookBody({ privateKey, timestamp, body });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: timestamp,
        },
        body,
        signal: controller.signal,
      });
      lastStatus = response.status;
      if (response.status >= 200 && response.status < 300) {
        return { delivered: true, attempts, status: response.status };
      }
      if (response.status >= 400 && response.status < 500) {
        return { delivered: false, attempts, status: response.status };
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }

    const elapsed = now() - started;
    if (elapsed + delay > maxElapsedMs) {
      return { delivered: false, attempts, status: lastStatus, error: lastError };
    }
    await sleep(delay);
    delay *= 2;
  }
}

export type ReceiverResult =
  | { status: 401; body?: undefined }
  | { status: 400; body?: undefined }
  | { status: 204; body?: undefined; ping: boolean; event?: WebhookEventBody };

/**
 * The receiving side of an endpoint, minus the HTTP server.
 *
 * Returning a decision rather than writing a response keeps it usable from any
 * server - node:http, express, a serverless handler - and testable without one.
 *
 * The order matters and is not negotiable: signature FIRST, parse second.
 * Discord actively probes endpoints with deliberately invalid signatures and
 * removes the URL if one is accepted, so nothing may be parsed, logged or acted
 * on before the signature has been checked.
 */
export function handleWebhookEventRequest(params: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: Buffer | string;
}): ReceiverResult {
  if (!verifyWebhookSignature(params)) return { status: 401 };

  let parsed: WebhookEventPayload;
  try {
    parsed = JSON.parse(
      typeof params.body === 'string' ? params.body : params.body.toString('utf8')
    ) as WebhookEventPayload;
  } catch {
    return { status: 400 };
  }

  if (parsed.type === WebhookEventType.Ping) return { status: 204, ping: true };
  return { status: 204, ping: false, event: parsed.event };
}
