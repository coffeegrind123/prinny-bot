/**
 * GitHub-compatible Execute Webhook: `POST /webhooks/{id}/{token}/github`.
 *
 * GitHub posts its own event payload with the event name in `X-GitHub-Event`,
 * and Discord renders each supported event as an embed. The supported set is
 * the one Discord documents: commit_comment, create, delete, fork,
 * issue_comment, issues, member, public, pull_request, pull_request_review,
 * pull_request_review_comment, push, release, watch, check_run, check_suite,
 * discussion and discussion_comment.
 *
 * Anything else - including `ping`, which GitHub sends when the hook is first
 * saved - produces no message. That is deliberate and matches Discord: a
 * repository with "send me everything" configured would otherwise fill a room
 * with events nobody chose.
 */

import type { DiscordEmbed, ExecuteWebhookBody } from './types.js';

type Json = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const obj = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null ? (value as Json) : undefined;

const COLOR_OPEN = 0x2cbe4e;
const COLOR_CLOSED = 0xcb2431;
const COLOR_NEUTRAL = 0x6a737d;
const COLOR_MERGED = 0x6f42c1;

/** `owner/repo`, the label every one of these embeds is anchored on. */
const repoName = (payload: Json): string =>
  str(obj(payload.repository)?.full_name) ?? str(obj(payload.repository)?.name) ?? 'repository';

const senderAuthor = (payload: Json): DiscordEmbed['author'] => {
  const sender = obj(payload.sender);
  const login = str(sender?.login);
  if (!login) return undefined;
  const author: NonNullable<DiscordEmbed['author']> = { name: login };
  const url = str(sender?.html_url);
  const avatar = str(sender?.avatar_url);
  if (url) author.url = url;
  if (avatar) author.icon_url = avatar;
  return author;
};

