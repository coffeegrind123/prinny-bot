/**
 * Markdown → Matrix HTML conversion via the `marked` parser.
 *
 * Matrix supports `org.matrix.custom.html` format with a subset of HTML tags:
 *   <b>, <i>, <u>, <s>, <del>, <code>, <pre>, <blockquote>,
 *   <a href>, <font color>, <h1>-<h6>, <p>, <ul>, <ol>, <li>,
 *   <br>, <hr>, <em>, <strong>, <sup>, <sub>
 *
 * Plain text body is always sent alongside formatted_body as fallback.
 */

import { Marked } from 'marked'

// Isolated marked instance, not the shared `marked` singleton.
//
// This is a library: the app embedding it may well configure `marked` for its
// own rendering, and that configuration is global. openclaude hit exactly this
// — its CLI renderer disables the strikethrough tokenizer, which silently
// broke ~~strike~~ in every Matrix message the bot sent, but only once the CLI
// had rendered something first. An own instance keeps our output deterministic
// regardless of what the host does.
const markedMatrix = new Marked({ gfm: true })

const MAX_CHUNK = 3800
const MAX_TOTAL = 50_000

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

type AnyToken = Record<string, unknown> & { type?: string }

function renderTokens(tokens: AnyToken[] | undefined): string {
  if (!tokens) return ''
  return tokens.map(t => renderToken(t)).join('')
}

function renderToken(tok: AnyToken): string {
  switch (tok.type) {
    case 'paragraph':
      return `<p>${renderTokens(tok.tokens as AnyToken[] | undefined)}</p>\n`

    case 'text':
      if (tok.tokens)
        return renderTokens(tok.tokens as AnyToken[] | undefined)
      return escape((tok.text as string) ?? '')

    case 'strong':
      return `<strong>${renderTokens(tok.tokens as AnyToken[] | undefined)}</strong>`

    case 'em':
      return `<em>${renderTokens(tok.tokens as AnyToken[] | undefined)}</em>`

    case 'del':
      return `<del>${renderTokens(tok.tokens as AnyToken[] | undefined)}</del>`

    case 'codespan':
      return `<code>${escape((tok.text as string) ?? '')}</code>`

    case 'code': {
      const body = escape((tok.text as string) ?? '')
      const lang = (tok.lang as string | undefined)?.replace(
        /[^a-zA-Z0-9_+-]/g,
        '',
      )
      return lang
        ? `<pre><code class="language-${lang}">${body}</code></pre>\n`
        : `<pre><code>${body}</code></pre>\n`
    }

    case 'link': {
      const href = String(tok.href ?? '').replace(/"/g, '&quot;')
      return `<a href="${href}">${renderTokens(tok.tokens as AnyToken[] | undefined)}</a>`
    }

    case 'br':
    case 'space':
      return '\n'

    case 'hr':
      return '<hr>\n'

    case 'list': {
      const items = (tok.items as Array<{ tokens?: AnyToken[] }>) ?? []
      const ordered = !!tok.ordered
      const start = (tok.start as number) ?? 1
      const tag = ordered ? 'ol' : 'ul'
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : ''
      return (
        `<${tag}${startAttr}>\n` +
        items
          .map(it => {
            const content = renderTokens(it.tokens)
              .replace(/^<p>/, '')
              .replace(/<\/p>\n?$/, '')
            return `<li>${content}</li>`
          })
          .join('\n') +
        `\n</${tag}>\n`
      )
    }

    case 'list_item':
      return renderTokens(tok.tokens as AnyToken[] | undefined)

    case 'blockquote':
      return `<blockquote>${renderTokens(tok.tokens as AnyToken[] | undefined).trim()}</blockquote>\n`

    case 'heading': {
      const depth = Math.min((tok.depth as number) ?? 1, 6)
      return `<h${depth}>${renderTokens(tok.tokens as AnyToken[] | undefined)}</h${depth}>\n`
    }

    case 'image': {
      const text = (tok.text as string) ?? ''
      const href = (tok.href as string) ?? ''
      return escape(text || href)
    }

    case 'html':
      return escape((tok.text as string) ?? '')

    case 'escape':
      return escape((tok.text as string) ?? '')

    default:
      if (tok.tokens)
        return renderTokens(tok.tokens as AnyToken[] | undefined)
      return escape((tok.raw as string) ?? (tok.text as string) ?? '')
  }
}

/**
 * Convert markdown-flavoured text to Matrix-compatible HTML.
 */
export function markdownToMatrixHtml(input: string): string {
  if (!input) return ''
  const cleaned = input
    .replace(/^[ \t]*[*_~][ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
  const tokens = markedMatrix.lexer(cleaned) as AnyToken[]
  return renderTokens(tokens).trim()
}

/**
 * Strip HTML tags down to plain text for the `body` field.
 */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/**
 * Split text into ≤MAX_CHUNK pieces. Prefers paragraph breaks,
 * then single newlines, then spaces, then hard cut.
 */
export function chunkMatrixText(text: string, limit: number = MAX_CHUNK): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    const cap = remaining.slice(0, limit)
    let cut = cap.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = cap.lastIndexOf('\n')
    if (cut < limit / 2) cut = cap.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit

    // Auto-close <pre>/<code> blocks if cut mid-block
    let piece = remaining.slice(0, cut)
    const openPre = (piece.match(/<pre[^>]*>/g) ?? []).length
    const closePre = (piece.match(/<\/pre>/g) ?? []).length
    if (openPre > closePre) {
      const preTag = piece.match(/<pre[^>]*>/g)?.pop() ?? '<pre>'
      const openCode = (piece.match(/<code[^>]*>/g) ?? []).length
      const closeCode = (piece.match(/<\/code>/g) ?? []).length
      if (openCode > closeCode) piece += '</code>'
      piece += '</pre>'
      remaining = preTag + remaining.slice(cut).trimStart()
    } else {
      remaining = remaining.slice(cut).trimStart()
    }
    chunks.push(piece)
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

/**
 * End-to-end: markdown → Matrix HTML chunks, each with plain text body.
 */
export function formatForMatrix(text: string): Array<{
  html: string
  body: string
}> {
  const html = markdownToMatrixHtml(text)
  const body = stripHtml(html)
  if (html.length <= MAX_CHUNK) return [{ html, body }]

  // For long messages, chunk the HTML and derive body per chunk
  const htmlChunks = chunkMatrixText(html)
  return htmlChunks.map(h => ({ html: h, body: stripHtml(h) }))
}

/** Validate total message size. */
export function validateSize(text: string): { ok: true } | { ok: false; reason: string } {
  if (text.length > MAX_TOTAL) {
    return {
      ok: false,
      reason: `Message too long (${text.length} chars). Maximum is ${MAX_TOTAL} chars.`,
    }
  }
  return { ok: true }
}
