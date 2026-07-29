import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewPageCss,
  reviewPageHtml,
  reviewPageScript,
} from "../dist/review/reviewPage.js";

test("review composer is a static, accessible, same-origin document", () => {
  const html = reviewPageHtml();

  assert.match(html, /^<!doctype html>/u);
  assert.match(html, /<link rel="stylesheet" href="\.\/review\.css">/u);
  assert.match(html, /<script src="\.\/review\.js" defer><\/script>/u);
  assert.match(html, /<form id="composer" novalidate>/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /role="alert"/u);
  assert.match(html, /class="skip-link"/u);
  assert.match(html, /label class="visually-hidden" for="recipient-e164"/u);
  assert.match(html, /label class="visually-hidden" for="recipient-group"/u);
  assert.match(html, /label for="message-text"/u);
  assert.match(html, /label class="text-button" for="attachment-input"/u);
  assert.doesNotMatch(html, /Nothing sends until you click Send/u);
  assert.doesNotMatch(html, /Load preview|preview-consent|public IP address/u);
  assert.doesNotMatch(html, /Edit the draft until it feels right/u);
  assert.match(html, /Invisible direction controls found/u);
  assert.match(html, /id="bidi-preview"/u);
  assert.match(html, /id="sending-view" role="status" aria-live="polite" hidden/u);
  assert.match(html, /class="spinner" aria-hidden="true"/u);
  assert.match(html, /id="receipt-view"/u);
  assert.match(html, /id="receipt-text"/u);

  assert.doesNotMatch(html, /<style\b/u);
  assert.doesNotMatch(html, /<script(?! src=)/u);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/iu);
  assert.doesNotMatch(html, /https?:\/\//iu);
  assert.doesNotMatch(html, /\{\{[^}]+\}\}|<%|\$\{/u);
});

test("review composer keeps only the compact single-column review surface", () => {
  const html = reviewPageHtml();
  const css = reviewPageCss();

  assert.match(html, /<h1 class="visually-hidden" id="page-title">Review before sending<\/h1>/u);
  assert.doesNotMatch(html, /Review message/u);
  assert.match(html, /<textarea id="message-text" rows="4"/u);
  assert.match(html, /id="attachment-action">＋ Add attachment/u);
  assert.doesNotMatch(html, /compose-heading|attachment-block|empty-attachment|No attachment/u);
  assert.match(css, /\.shell \{ width: min\(640px, 100%\)/u);
  assert.match(css, /textarea \{[^}]*min-height: 108px/u);
  for (const removed of [
    "Make it sound like you",
    "Final check",
    "Delivery",
    "Human approval required",
    "On this device",
    "step-number",
    "review-rail",
    "summary-card",
  ]) assert.equal(html.includes(removed), false, removed);
});

test("review composer moves the fragment secret out of browser history", () => {
  const script = reviewPageScript();

  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /new URLSearchParams\(location\.hash\.slice\(1\)\)\.get\("action"\)/u);
  assert.match(script, /sessionStorage\.setItem\(storageKey, fragmentToken\)/u);
  assert.match(script, /history\.replaceState\(null, "", location\.pathname \+ location\.search\)/u);
  assert.match(script, /"x-safe-whatsapp-action": actionToken/u);
  assert.doesNotMatch(script, /console\.|localStorage/u);
});

test("review composer only renders untrusted values through safe DOM properties", () => {
  const script = reviewPageScript();

  assert.match(script, /\.textContent =/u);
  assert.match(script, /\.value =/u);
  assert.match(script, /document\.createElement\("option"\)/u);
  assert.match(script, /url\.origin === location\.origin/u);
  assert.match(script, /url\.pathname\.startsWith\(location\.pathname\)/u);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function/u);
  assert.doesNotMatch(script, /\.src\s*=\s*(?:state|media|preview|group)/u);
});

