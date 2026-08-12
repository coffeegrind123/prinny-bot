/**
 * Thread-aware Matrix send helpers.
 *
 * When a conversation is a thread, every NEW message must carry an `m.thread`
 * relation so it lands in the thread rather than the room timeline. Edits use
 * `m.replace` and inherit thread membership from the event they replace, so
 * the thread relation is only attached to fresh sends.
 */

import type { MatrixClient } from 'matrix-js-sdk'
import { stripHtml } from './format.js'

/**
 * Build the `m.relates_to` for a new in-thread message. Returns undefined for
 * room-level (non-threaded) conversations so the message goes to the timeline.
 * `replyTo` is the rich-reply fallback target (latest known event in-thread).
 */
export function buildThreadRelation(
  threadRootId: string | undefined,
  replyTo: string | undefined,
): Record<string, unknown> | undefined {
  if (!threadRootId) return undefined
  return {
    rel_type: 'm.thread',
    event_id: threadRootId,
    is_falling_back: true,
    'm.in_reply_to': { event_id: replyTo ?? threadRootId },
  }
}

/** Send a plain-text message, threaded when threadRootId is set. */
export async function sendThreadedText(
  client: MatrixClient,
  roomId: string,
  text: string,
  threadRootId?: string,
  replyTo?: string,
): Promise<string | null> {
  const rel = buildThreadRelation(threadRootId, replyTo)
  const content: Record<string, unknown> = { msgtype: 'm.text', body: text }
  if (rel) content['m.relates_to'] = rel
  try {
    const res = await client.sendMessage(roomId, content as never)
    return res.event_id ?? null
  } catch {
    return null
  }
}

/** Send an HTML message (with plain-text fallback), threaded when set. */
export async function sendThreadedHtml(
  client: MatrixClient,
  roomId: string,
  html: string,
  body: string,
  threadRootId?: string,
  replyTo?: string,
): Promise<string | null> {
  const rel = buildThreadRelation(threadRootId, replyTo)
  const content: Record<string, unknown> = {
    msgtype: 'm.text',
    body: body || stripHtml(html),
    format: 'org.matrix.custom.html',
    formatted_body: html,
  }
  if (rel) content['m.relates_to'] = rel
  try {
    const res = await client.sendMessage(roomId, content as never)
    return res.event_id ?? null
  } catch {
    // Fallback: plain text (still threaded)
    return sendThreadedText(client, roomId, body || stripHtml(html), threadRootId, replyTo)
  }
}
