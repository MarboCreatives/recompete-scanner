// The text of every message this application sends.
//
// Kept apart from the sending code so the wording can be read without wading
// through transport, and so a check can assert the promises it makes.
//
// The fifteen-minute claim here must match the interval in the INSERT that
// creates a sign-in token, and the sentence on the page that says a link is on
// its way. All three are the same promise written three times.

export const SIGN_IN_SUBJECT = 'Your sign-in link'

/**
 * The sign-in email.
 *
 * `url` already contains the token; this file never builds it, so there is one
 * place that decides what a link looks like.
 */
export function signInLinkEmail(url: string): { text: string; html: string } {
  const text = [
    'Use this link to sign in to Canadian Recompete Radar.',
    '',
    url,
    '',
    'It works once and expires in 15 minutes.',
    '',
    'If you did not ask for this link, you can ignore this message. Nothing has',
    'been created and no one has been signed in.',
    '',
    'Sent by Canadian Recompete Radar, PO Box 1184, Pembroke, Ontario K8A 6Y6',
    'hello@recompeteradar.ca',
  ].join('\n')

  const html = [
    '<p>Use this link to sign in to Canadian Recompete Radar.</p>',
    `<p><a href="${escapeHtml(url)}">Sign in</a></p>`,
    '<p>It works once and expires in 15 minutes.</p>',
    '<p>If you did not ask for this link, you can ignore this message. Nothing has been created and no one has been signed in.</p>',
    '<hr />',
    '<p>Sent by Canadian Recompete Radar, PO Box 1184, Pembroke, Ontario K8A 6Y6<br />hello@recompeteradar.ca</p>',
  ].join('\n')

  return { text, html }
}

/** Minimal escaping for the one value that reaches the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