/** Keeps an embed description inside Discord's 4096-character limit. */
const clamp = (text: string | undefined, limit = 1800): string | undefined => {
  if (!text) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

const refName = (ref: string | undefined): string =>
  (ref ?? '').replace(/^refs\/(heads|tags)\//, '');

type Handler = (payload: Json) => DiscordEmbed | undefined;

const handlers: Record<string, Handler> = {
  push: (payload) => {
    const commits = Array.isArray(payload.commits) ? (payload.commits as Json[]) : [];
    if (commits.length === 0) return undefined;
    const branch = refName(str(payload.ref));
    return {
      title: `[${repoName(payload)}:${branch}] ${commits.length} new commit${
        commits.length === 1 ? '' : 's'
      }`,
      url: str(payload.compare),
      description: clamp(
        commits
          .map((commit) => {
            const id = (str(commit.id) ?? '').slice(0, 7);
            const message = (str(commit.message) ?? '').split('\n')[0] ?? '';
            const url = str(commit.url) ?? '';
            return `[\`${id}\`](${url}) ${message}`;
          })
          .join('\n')
      ),
      color: COLOR_NEUTRAL,
      author: senderAuthor(payload),
    };
  },

  issues: (payload) => {
    const issue = obj(payload.issue);
    if (!issue) return undefined;
    const action = str(payload.action) ?? 'updated';
    return {
      title: `[${repoName(payload)}] Issue ${action}: #${String(issue.number)} ${
        str(issue.title) ?? ''
      }`,
      url: str(issue.html_url),
      description: action === 'opened' ? clamp(str(issue.body)) : undefined,
      color: action === 'closed' ? COLOR_CLOSED : COLOR_OPEN,
      author: senderAuthor(payload),
    };
  },

  issue_comment: (payload) => {
    const issue = obj(payload.issue);
    const comment = obj(payload.comment);
    if (!issue || !comment) return undefined;
    return {
      title: `[${repoName(payload)}] New comment on issue #${String(issue.number)}: ${
        str(issue.title) ?? ''
      }`,
      url: str(comment.html_url),
      description: clamp(str(comment.body)),
      color: COLOR_NEUTRAL,
      author: senderAuthor(payload),
    };
  },

  pull_request: (payload) => {
    const pr = obj(payload.pull_request);
    if (!pr) return undefined;
    const action = str(payload.action) ?? 'updated';
    const merged = pr.merged === true;
    return {
      title: `[${repoName(payload)}] Pull request ${merged ? 'merged' : action}: #${String(
        pr.number
      )} ${str(pr.title) ?? ''}`,
      url: str(pr.html_url),
      description: action === 'opened' ? clamp(str(pr.body)) : undefined,
      color: merged ? COLOR_MERGED : action === 'closed' ? COLOR_CLOSED : COLOR_OPEN,
      author: senderAuthor(payload),
    };
  },

  pull_request_review: (payload) => {
    const pr = obj(payload.pull_request);
    const review = obj(payload.review);
    if (!pr || !review) return undefined;
    return {
      title: `[${repoName(payload)}] Pull request review ${
        str(review.state) ?? 'submitted'
      }: #${String(pr.number)} ${str(pr.title) ?? ''}`,
      url: str(review.html_url),
      description: clamp(str(review.body)),
      color: str(review.state) === 'changes_requested' ? COLOR_CLOSED : COLOR_OPEN,
      author: senderAuthor(payload),
    };
  },

  pull_request_review_comment: (payload) => {
    const pr = obj(payload.pull_request);
    const comment = obj(payload.comment);
    if (!pr || !comment) return undefined;
    return {
      title: `[${repoName(payload)}] New review comment on pull request #${String(pr.number)}`,
      url: str(comment.html_url),
      description: clamp(str(comment.body)),
      color: COLOR_NEUTRAL,
      author: senderAuthor(payload),
    };
  },

  commit_comment: (payload) => {
    const comment = obj(payload.comment);
    if (!comment) return undefined;
    return {
      title: `[${repoName(payload)}] New comment on commit ${(str(comment.commit_id) ?? '').slice(
        0,
        7
      )}`,
      url: str(comment.html_url),
      description: clamp(str(comment.body)),
      color: COLOR_NEUTRAL,
      author: senderAuthor(payload),
    };
  },

  create: (payload) => ({
    title: `[${repoName(payload)}] New ${str(payload.ref_type) ?? 'ref'} created: ${
      str(payload.ref) ?? ''
    }`,
    color: COLOR_OPEN,
    author: senderAuthor(payload),
  }),

  delete: (payload) => ({
    title: `[${repoName(payload)}] ${str(payload.ref_type) ?? 'ref'} deleted: ${
      str(payload.ref) ?? ''
    }`,
    color: COLOR_CLOSED,
    author: senderAuthor(payload),
  }),

  fork: (payload) => ({
    title: `[${repoName(payload)}] Forked to ${str(obj(payload.forkee)?.full_name) ?? ''}`,
    url: str(obj(payload.forkee)?.html_url),
    color: COLOR_NEUTRAL,
    author: senderAuthor(payload),
  }),

  member: (payload) => ({
    title: `[${repoName(payload)}] Collaborator ${str(payload.action) ?? 'changed'}: ${
      str(obj(payload.member)?.login) ?? ''
    }`,
    color: COLOR_NEUTRAL,
    author: senderAuthor(payload),
  }),

  public: (payload) => ({
    title: `[${repoName(payload)}] Repository is now public`,
    color: COLOR_OPEN,
    author: senderAuthor(payload),
  }),

  watch: (payload) => ({
    title: `[${repoName(payload)}] New star added`,
    color: COLOR_NEUTRAL,
    author: senderAuthor(payload),
  }),

  release: (payload) => {
    const release = obj(payload.release);
    if (!release) return undefined;
    return {
      title: `[${repoName(payload)}] New release published: ${
        str(release.name) ?? str(release.tag_name) ?? ''
      }`,
      url: str(release.html_url),
      description: clamp(str(release.body)),
      color: COLOR_OPEN,
      author: senderAuthor(payload),
    };
  },

  check_run: (payload) => {
    const run = obj(payload.check_run);
    if (!run) return undefined;
    const conclusion = str(run.conclusion);
    return {
      title: `[${repoName(payload)}] Check run ${str(run.name) ?? ''}: ${
        conclusion ?? str(run.status) ?? ''
      }`,
      url: str(run.html_url),
      color: conclusion === 'success' ? COLOR_OPEN : conclusion ? COLOR_CLOSED : COLOR_NEUTRAL,
      author: senderAuthor(payload),
    };
  },

  check_suite: (payload) => {
    const suite = obj(payload.check_suite);
    if (!suite) return undefined;
    const conclusion = str(suite.conclusion);
    return {
      title: `[${repoName(payload)}] Check suite: ${conclusion ?? str(suite.status) ?? ''}`,
      url: str(suite.url),
      color: conclusion === 'success' ? COLOR_OPEN : conclusion ? COLOR_CLOSED : COLOR_NEUTRAL,
      author: senderAuthor(payload),
    };
  },

  discussion: (payload) => {
    const discussion = obj(payload.discussion);
    if (!discussion) return undefined;
    return {
      title: `[${repoName(payload)}] Discussion ${str(payload.action) ?? ''}: #${String(
        discussion.number
      )} ${str(discussion.title) ?? ''}`,
      url: str(discussion.html_url),
      description: clamp(str(discussion.body)),
      color: COLOR_OPEN,
      author: senderAuthor(payload),
    };
  },

  discussion_comment: (payload) => {
    const discussion = obj(payload.discussion);
    const comment = obj(payload.comment);
    if (!discussion || !comment) return undefined;
    return {
      title: `[${repoName(payload)}] New comment on discussion #${String(discussion.number)}`,
      url: str(comment.html_url),
      description: clamp(str(comment.body)),
      color: COLOR_NEUTRAL,
      author: senderAuthor(payload),
    };
  },
};

/** The events this endpoint renders. `ping` is knowingly not among them. */
export const GITHUB_SUPPORTED_EVENTS = Object.keys(handlers);

/**
 * Returns undefined for an event with nothing to say - an unsupported type, a
 * push with no commits, a malformed payload. The endpoint answers 204 in that
 * case, exactly as it does for a message it did send with `wait=false`.
 */
export function githubToExecuteBody(
  event: string | undefined,
  payload: Json
): ExecuteWebhookBody | undefined {
  if (!event) return undefined;
  const handler = handlers[event];
  if (!handler) return undefined;
  const embed = handler(payload);
  if (!embed) return undefined;
  return { embeds: [embed] };
}
