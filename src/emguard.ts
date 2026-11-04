// What Execution Market refuses to publish by its own public rules, checked before the buyer pays, on the exact title
// and instructions Flat Fee would send. Read from UltravioletaDAO/execution-market at a675eb6: the title's sell intent
// (mcp_server/services/sell_intent.py, on in production) and credentials in the task text
// (mcp_server/services/secret_guard.py, on by default). Both answer 422 `retryable: false` at publish.
//
// EM's patterns are Python's `re`, which is not JavaScript's: its \s also takes U+001C-U+001F and U+0085, IGNORECASE
// also folds U+0130 and U+0131 into "i", U+017F into "s" and U+212A into "k" (all measured with CPython's `re`), and
// its \b is Unicode-aware. The ports below take Python's whitespace and folds as they are, and an ASCII word boundary:
// they match wherever EM's patterns match, and in a few more places (a letter like "\u00e9" glued to "for sale"), where the
// buyer only has to rephrase. Execution Market's content review (services/content_review.py) cannot be read this way:
// its rules are not in its repository, so a task it blocks still ends unpublished.

/** Python's \s on str, as CPython's `re` matches it */
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** no ASCII word character on that side: wherever Python's Unicode \b holds there, this holds too */
const B0 = "(?<![A-Za-z0-9_])";
const B1 = "(?![A-Za-z0-9_])";

/** what Python's IGNORECASE matches as an ASCII letter, as that letter, lowercase; everything else as it is */
const FOLDS: Record<string, string> = { "\u0130": "i", "\u0131": "i", "\u017f": "s", "\u212a": "k" };
const fold = (s: string) => s.replace(/[A-Z\u0130\u0131\u017f\u212a]/g, (c) => FOLDS[c] ?? c.toLowerCase());

// sell_intent.py `_SELL_INTENT_RE`, matched on the folded title
const SELL = new RegExp(
  `^[${WS}]*(?:vendo|vendemos|ofrezco|ofrecemos|se[${WS}]+vende|en[${WS}]+venta)${B1}` +
    `|${B0}(?:for[${WS}]+sale|selling[${WS}]+(?:my|our)|we[${WS}]+sell)${B1}`,
);

// secret_guard.py `_SECRET_PATTERNS`: the IGNORECASE ones on the folded text, the others on the text as sent
const SECRETS: { name: string; rx: RegExp; folded: boolean }[] = [
  { name: "aws_presigned_url", rx: /[?&](?:awsaccesskeyid|x-amz-credential|x-amz-signature)=/, folded: true },
  { name: "aws_session_token", rx: /[?&]x-amz-security-token=/, folded: true },
  { name: "aws_access_key_id", rx: new RegExp(`${B0}(?:AKIA|ASIA)[0-9A-Z]{16}${B1}`), folded: false },
  { name: "gcp_signed_url", rx: /[?&](?:googleaccessid|x-goog-signature|x-goog-credential)=/, folded: true },
  { name: "azure_sas_token", rx: new RegExp(`[?&]sv=[^&${WS}]+(?:&[^&${WS}]+)*&sig=`), folded: true },
  { name: "private_key_pem", rx: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/, folded: false },
];

/** text a task on Execution Market cannot carry at all, whatever its rules say; null when it can */
export function unpublishableText(text: string): string | null {
  // a lone surrogate is not text: EM's validator refuses it (422 string_unicode)
  if (!(text as string & { isWellFormed(): boolean }).isWellFormed()) return "the request is not valid Unicode text";
  if (text.includes("\u0000")) return "the request holds a NUL character, which Execution Market cannot store";
  return null;
}

/** why Execution Market would refuse to publish a task with this title and these instructions, or null */
export function emPublishRefusal(title: string, instructions: string): string | null {
  const sale = SELL.exec(fold(title));
  if (sale) {
    return `Execution Market publishes requests for work, not sale listings, and the task's title would read as one (matched "${sale[0].trim()}"): rephrase the request`;
  }
  for (const text of [title, instructions]) {
    const folded = fold(text);
    const hit = SECRETS.find((p) => p.rx.test(p.folded ? folded : text));
    // the category only: what matched may be a live credential, and it is never repeated
    if (hit) return `the request holds what looks like a cloud credential or a pre-signed URL (${hit.name}), which Execution Market refuses to publish: remove it`;
  }
  return null;
}