test("review composer implements editable recipient, reply, and media controls", () => {
  const script = reviewPageScript();

  assert.match(script, /recipientMode: mode/u);
  assert.match(script, /\^\\\+\[1-9\]\\d\{6,14\}\$/u);
  assert.match(script, /clearReplyForRecipientEdit/u);
  assert.match(script, /replyToMessageId: activeReplyId/u);
  assert.match(script, /request\("\.\/attachment", \{ method: "PUT"/u);
  assert.match(script, /"x-safe-file-name": encodeURIComponent\(file\.name\)/u);
  assert.match(script, /body: file/u);
  assert.match(script, /method: "DELETE"/u);
  assert.match(script, /media\.kind === "audio"/u);
  assert.match(script, /do not support captions/u);

  assert.match(script, /removedPreviewUrl = firstHttpUrl\(nodes\.text\.value\)/u);
  assert.match(script, /linkPreviewId: preview \? preview\.id : undefined/u);
  assert.match(script, /attachmentId: state\.media \? state\.media\.id : null/u);
});

test("emoji helper delegates to the system picker without bundling emoji", () => {
  const html = reviewPageHtml();
  const script = reviewPageScript();
  const css = reviewPageCss();

  assert.match(html, /id="emoji-button" type="button" aria-label="Focus the message field for emoji input">Emoji<\/button>/u);
  assert.doesNotMatch(html, /emoji-picker|data-emoji=|Choose an emoji/u);
  assert.match(script, /const mac = \/Mac\/iu\.test\(platform\)/u);
  assert.match(script, /mac \? "Emoji · Fn-E" : "Emoji"/u);
  assert.match(script, /press Fn-E or Control-Command-Space/u);
  assert.match(script, /nodes\.emojiToggle\.addEventListener\("click", \(\) => nodes\.text\.focus\(\)\)/u);
  assert.match(script, /nodes\.emojiToggle\.disabled = nodes\.text\.disabled/u);
  assert.doesNotMatch(script, /insertEmoji|setRangeText|emojiOptions|emojiPicker/u);
  assert.match(css, /\.emoji-button \{[^}]*min-height: 29px/u);
  assert.doesNotMatch(css, /\.emoji-picker/u);
});

test("link preview loads automatically only for drafts without attachments", () => {
  const html = reviewPageHtml();
  const script = reviewPageScript();
  const previewPosts = script.match(/jsonMutation\("\.\/preview", "POST", \{ url \}\)/gu) || [];
  const loaderStart = script.indexOf("async function loadPreview()");
  const loaderEnd = script.indexOf("async function uploadAttachment", loaderStart);
  const postIndex = script.indexOf('jsonMutation("./preview", "POST", { url })');

  assert.doesNotMatch(html, /load-preview|preview-consent/u);
  assert.doesNotMatch(script, /nodes\.loadPreview|previewConsent/u);
  assert.match(script, /nodes\.text\.addEventListener\("input", \(\) => \{ updateCount\(\); updatePreviewOffer\(\); \}\)/u);
  assert.equal(previewPosts.length, 1);
  assert.ok(postIndex > loaderStart && postIndex < loaderEnd, "preview POST stays inside the automatic loader");
  assert.match(script, /function previewPending\(\)/u);
  assert.match(script, /state\.state === "open" && !state\.media/u);
  assert.match(script, /previewTimer = setTimeout\(loadPreview, delay\)/u);
  assert.match(script, /schedulePreview\(hydrate \? 0 : 350\)/u);
  assert.match(script, /schedulePreview\(450\)/u);
  assert.match(script, /clearTimeout\(previewTimer\); removedPreviewUrl = firstHttpUrl/u);
  assert.match(script, /function firstHttpUrl\(value\).*www/u);
  assert.match(script, /function previewRequestUrl\(value\).*"https:\/\/" \+ value/u);
});

test("link preview explains loading and exposes a manual retry after failure", () => {
  const html = reviewPageHtml();
  const css = reviewPageCss();
  const script = reviewPageScript();
  const loaderStart = script.indexOf("async function loadPreview()");
  const loaderEnd = script.indexOf("async function uploadAttachment", loaderStart);
  const loader = script.slice(loaderStart, loaderEnd);

  assert.match(html, /id="link-card" aria-labelledby="link-title" aria-live="polite" aria-busy="false" hidden/u);
  assert.match(html, /class="link-spinner" id="link-spinner" aria-hidden="true" hidden/u);
  assert.match(html, /id="retry-link" type="button" hidden>Retry preview<\/button>/u);
  assert.match(css, /\.link-spinner \{[^}]*animation: spin \.8s linear infinite/u);
  assert.match(css, /\.link-card\[data-state="unavailable"\]/u);

  assert.match(script, /nodes\.linkCard\.setAttribute\("aria-busy", mode === "loading" \? "true" : "false"\)/u);
  assert.match(script, /nodes\.linkTitle\.textContent = "Loading preview…"/u);
  assert.match(script, /nodes\.linkTitle\.textContent = "Preview unavailable"/u);
  assert.match(script, /Retry, or send without one\./u);
  assert.match(script, /url !== previewFailureUrl && !activePreview\(\)/u);
  assert.match(loader, /previewLoadingUrl = url/u);
  assert.match(loader, /previewFailureUrl = url; previewFailureCode = error/u);
  assert.doesNotMatch(loader, /removedPreviewUrl = url/u);
  assert.match(script, /function retryPreview\(\).*previewFailureUrl = ""; previewFailureCode = "";.*schedulePreview\(0\)/u);
  assert.match(script, /nodes\.retryLink\.addEventListener\("click", retryPreview\)/u);
  assert.match(script, /removedPreviewUrl = firstHttpUrl\(nodes\.text\.value\); previewFailureUrl = ""/u);
});

test("review composer exposes bidi controls and escapes them in media filenames", () => {
  const script = reviewPageScript();

  assert.match(script, /\[\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\]\/gu/u);
  assert.match(script, /"⟦U\+" \+ character\.codePointAt\(0\).*\+ "⟧"/u);
  assert.match(script, /nodes\.bidiPreview\.textContent = changed \? exposed : ""/u);
  assert.match(script, /nodes\.mediaName\.textContent = typeof media\.fileName === "string" \? exposeBidiControls\(media\.fileName\)/u);
  assert.doesNotMatch(script, /nodes\.mediaName\.innerHTML/u);
});

test("review composer locks permanently after send begins and polls terminal state", () => {
  const script = reviewPageScript();
  const validatingIndex = script.indexOf('state.state = "validating"');
  const sendIndex = script.indexOf('jsonMutation("./send", "POST", body)');

  assert.match(script, /jsonMutation\("\.\/send", "POST", body\)/u);
  assert.ok(validatingIndex > 0 && validatingIndex < sendIndex, "local validating state is set before POST");
  assert.match(script, /submissionStarted = true; submitting = true; state\.state = "validating"; setPhase\("validating"\); renderStateViews\(\)/u);
  assert.ok(script.indexOf("renderStateViews(); renderControls();", validatingIndex) < sendIndex, "loader renders before POST");
  assert.match(script, /result\.response\.status !== 202/u);
  assert.match(script, /schedulePoll\(300\)/u);
  assert.match(script, /submissionStatusUnknown = true/u);
  assert.match(script, /submissionStarted && reportedPhase === "open"/u);
  assert.match(script, /Object\.assign\(\{\}, next, \{ state: "validating" \}\)/u);
  assert.doesNotMatch(script, /state\.state = "open"/u);
  assert.match(script, /We are checking whether WhatsApp accepted this send\. Do not retry yet/u);
  assert.match(script, /error\.responseReceived = true/u);
  assert.match(script, /if \(error && error\.responseReceived\) \{ submissionStarted = false; submitting = false; submissionStatusUnknown = false; await refresh\(false\)/u);
  assert.match(script, /Review the refreshed file before sending/u);
  assert.match(script, /jsonMutation\("\.\/cancel", "POST", \{\}\)/u);
  assert.match(script, /new Set\(\["sent", "failed", "uncertain", "cancelled", "expired"\]\)/u);
  assert.match(script, /if \(!state \|\| state\.state !== "open" \|\| submitting\) return/u);
  assert.match(script, /Delivery could not be confirmed/u);
});

test("sending and terminal views render an exact capability-free receipt", () => {
  const script = reviewPageScript();

  assert.match(script, /nodes\.app\.setAttribute\("aria-busy", inProgress \? "true" : "false"\)/u);
  assert.match(script, /nodes\.editor\.hidden = phase !== "open"/u);
  assert.match(script, /nodes\.sendingView\.hidden = !inProgress/u);
  assert.match(script, /nodes\.receiptView\.hidden = !done/u);
  assert.match(script, /nodes\.receiptTo\.textContent = typeof summary\.recipientLabel === "string"/u);
  assert.match(script, /nodes\.receiptText\.textContent = exposeBidiControls\(text\)/u);
  assert.match(script, /summary\.attachment/u);
  assert.match(script, /summary\.linkPreview/u);
  assert.match(script, /sessionStorage\.removeItem\(storageKey\)/u);
  assert.match(script, /if \(terminal\.has\(state\.state\)\) forgetActionToken\(\)/u);
  assert.doesNotMatch(script, /receiptText\.innerHTML|receiptTo\.innerHTML|whatsappMessageId|Message ID/u);
});

test("review composer styling follows the warm Bliss visual system responsively", () => {
  const css = reviewPageCss();

  assert.match(css, /--paper: #f8f3ea/u);
  assert.match(css, /--ink: #221f1b/u);
  assert.match(css, /--muted: #6e6457/u);
  assert.match(css, /--accent: #d08a35/u);
  assert.match(css, /Inter, ui-sans-serif/u);
  assert.match(css, /backdrop-filter: blur\(18px\)/u);
  assert.match(css, /@keyframes spin/u);
  assert.match(css, /animation: spin \.8s linear infinite/u);
  assert.match(css, /\.receipt-message pre[^}]+white-space: pre-wrap/u);
  assert.match(css, /unicode-bidi: plaintext/u);
  assert.match(css, /radial-gradient/u);
  assert.match(css, /@media \(max-width: 590px\)/u);
  assert.match(css, /env\(safe-area-inset-bottom\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /animation: none !important/u);
  assert.match(css, /@media \(prefers-contrast: more\)/u);
  assert.match(css, /:focus-visible/u);
  assert.doesNotMatch(css, /@import|url\(["']?https?:/iu);
});
