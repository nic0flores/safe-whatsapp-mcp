// Agent context note: Serves the static, self-contained human review composer UI. Tests: test/review-page.test.mjs plus browser visual QA. Keep user data out of HTML, use DOM-safe assignments, auto-load only the first URL in text-only drafts, keep failures user-retryable, and keep rendered assets same-origin.
export function reviewPageHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Safe WhatsApp</title>
  <link rel="stylesheet" href="./review.css">
  <script src="./review.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#message-text">Skip to message</a>
  <div class="atmosphere atmosphere-one" aria-hidden="true"></div>
  <div class="atmosphere atmosphere-two" aria-hidden="true"></div>

  <main class="shell" id="app" data-state="open" aria-busy="false">
    <header class="topbar">
      <a class="brand" href="#composer" aria-label="Safe WhatsApp message review">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span><strong>Safe WhatsApp</strong><small>by Bliss AI</small></span>
      </a>
      <div class="header-status">
        <span class="expiry-inline"><span>Closes in</span><strong id="countdown">—</strong></span>
        <div class="state-pill" id="state-pill" role="status" aria-live="polite"><span></span><b>Loading</b></div>
      </div>
    </header>

    <form id="composer" novalidate>
      <section class="editor-view" id="editor-view" aria-labelledby="page-title">
        <h1 class="visually-hidden" id="page-title">Review before sending</h1>
        <p class="sender-line">From <strong id="from-label">Loading…</strong></p>

        <fieldset class="recipient-block">
          <legend class="visually-hidden">Recipient</legend>
          <div class="field-row">
            <span class="field-title">To</span>
            <div class="mode-switch" aria-label="Recipient type">
              <label><input id="mode-direct" type="radio" name="recipient-mode" value="direct"><span>Phone</span></label>
              <label><input id="mode-group" type="radio" name="recipient-mode" value="group"><span>Group</span></label>
            </div>
          </div>
          <div id="direct-fields">
            <label class="visually-hidden" for="recipient-e164">Phone number in international format</label>
            <input id="recipient-e164" class="route-input" type="tel" inputmode="tel" autocomplete="off" spellcheck="false" placeholder="+91 98765 43210" aria-describedby="recipient-help">
          </div>
          <div id="group-fields" hidden>
            <label class="visually-hidden" for="recipient-group">WhatsApp group</label>
            <select id="recipient-group" class="route-input"><option value="">Choose an existing group</option></select>
          </div>
          <small id="recipient-help">Use a full number beginning with +</small>
        </fieldset>

        <div class="reply-card" id="reply-card" hidden>
          <span class="reply-line" aria-hidden="true"></span>
          <div><span>Replying to</span><p id="reply-label"></p></div>
          <button class="icon-button" id="remove-reply" type="button" aria-label="Remove reply context">×</button>
        </div>

        <div class="message-block">
          <div class="field-row">
            <label for="message-text"><strong id="message-label">Message</strong></label>
            <output id="character-count" for="message-text">0 / 4,096</output>
          </div>
          <textarea id="message-text" rows="4" maxlength="4096" placeholder="Write your message…" aria-describedby="message-help bidi-warning"></textarea>
          <p class="field-help" id="message-help" hidden></p>
          <div class="bidi-warning" id="bidi-warning" role="status" hidden>
            <span aria-hidden="true">!</span><div><strong>Invisible direction controls found</strong><p>Review the exact text below. Each invisible control is shown by its Unicode name.</p><code id="bidi-preview"></code></div>
          </div>
        </div>

        <div class="composer-tools">
          <button class="text-button emoji-button" id="emoji-button" type="button" aria-label="Focus the message field for emoji input">Emoji</button>
          <label class="text-button" for="attachment-input" id="attachment-action">＋ Add attachment</label>
          <input class="visually-hidden" id="attachment-input" type="file">
        </div>
        <div class="media-card" id="media-card" hidden>
          <div class="media-stage">
            <img id="media-image" alt="Attachment preview" hidden>
            <video id="media-video" controls preload="metadata" hidden></video>
            <audio id="media-audio" controls preload="metadata" hidden></audio>
            <div class="document-preview" id="media-document" hidden><span aria-hidden="true">DOC</span><small>Document ready</small></div>
          </div>
          <div class="media-meta"><div><strong id="media-name"></strong><small id="media-detail"></small></div><button class="icon-button" id="remove-attachment" type="button" aria-label="Remove attachment">×</button></div>
        </div>

        <section class="link-card" id="link-card" aria-labelledby="link-title" aria-live="polite" aria-busy="false" hidden>
          <div class="link-thumbnail"><img id="link-image" alt="" hidden><span id="link-fallback" aria-hidden="true">↗</span><span class="link-spinner" id="link-spinner" aria-hidden="true" hidden></span></div>
          <div class="link-copy"><span id="link-host"></span><strong id="link-title"></strong><p id="link-description" hidden></p><button class="link-retry" id="retry-link" type="button" hidden>Retry preview</button></div>
          <button class="icon-button" id="remove-link" type="button" aria-label="Remove link preview">×</button>
        </section>

        <div class="editor-actions">
          <div><button class="secondary-button" id="cancel-button" type="button">Cancel</button><button class="send-button" id="send-button" type="submit"><span>Send on WhatsApp</span><b aria-hidden="true">→</b></button></div>
        </div>
      </section>

      <section class="progress-view" id="sending-view" role="status" aria-live="polite" hidden>
        <span class="spinner" aria-hidden="true"></span>
        <p class="eyebrow">Safe WhatsApp</p>
        <h1 id="progress-title">Sending…</h1>
        <p id="progress-detail">Keep this page open while WhatsApp confirms the send.</p>
        <div class="progress-recipient">To <strong id="progress-to">—</strong></div>
      </section>

      <section class="receipt-view" id="receipt-view" aria-labelledby="result-title" hidden>
        <header class="receipt-heading">
          <span class="result-mark" id="result-mark" aria-hidden="true">✓</span>
          <div><p class="eyebrow" id="result-kicker">Complete</p><h1 id="result-title"></h1><p id="result-detail"></p></div>
        </header>
        <div class="receipt-summary" id="receipt-summary" hidden>
          <dl class="receipt-route">
            <div><dt>From</dt><dd id="receipt-from">—</dd></div>
            <div><dt>To</dt><dd id="receipt-to">—</dd></div>
          </dl>
          <section class="receipt-message" id="receipt-message" hidden>
            <h2 id="receipt-message-label">Message</h2>
            <pre id="receipt-text"></pre>
          </section>
          <dl class="receipt-details">
            <div id="receipt-reply-row" hidden><dt>Replying to</dt><dd id="receipt-reply"></dd></div>
            <div id="receipt-attachment-row" hidden><dt>Attachment</dt><dd id="receipt-attachment"></dd></div>
            <div id="receipt-link-row" hidden><dt>Link preview</dt><dd id="receipt-link"></dd></div>
          </dl>
          <p class="receipt-time" id="receipt-completed" hidden></p>
        </div>
      </section>

      <div class="error-banner" id="error-banner" role="alert" hidden><span aria-hidden="true">!</span><p id="error-text"></p></div>
    </form>
  </main>
</body>
</html>`;
}

export function reviewPageCss(): string {
  return String.raw`:root {
  color-scheme: light; --paper: #f8f3ea; --surface: #fffdf8; --ink: #221f1b; --muted: #6e6457;
  --subtle: #918678; --line: #ded4c6; --soft-line: #e9e1d6; --accent: #d08a35; --accent-deep: #9b5e1f;
  --green: #28775b; --red: #a24d3e; --shadow: 0 24px 70px rgba(62, 47, 31, .13), 0 3px 12px rgba(62, 47, 31, .05);
  font: 16px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--paper); }
body { min-height: 100vh; min-height: 100svh; margin: 0; padding: clamp(12px, 4vw, 48px); color: var(--ink); background:
  radial-gradient(circle at 7% 8%, rgba(234, 175, 99, .22), transparent 28rem),
  radial-gradient(circle at 94% 85%, rgba(91, 154, 126, .15), transparent 30rem),
  linear-gradient(145deg, #fbf7f0, #f3ecdf 72%, #f6f0e6); }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .13; background-image: repeating-radial-gradient(circle at 20% 30%, #5e4f3c 0 .45px, transparent .6px 5px); background-size: 13px 11px; mix-blend-mode: soft-light; }
button, input, select, textarea { font: inherit; }
button, label[for="attachment-input"] { -webkit-tap-highlight-color: transparent; }
button { color: inherit; }
[hidden] { display: none !important; }
.skip-link { position: fixed; z-index: 20; left: 16px; top: 10px; padding: 9px 13px; border-radius: 999px; color: #fff; background: var(--ink); transform: translateY(-160%); transition: transform .18s ease; }
.skip-link:focus { transform: translateY(0); }
.atmosphere { position: fixed; z-index: -1; border-radius: 50%; pointer-events: none; }
.atmosphere-one { width: 19rem; height: 19rem; left: -10rem; top: 30%; border: 1px solid rgba(208, 138, 53, .14); box-shadow: 0 0 0 4rem rgba(208, 138, 53, .022), 0 0 0 8rem rgba(208, 138, 53, .016); }
.atmosphere-two { width: 15rem; height: 15rem; right: -7rem; top: 7%; background: rgba(94, 147, 119, .055); }
.shell { width: min(640px, 100%); margin: 0 auto; overflow: hidden; border: 1px solid rgba(255, 255, 255, .8); border-radius: 24px; background: rgba(255, 252, 246, .82); box-shadow: var(--shadow); backdrop-filter: blur(18px) saturate(1.06); }
.topbar { min-height: 62px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 11px clamp(16px, 4vw, 24px); border-bottom: 1px solid rgba(222, 212, 198, .78); }
.brand { display: inline-flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; }
.brand > span:last-child { display: grid; line-height: 1.1; }
.brand strong { font-size: 13px; letter-spacing: -.02em; }
.brand small { margin-top: 3px; color: var(--muted); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
.brand-mark { width: 34px; height: 34px; position: relative; display: grid; place-items: center; overflow: hidden; border-radius: 11px; background: linear-gradient(145deg, #e6a34f, #bd7526); box-shadow: 0 8px 18px rgba(170, 100, 28, .22); }
.brand-mark i { width: 14px; height: 6px; position: absolute; border: 1.5px solid #fff; border-radius: 50%; transform-origin: 7px 3px; }
.brand-mark i:nth-child(1) { transform: rotate(0deg) translateX(5px); }.brand-mark i:nth-child(2) { transform: rotate(120deg) translateX(5px); }.brand-mark i:nth-child(3) { transform: rotate(240deg) translateX(5px); }
.header-status { display: flex; align-items: center; gap: 12px; }
.expiry-inline { display: grid; justify-items: end; color: var(--muted); line-height: 1.1; }
.expiry-inline span { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }.expiry-inline strong { margin-top: 3px; color: var(--ink); font-size: 11px; font-variant-numeric: tabular-nums; }
.state-pill { padding: 6px 10px; display: inline-flex; align-items: center; gap: 7px; border: 1px solid #ddd2c2; border-radius: 999px; color: #665c4f; background: rgba(255,255,255,.7); font-size: 11px; white-space: nowrap; }
.state-pill span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(208,138,53,.13); }
.shell[data-state="sent"] .state-pill { color: #246247; border-color: #b9d5c7; background: #edf7f1; }.shell[data-state="sent"] .state-pill span { background: var(--green); box-shadow: 0 0 0 3px rgba(40,119,91,.12); }
.shell[data-state="failed"] .state-pill, .shell[data-state="uncertain"] .state-pill, .shell[data-state="expired"] .state-pill, .shell[data-state="cancelled"] .state-pill { color: #82483e; border-color: #dfc1b9; background: #fbefec; }
.editor-view { padding: clamp(22px, 4vw, 30px); }
.eyebrow { margin: 0 0 5px; color: var(--accent-deep); font-size: 9px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(25px, 5vw, 32px); line-height: 1.05; letter-spacing: -.04em; }
.sender-line { max-width: 100%; margin: 0 0 15px; overflow: hidden; color: var(--subtle); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.sender-line strong { margin-left: 4px; color: var(--ink); font-size: 11px; }
.recipient-block { min-width: 0; margin: 0; padding: 0 0 13px; border: 0; border-bottom: 1px solid var(--soft-line); background: transparent; }
.field-row, .media-meta { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.field-row { margin-bottom: 8px; }.field-row .field-title, .field-row label, .field-row h2 { margin: 0; padding: 0; font-size: 12px; font-weight: 750; }.field-row output { color: var(--subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
.mode-switch { display: flex; gap: 3px; padding: 3px; border-radius: 999px; background: #eee6da; }
.mode-switch input { position: absolute; opacity: 0; pointer-events: none; }.mode-switch span { display: block; padding: 3px 9px; border-radius: 999px; color: var(--muted); font-size: 10px; font-weight: 750; cursor: pointer; }.mode-switch input:checked + span { color: var(--ink); background: #fff; box-shadow: 0 2px 7px rgba(61,49,35,.09); }
.route-input { width: 100%; min-height: 36px; padding: 3px 0; border: 0; border-bottom: 1px solid #d9cec0; border-radius: 0; outline: 0; color: var(--ink); background: transparent; font-size: 14px; }.route-input:focus { border-color: var(--accent); }.route-input::placeholder { color: #aaa093; }.recipient-block > small { display: block; margin-top: 6px; color: var(--muted); font-size: 9px; }
.reply-card { margin-top: 12px; padding: 9px 10px; display: grid; grid-template-columns: 3px 1fr auto; align-items: center; gap: 10px; border: 1px solid #e5d7c5; border-radius: 12px; background: #fbf5eb; }.reply-line { width: 3px; height: 28px; border-radius: 3px; background: var(--accent); }.reply-card div > span { color: var(--subtle); font-size: 8px; letter-spacing: .07em; text-transform: uppercase; }.reply-card p { max-width: 560px; margin: 1px 0 0; overflow: hidden; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; unicode-bidi: plaintext; text-overflow: ellipsis; white-space: nowrap; }
.message-block { margin-top: 17px; }
textarea { width: 100%; min-height: 108px; resize: vertical; padding: 13px 14px; border: 1px solid var(--line); border-radius: 14px; outline: 0; color: var(--ink); background: rgba(255,255,255,.78); line-height: 1.55; box-shadow: inset 0 1px 0 #fff; transition: border-color .16s ease, box-shadow .16s ease; }textarea:focus { border-color: #d3a56c; box-shadow: 0 0 0 4px rgba(208,138,53,.1); }textarea:disabled { color: var(--muted); background: #f0ebe3; cursor: not-allowed; }textarea::placeholder { color: #a59b8e; }
.field-help { margin: 6px 2px 0; color: var(--muted); font-size: 10px; }
.bidi-warning { margin-top: 9px; padding: 11px 12px; display: grid; grid-template-columns: 22px minmax(0,1fr); gap: 9px; border: 1px solid #d9b474; border-radius: 12px; color: #6f4a1e; background: #fff5df; }.bidi-warning > span { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: var(--accent); font-size: 10px; font-weight: 850; }.bidi-warning strong { font-size: 10px; }.bidi-warning p { margin: 2px 0 6px; color: #7b6242; font-size: 9px; }.bidi-warning code { max-height: 110px; padding: 7px 8px; display: block; overflow: auto; border: 1px solid #ead4aa; border-radius: 8px; color: var(--ink); background: rgba(255,255,255,.74); direction: ltr; font: 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; unicode-bidi: plaintext; white-space: pre-wrap; }
.composer-tools { min-height: 31px; display: flex; align-items: center; gap: 11px; }
.text-button, .icon-button { border: 0; cursor: pointer; }.text-button { color: var(--accent-deep); font-size: 10px; font-weight: 760; }.icon-button { width: 28px; height: 28px; display: grid; flex: 0 0 auto; place-items: center; border-radius: 999px; color: var(--muted); background: transparent; font-size: 18px; line-height: 1; }.icon-button:hover { color: var(--ink); background: #eee5d8; }
.emoji-button { min-height: 29px; padding: 0 8px; border-radius: 999px; background: transparent; }.emoji-button:hover { color: var(--ink); background: #eee5d8; }
.media-card { margin-top: 6px; overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.62); }.media-stage { min-height: 110px; max-height: 260px; display: grid; place-items: center; overflow: hidden; background: #eee8df; }.media-stage img, .media-stage video { width: 100%; max-height: 260px; display: block; object-fit: contain; }.media-stage audio { width: min(420px, calc(100% - 28px)); }.document-preview { min-height: 110px; display: grid; place-items: center; align-content: center; gap: 6px; color: var(--muted); }.document-preview span { padding: 8px 10px; border: 1px solid #cec2b3; border-radius: 9px; color: var(--ink); background: #fff; font-size: 10px; font-weight: 850; }.document-preview small { font-size: 9px; }.media-meta { padding: 9px 11px; }.media-meta > div { min-width: 0; display: grid; }.media-meta strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.media-meta small { color: var(--muted); font-size: 9px; }
.link-card { margin-top: 12px; border: 1px solid rgba(219,207,191,.88); border-radius: 14px; background: rgba(255,253,248,.82); }
.link-card { min-height: 74px; position: relative; display: grid; grid-template-columns: 86px minmax(0,1fr); overflow: hidden; }.link-thumbnail { display: grid; place-items: center; overflow: hidden; color: var(--accent-deep); background: linear-gradient(145deg,#f1dfc7,#e9d2b6); font-size: 22px; }.link-thumbnail img { width: 100%; height: 100%; object-fit: cover; }.link-copy { min-width: 0; padding: 11px 40px 11px 12px; display: grid; align-content: center; }.link-copy span { color: var(--accent-deep); font-size: 8px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }.link-copy strong { margin-top: 2px; overflow: hidden; font-size: 11px; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }.link-copy p { margin: 3px 0 0; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.link-card > .icon-button { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: rgba(248,243,234,.9); }
.link-spinner { width: 20px; height: 20px; border: 2px solid rgba(155,94,31,.2); border-top-color: var(--accent-deep); border-radius: 50%; animation: spin .8s linear infinite; }.link-retry { width: max-content; margin-top: 5px; padding: 0; border: 0; color: var(--accent-deep); background: transparent; font-size: 9px; font-weight: 800; cursor: pointer; }.link-retry:hover { text-decoration: underline; }.link-card[data-state="unavailable"] .link-thumbnail { background: linear-gradient(145deg,#f2e8da,#eadfce); }
.editor-actions { margin-top: 16px; padding-top: 14px; display: flex; align-items: center; justify-content: flex-end; gap: 20px; border-top: 1px solid var(--soft-line); }.editor-actions > div { display: flex; align-items: center; gap: 8px; }
.secondary-button, .send-button { min-height: 44px; border: 0; border-radius: 999px; cursor: pointer; font-weight: 760; transition: transform .16s ease, box-shadow .16s ease, opacity .16s ease; }.secondary-button { padding: 0 16px; color: var(--muted); background: transparent; }.secondary-button:hover { color: var(--ink); background: #eee6db; }.send-button { min-width: 194px; padding: 0 7px 0 19px; display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #fff; background: linear-gradient(135deg,#d79545,#bd7427); box-shadow: 0 11px 23px rgba(175,105,29,.23); }.send-button b { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; background: rgba(255,255,255,.18); }.send-button:hover { transform: translateY(-1px); box-shadow: 0 14px 27px rgba(175,105,29,.28); }
.progress-view { min-height: 380px; padding: 48px 26px; place-items: center; align-content: center; text-align: center; }.progress-view:not([hidden]) { display: grid; }.spinner { width: 46px; height: 46px; margin-bottom: 21px; border: 3px solid #eadfce; border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }.progress-view h1 { font-size: 31px; }.progress-view > p:not(.eyebrow) { max-width: 390px; margin: 10px 0 0; color: var(--muted); font-size: 12px; }.progress-recipient { max-width: 100%; margin-top: 22px; padding: 8px 13px; overflow: hidden; border: 1px solid var(--line); border-radius: 999px; color: var(--subtle); background: rgba(255,255,255,.62); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.progress-recipient strong { margin-left: 5px; color: var(--ink); font-size: 10px; }
.receipt-view { min-height: 380px; padding: clamp(28px, 5vw, 40px); }.receipt-heading { display: grid; grid-template-columns: 42px minmax(0,1fr); gap: 14px; align-items: start; }.result-mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 14px; color: #fff; background: var(--green); font-size: 18px; font-weight: 800; }.receipt-heading h1 { font-size: 29px; }.receipt-heading div > p:last-child { margin: 7px 0 0; color: var(--muted); font-size: 11px; }
.shell[data-state="failed"] .result-mark, .shell[data-state="cancelled"] .result-mark, .shell[data-state="expired"] .result-mark { background: var(--red); }.shell[data-state="uncertain"] .result-mark { background: var(--accent); }
.receipt-summary { margin-top: 27px; padding: 4px 20px 18px; border: 1px solid var(--line); border-radius: 17px; background: rgba(255,255,255,.6); }.receipt-route, .receipt-details { margin: 0; }.receipt-route > div, .receipt-details > div { padding: 12px 0; display: grid; grid-template-columns: 94px minmax(0,1fr); gap: 12px; border-bottom: 1px solid var(--soft-line); }.receipt-route dt, .receipt-details dt { color: var(--subtle); font-size: 9px; text-transform: uppercase; letter-spacing: .07em; }.receipt-route dd, .receipt-details dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 11px; font-weight: 700; unicode-bidi: plaintext; }.receipt-message { padding: 15px 0; border-bottom: 1px solid var(--soft-line); }.receipt-message h2 { margin: 0 0 7px; color: var(--subtle); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }.receipt-message pre { max-height: 230px; margin: 0; overflow: auto; color: var(--ink); font: 12px/1.55 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; unicode-bidi: plaintext; white-space: pre-wrap; }.receipt-time { margin: 15px 0 0; color: var(--subtle); font-size: 9px; }
.error-banner { margin: 0 clamp(20px,5vw,38px) 24px; padding: 11px 12px; align-items: center; gap: 9px; border: 1px solid #dfbeb7; border-radius: 12px; color: #7f4035; background: #fbeeea; }.error-banner:not([hidden]) { display: flex; }.error-banner span { width: 21px; height: 21px; display: grid; flex: 0 0 auto; place-items: center; border-radius: 50%; color: #fff; background: var(--red); font-size: 10px; font-weight: 850; }.error-banner p { margin: 0; font-size: 10px; }
button:disabled, input:disabled, select:disabled, label.is-disabled { opacity: .52; cursor: not-allowed; }.send-button:disabled { transform: none; box-shadow: none; }
:focus-visible { outline: 3px solid rgba(208,138,53,.34); outline-offset: 3px; }.route-input:focus-visible, textarea:focus-visible { outline: 0; }
.visually-hidden { width: 1px !important; height: 1px !important; position: absolute !important; overflow: hidden !important; clip: rect(0 0 0 0) !important; clip-path: inset(50%) !important; white-space: nowrap !important; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 590px) { body { padding: 0; }.shell { min-height: 100svh; border: 0; border-radius: 0; }.topbar { min-height: 60px; padding: 10px 15px; }.brand small, .expiry-inline span { display: none; }.header-status { gap: 8px; }.editor-view { padding: 21px 16px calc(18px + env(safe-area-inset-bottom)); }.sender-line { max-width: 100%; }.editor-actions { align-items: stretch; flex-direction: column; }.editor-actions > div { width: 100%; }.secondary-button { flex: 0 0 auto; }.send-button { min-width: 0; flex: 1; }.progress-view { min-height: calc(100svh - 60px); }.receipt-view { min-height: calc(100svh - 60px); padding: 28px 17px; }.receipt-summary { padding-inline: 15px; }.receipt-route > div, .receipt-details > div { grid-template-columns: 78px minmax(0,1fr); }.error-banner { margin: 0 16px 18px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }.spinner { border-top-color: var(--accent-deep); } }
@media (prefers-contrast: more) { :root { --line: #9b8e7e; }.shell, .recipient-block, textarea, .link-card, .receipt-summary { background: #fff; } }
`;
}

export function reviewPageScript(): string {
  return String.raw`(() => {
  "use strict";
  const query = (selector) => document.querySelector(selector);
  const nodes = {
    app: query("#app"), form: query("#composer"), editor: query("#editor-view"), sendingView: query("#sending-view"), receiptView: query("#receipt-view"), statePill: query("#state-pill b"), countdown: query("#countdown"),
    from: query("#from-label"), directMode: query("#mode-direct"), groupMode: query("#mode-group"), directFields: query("#direct-fields"), groupFields: query("#group-fields"),
    e164: query("#recipient-e164"), group: query("#recipient-group"), recipientHelp: query("#recipient-help"),
    replyCard: query("#reply-card"), replyLabel: query("#reply-label"), removeReply: query("#remove-reply"),
    text: query("#message-text"), messageLabel: query("#message-label"), messageHelp: query("#message-help"), count: query("#character-count"), bidiWarning: query("#bidi-warning"), bidiPreview: query("#bidi-preview"),
    emojiToggle: query("#emoji-button"),
    file: query("#attachment-input"), attachmentAction: query("#attachment-action"), mediaCard: query("#media-card"),
    mediaImage: query("#media-image"), mediaVideo: query("#media-video"), mediaAudio: query("#media-audio"), mediaDocument: query("#media-document"), mediaName: query("#media-name"), mediaDetail: query("#media-detail"), removeAttachment: query("#remove-attachment"),
    linkCard: query("#link-card"), linkImage: query("#link-image"), linkFallback: query("#link-fallback"), linkSpinner: query("#link-spinner"), linkHost: query("#link-host"), linkTitle: query("#link-title"), linkDescription: query("#link-description"), retryLink: query("#retry-link"), removeLink: query("#remove-link"),
    progressTitle: query("#progress-title"), progressDetail: query("#progress-detail"), progressTo: query("#progress-to"),
    resultMark: query("#result-mark"), resultKicker: query("#result-kicker"), resultTitle: query("#result-title"), resultDetail: query("#result-detail"), receiptSummary: query("#receipt-summary"), receiptFrom: query("#receipt-from"), receiptTo: query("#receipt-to"), receiptMessage: query("#receipt-message"), receiptMessageLabel: query("#receipt-message-label"), receiptText: query("#receipt-text"), receiptReplyRow: query("#receipt-reply-row"), receiptReply: query("#receipt-reply"), receiptAttachmentRow: query("#receipt-attachment-row"), receiptAttachment: query("#receipt-attachment"), receiptLinkRow: query("#receipt-link-row"), receiptLink: query("#receipt-link"), receiptCompleted: query("#receipt-completed"),
    error: query("#error-banner"), errorText: query("#error-text"), cancel: query("#cancel-button"), send: query("#send-button"), sendText: query("#send-button span")
  };
  const phases = new Set(["open", "validating", "sending", "sent", "failed", "uncertain", "cancelled", "expired"]);
  const terminal = new Set(["sent", "failed", "uncertain", "cancelled", "expired"]);
  const phaseCopy = {
    open: ["Ready", "Review and edit before sending."], validating: ["Sending", "Checking the final details."], sending: ["Sending", "Waiting for WhatsApp to confirm the send."],
    sent: ["Sent", "WhatsApp accepted this message."], failed: ["Not sent", "WhatsApp could not send this message."], uncertain: ["Check WhatsApp", "The connection ended before delivery could be confirmed."],
    cancelled: ["Cancelled", "This review closed without sending."], expired: ["Expired", "This review closed without sending."]
  };
  const errorCopy = {
    invalid_recipient: "Enter a valid international phone number or choose a group.", invalid_message: "Add a message or attachment before sending.",
    media_too_large: "That file is larger than this review allows.", unsupported_media: "That file type cannot be sent safely.",
    review_expired: "This private review has expired.", connection_failed: "WhatsApp is not connected right now.", send_failed: "WhatsApp could not send this message.",
    delivery_uncertain: "Delivery could not be confirmed. Check WhatsApp before taking another action.", send_status_pending: "We are checking whether WhatsApp accepted this send. Do not retry yet.", stale_attachment: "The attachment changed in another tab. Review the refreshed file before sending.", invalid_attachment: "The attachment could not be verified. Review the refreshed draft before sending.", invalid_link_preview: "The link preview changed in another tab. Review the refreshed draft before sending.", preview_failed: "The link preview could not be loaded. You can still send without it.", message_too_long: "This message is longer than WhatsApp allows here.",
    missing_action: "This private review link is incomplete. Open a fresh review from your agent."
  };
  let state = null; let actionToken = ""; let activeReplyId; let removedPreviewUrl = ""; let observedUrl = ""; let previewFailureUrl = ""; let previewFailureCode = "";
  let pollTimer; let previewTimer; let submitting = false; let previewLoading = false; let previewLoadingUrl = ""; let submissionStarted = false; let submissionStatusUnknown = false; let submissionNoticeCode = "send_status_pending";
  const storageKey = "safe-whatsapp-action:" + location.pathname;

  function loadActionToken() {
    const fragmentToken = new URLSearchParams(location.hash.slice(1)).get("action") || "";
    try { if (fragmentToken) sessionStorage.setItem(storageKey, fragmentToken); actionToken = fragmentToken || sessionStorage.getItem(storageKey) || ""; } catch { actionToken = fragmentToken; }
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }
  function forgetActionToken() { try { sessionStorage.removeItem(storageKey); } catch {} actionToken = ""; }
  function mutationHeaders(extra) { return Object.assign({ "x-safe-whatsapp-action": actionToken }, extra || {}); }
  async function request(path, options) {
    const response = await fetch(path, Object.assign({ cache: "no-store", credentials: "same-origin" }, options || {}));
    let data = null; const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) { try { data = await response.json(); } catch { data = null; } }
    if (!response.ok) { const code = data && typeof data.errorCode === "string" ? data.errorCode : "request_failed"; const error = new Error(code); error.code = code; error.responseReceived = true; error.status = response.status; throw error; }
    return { response, data };
  }
  async function jsonMutation(path, method, body) { return request(path, { method, headers: mutationHeaders({ "content-type": "application/json" }), body: JSON.stringify(body || {}) }); }
  function showError(value) { nodes.errorText.textContent = errorCopy[value] || "This review could not complete that action. Please try again."; nodes.error.hidden = false; }
  function clearError() { nodes.error.hidden = true; nodes.errorText.textContent = ""; }
  function isFullState(value) { return Boolean(value && phases.has(value.state) && typeof value.reviewId === "string" && typeof value.expiresAt === "string" && (value.state !== "open" || (value.destination && typeof value.destination === "object"))); }
  function sameOriginAsset(raw) {
    if (typeof raw !== "string" || !raw) return "";
    try { const url = new URL(raw, location.href); return url.origin === location.origin && url.pathname.startsWith(location.pathname) ? url.href : ""; } catch { return ""; }
  }
  function setSource(element, raw) { const safe = sameOriginAsset(raw); element.hidden = !safe; if (safe) element.src = safe; else element.removeAttribute("src"); }
  function prettyBytes(value) { if (!Number.isFinite(value) || value < 0) return ""; if (value < 1024) return String(value) + " B"; if (value < 1048576) return (value / 1024).toFixed(1) + " KB"; return (value / 1048576).toFixed(1) + " MB"; }
  function exposeBidiControls(value) { return String(value || "").replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, (character) => "⟦U+" + character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") + "⟧"); }
  function renderBidiWarning() { const exposed = exposeBidiControls(nodes.text.value); const changed = exposed !== nodes.text.value; nodes.bidiWarning.hidden = !changed; nodes.bidiPreview.textContent = changed ? exposed : ""; }
  function firstHttpUrl(value) { const match = String(value || "").match(/(?:^|[^A-Za-z0-9@])((?:https?:\/\/|www\.)[^\s<>"']+)/iu); return match ? match[1].replace(/[),.!?;:\]}]+$/u, "") : ""; }
  function previewRequestUrl(value) { return /^www\./iu.test(value) ? "https://" + value : value; }
  function recipientMode() { return nodes.groupMode.checked ? "group" : "direct"; }
  function recipientSummary() {
    if (recipientMode() === "direct") return nodes.e164.value.trim() || "Add a phone number";
    const option = nodes.group.selectedOptions[0]; return option && option.value ? option.textContent : "Choose a group";
  }
  function updateRecipientUi() {
    const group = recipientMode() === "group"; nodes.directFields.hidden = group; nodes.groupFields.hidden = !group;
    nodes.recipientHelp.textContent = group ? "Only groups synced to this device are available" : "Use a full number beginning with +";
  }
  function clearReplyForRecipientEdit() { if (!activeReplyId) return; activeReplyId = undefined; nodes.replyCard.hidden = true; }
  function renderGroups(groups, selected) {
    while (nodes.group.options.length > 1) nodes.group.remove(1);
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group || typeof group.choiceId !== "string" || typeof group.label !== "string") continue;
      const option = document.createElement("option"); option.value = group.choiceId; option.textContent = group.label; nodes.group.append(option);
    }
    nodes.group.value = typeof selected === "string" ? selected : "";
  }
  function resetMediaElements() {
    for (const element of [nodes.mediaImage, nodes.mediaVideo, nodes.mediaAudio]) { element.pause && element.pause(); element.hidden = true; element.removeAttribute("src"); }
    nodes.mediaDocument.hidden = true;
  }
  function renderMedia(media) {
    resetMediaElements(); const present = Boolean(media); nodes.mediaCard.hidden = !present; nodes.attachmentAction.textContent = present ? "Replace attachment" : "＋ Add attachment";
    if (!present) return;
    nodes.mediaName.textContent = typeof media.fileName === "string" ? exposeBidiControls(media.fileName) : "Attachment";
    nodes.mediaDetail.textContent = [typeof media.mimeType === "string" ? media.mimeType : "", prettyBytes(media.size)].filter(Boolean).join(" · ");
    const safe = sameOriginAsset(media.previewUrl); const kind = typeof media.kind === "string" ? media.kind : "document";
    if (kind === "image" && safe) setSource(nodes.mediaImage, safe); else if (kind === "video" && safe) setSource(nodes.mediaVideo, safe); else if (kind === "audio" && safe) setSource(nodes.mediaAudio, safe); else nodes.mediaDocument.hidden = false;
  }
  function activePreview() {
    if (!state || !state.linkPreview || state.media) return null; const currentUrl = firstHttpUrl(nodes.text.value);
    return currentUrl && currentUrl === state.linkPreview.url && currentUrl !== removedPreviewUrl ? state.linkPreview : null;
  }
  function linkHost(value) { try { return new URL(previewRequestUrl(value)).hostname; } catch { return "Link preview"; } }
  function previewFailureMessage(code) { return code === "preview_limit_reached" ? "This review reached its preview limit. You can still send without a preview." : "The website did not return a safe, usable preview. Retry, or send without one."; }
  function renderLinkPreview() {
    const url = firstHttpUrl(nodes.text.value); const eligible = Boolean(state && state.state === "open" && !state.media && url && url !== removedPreviewUrl); const preview = activePreview();
    const loading = Boolean(eligible && previewLoading && previewLoadingUrl === url); const unavailable = Boolean(eligible && previewFailureUrl === url); const mode = preview ? "ready" : loading ? "loading" : unavailable ? "unavailable" : "hidden";
    nodes.linkCard.hidden = mode === "hidden"; nodes.linkCard.dataset.state = mode; nodes.linkCard.setAttribute("aria-busy", mode === "loading" ? "true" : "false"); nodes.linkImage.hidden = true; nodes.linkImage.removeAttribute("src"); nodes.linkFallback.hidden = mode === "loading"; nodes.linkSpinner.hidden = mode !== "loading"; nodes.retryLink.hidden = mode !== "unavailable"; nodes.linkHost.textContent = ""; nodes.linkTitle.textContent = ""; nodes.linkDescription.textContent = ""; nodes.linkDescription.hidden = true;
    if (mode === "hidden") return;
    nodes.linkHost.textContent = linkHost(preview ? preview.url : url);
    if (loading) { nodes.linkTitle.textContent = "Loading preview…"; nodes.linkDescription.textContent = "Checking this website for a safe preview."; nodes.linkDescription.hidden = false; return; }
    if (unavailable) { nodes.linkTitle.textContent = "Preview unavailable"; nodes.linkDescription.textContent = previewFailureMessage(previewFailureCode); nodes.linkDescription.hidden = false; return; }
    nodes.linkTitle.textContent = typeof preview.title === "string" ? preview.title : preview.url;
    const description = typeof preview.description === "string" ? preview.description : ""; nodes.linkDescription.textContent = description; nodes.linkDescription.hidden = !description;
    const thumbnail = sameOriginAsset(preview.thumbnailUrl); if (thumbnail) { setSource(nodes.linkImage, thumbnail); nodes.linkFallback.hidden = true; }
  }
  function renderProgress() {
    if (!state || (state.state !== "validating" && state.state !== "sending")) return;
    nodes.progressTitle.textContent = submissionStatusUnknown ? "Confirming send…" : "Sending…";
    nodes.progressDetail.textContent = submissionStatusUnknown ? "We are checking whether WhatsApp accepted it. Do not retry yet." : state.state === "validating" ? "Checking the final details before sending." : "Keep this page open while WhatsApp confirms the send.";
    const summary = state.submittedSummary; nodes.progressTo.textContent = summary && typeof summary.recipientLabel === "string" ? summary.recipientLabel : recipientSummary();
  }
  function formatCompletedAt(value, sent) {
    if (typeof value !== "string") return ""; const instant = new Date(value); if (!Number.isFinite(instant.getTime())) return "";
    return (sent ? "Sent " : "Completed ") + new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(instant);
  }
  function renderReceipt() {
    if (!state || !terminal.has(state.state)) return;
    const copy = phaseCopy[state.state] || phaseCopy.failed; nodes.resultKicker.textContent = state.state === "sent" ? "Complete" : state.state === "uncertain" ? "Confirmation unavailable" : "Review closed";
    nodes.resultTitle.textContent = copy[0]; nodes.resultDetail.textContent = copy[1]; nodes.resultMark.textContent = state.state === "sent" ? "✓" : state.state === "uncertain" ? "?" : "×";
    const summary = state.submittedSummary; nodes.receiptSummary.hidden = !summary; if (!summary) return;
    nodes.receiptFrom.textContent = typeof state.fromLabel === "string" ? state.fromLabel : "Linked WhatsApp";
    nodes.receiptTo.textContent = typeof summary.recipientLabel === "string" ? summary.recipientLabel : "WhatsApp recipient";
    const text = typeof summary.text === "string" ? summary.text : ""; nodes.receiptMessage.hidden = !text; nodes.receiptMessageLabel.textContent = summary.attachment ? "Caption" : "Message"; nodes.receiptText.textContent = exposeBidiControls(text);
    const reply = typeof summary.replyLabel === "string" ? summary.replyLabel : ""; nodes.receiptReplyRow.hidden = !reply; nodes.receiptReply.textContent = exposeBidiControls(reply);
    const attachment = summary.attachment; nodes.receiptAttachmentRow.hidden = !attachment;
    nodes.receiptAttachment.textContent = attachment ? [exposeBidiControls(attachment.fileName || "Attachment"), attachment.mimeType || "", prettyBytes(attachment.size)].filter(Boolean).join(" · ") : "";
    const preview = summary.linkPreview; nodes.receiptLinkRow.hidden = !preview;
    if (preview) { let host = ""; try { host = new URL(previewRequestUrl(preview.url)).hostname; } catch {} nodes.receiptLink.textContent = [preview.title, preview.description, host].filter((value) => typeof value === "string" && value).join(" · "); } else nodes.receiptLink.textContent = "";
    const completed = formatCompletedAt(summary.completedAt, state.state === "sent"); nodes.receiptCompleted.hidden = !completed; nodes.receiptCompleted.textContent = completed;
  }
  function renderStateViews() {
    const phase = state ? state.state : "failed"; const inProgress = phase === "validating" || phase === "sending"; const done = terminal.has(phase);
    nodes.editor.hidden = phase !== "open"; nodes.sendingView.hidden = !inProgress; nodes.receiptView.hidden = !done; nodes.app.setAttribute("aria-busy", inProgress ? "true" : "false");
    if (inProgress) renderProgress(); if (done) renderReceipt();
  }
  function renderControls() {
    const phase = state ? state.state : "failed"; const locked = phase !== "open" || submitting;
    for (const node of [nodes.directMode, nodes.groupMode, nodes.e164, nodes.group, nodes.file, nodes.removeReply, nodes.removeAttachment, nodes.removeLink]) node.disabled = locked;
    nodes.retryLink.disabled = locked || previewLoading;
    nodes.text.disabled = locked || Boolean(state && state.media && state.media.kind === "audio"); nodes.emojiToggle.disabled = nodes.text.disabled;
    nodes.attachmentAction.classList.toggle("is-disabled", locked); nodes.cancel.disabled = phase !== "open" || submitting; nodes.send.disabled = locked || previewPending(); nodes.sendText.textContent = "Send on WhatsApp";
  }
  function setPhase(phase) { const safe = phases.has(phase) ? phase : "failed"; nodes.app.dataset.state = safe; nodes.statePill.textContent = (phaseCopy[safe] || phaseCopy.failed)[0]; }
  function render(next, hydrate) {
    if (!next || !phases.has(next.state)) throw new Error("invalid_state"); const reportedPhase = next.state;
    if (submissionStarted && reportedPhase === "open") next = Object.assign({}, next, { state: "validating" });
    if (submissionStarted && reportedPhase !== "open" && reportedPhase !== "validating") submissionStatusUnknown = false;
    state = next; if (terminal.has(state.state)) forgetActionToken(); setPhase(state.state); nodes.from.textContent = typeof state.fromLabel === "string" ? state.fromLabel : "Linked WhatsApp";
    if (hydrate) {
      const destination = state.destination || {}; nodes.groupMode.checked = destination.mode === "group"; nodes.directMode.checked = !nodes.groupMode.checked;
      nodes.e164.value = typeof destination.e164 === "string" ? destination.e164 : ""; renderGroups(state.groups, destination.groupChoiceId);
      nodes.text.value = typeof state.text === "string" ? state.text : ""; activeReplyId = state.reply && typeof state.reply.messageId === "string" ? state.reply.messageId : undefined;
      nodes.replyLabel.textContent = state.reply && typeof state.reply.label === "string" ? state.reply.label : "Original WhatsApp message"; nodes.replyCard.hidden = !activeReplyId; observedUrl = firstHttpUrl(nodes.text.value);
    }
    renderMedia(state.media); updateMessageMode(); updateRecipientUi(); updateCount(); renderLinkPreview(); renderStateViews(); renderControls();
    if (submissionStatusUnknown) showError(submissionNoticeCode); else if (state.errorCode) showError(state.errorCode); else clearError();
    if (state.state === "validating" || state.state === "sending") schedulePoll(650);
    if (state.state === "open") schedulePreview(hydrate ? 0 : 350);
  }
  function updateMessageMode() {
    const audio = Boolean(state && state.media && state.media.kind === "audio"); nodes.text.disabled = audio || Boolean(state && state.state !== "open") || submitting;
    nodes.text.maxLength = state && state.media ? 1024 : 4096; nodes.messageLabel.textContent = state && state.media ? "Caption" : "Message";
    const help = audio ? "WhatsApp audio attachments do not support captions." : state && state.media ? "Edit the caption for this attachment." : "";
    nodes.messageHelp.textContent = help; nodes.messageHelp.hidden = !help;
  }
  function updateCount() { const max = Number(nodes.text.maxLength); nodes.count.textContent = nodes.text.value.length.toLocaleString() + " / " + max.toLocaleString(); renderBidiWarning(); }
  function configureEmojiHelper() { const platform = navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || ""; const mac = /Mac/iu.test(platform); nodes.emojiToggle.textContent = mac ? "Emoji · Fn-E" : "Emoji"; nodes.emojiToggle.title = mac ? "Focus the message field, then press Fn-E or Control-Command-Space" : "Focus the message field to use your system emoji keyboard"; }
  function updateCountdown() {
    if (!state) return; if (terminal.has(state.state)) { nodes.countdown.textContent = state.state === "sent" ? "Complete" : "Closed"; return; }
    const remaining = Date.parse(state.expiresAt) - Date.now(); if (!Number.isFinite(remaining)) { nodes.countdown.textContent = "A few minutes"; return; }
    if (remaining <= 0) { nodes.countdown.textContent = "Closed"; if (state.state === "open") { state.state = "expired"; setPhase("expired"); renderStateViews(); renderControls(); } return; }
    const seconds = Math.ceil(remaining / 1000); const minutes = Math.floor(seconds / 60); nodes.countdown.textContent = minutes ? String(minutes) + "m " + String(seconds % 60).padStart(2, "0") + "s" : String(seconds) + "s";
  }
  function schedulePoll(delay) { clearTimeout(pollTimer); pollTimer = setTimeout(() => refresh(false), delay); }
  async function refresh(hydrate) { try { const result = await request("./api"); render(result.data, hydrate); updateCountdown(); } catch (error) { showError(submissionStatusUnknown ? submissionNoticeCode : error.code); if (state && !terminal.has(state.state)) schedulePoll(1500); } }
  function previewPending() {
    const url = firstHttpUrl(nodes.text.value);
    return Boolean(state && state.state === "open" && !state.media && url && url !== removedPreviewUrl && url !== previewFailureUrl && !activePreview());
  }
  function schedulePreview(delay) {
    clearTimeout(previewTimer);
    if (!previewPending() || submitting || previewLoading) return;
    previewTimer = setTimeout(loadPreview, delay);
  }
  function updatePreviewOffer() {
    const url = firstHttpUrl(nodes.text.value); if (url !== observedUrl) { observedUrl = url; removedPreviewUrl = ""; previewFailureUrl = ""; previewFailureCode = ""; }
    renderLinkPreview(); renderControls(); schedulePreview(450);
  }
  async function loadPreview() {
    clearTimeout(previewTimer);
    if (!previewPending() || submitting || previewLoading) return; const url = firstHttpUrl(nodes.text.value);
    previewLoading = true; previewLoadingUrl = url; clearError(); renderLinkPreview(); renderControls();
    try { const result = await jsonMutation("./preview", "POST", { url }); if (url !== firstHttpUrl(nodes.text.value) || url === removedPreviewUrl) return; if (isFullState(result.data)) render(result.data, false); else await refresh(false); if (activePreview()) { previewFailureUrl = ""; previewFailureCode = ""; } else { previewFailureUrl = url; previewFailureCode = "preview_unavailable"; } }
    catch (error) { if (url === firstHttpUrl(nodes.text.value) && url !== removedPreviewUrl) { previewFailureUrl = url; previewFailureCode = error && typeof error.code === "string" ? error.code : "preview_unavailable"; } }
    finally { previewLoading = false; previewLoadingUrl = ""; renderLinkPreview(); renderControls(); schedulePreview(0); }
  }
  function retryPreview() { const url = firstHttpUrl(nodes.text.value); if (!state || state.state !== "open" || state.media || submitting || previewLoading || url !== previewFailureUrl) return; previewFailureUrl = ""; previewFailureCode = ""; renderLinkPreview(); renderControls(); schedulePreview(0); }
  async function uploadAttachment(file) {
    if (!file || !state || state.state !== "open") return; clearError(); if (Number.isFinite(state.maxMediaBytes) && file.size > state.maxMediaBytes) { showError("media_too_large"); return; }
    submitting = true; renderControls();
    try { await request("./attachment", { method: "PUT", headers: mutationHeaders({ "content-type": file.type || "application/octet-stream", "x-safe-file-name": encodeURIComponent(file.name) }), body: file }); await refresh(false); }
    catch (error) { showError(error.code); } finally { submitting = false; nodes.file.value = ""; updateMessageMode(); renderControls(); }
  }
  async function removeAttachment() {
    if (!state || state.state !== "open") return; submitting = true; renderControls(); clearError();
    try { await request("./attachment", { method: "DELETE", headers: mutationHeaders() }); await refresh(false); } catch (error) { showError(error.code); } finally { submitting = false; updateMessageMode(); renderControls(); schedulePreview(0); }
  }
  function validateDraft() {
    const mode = recipientMode(); const e164 = nodes.e164.value.replace(/[\s()-]/gu, ""); const groupChoiceId = nodes.group.value;
    if (mode === "direct" && !/^\+[1-9]\d{6,14}$/u.test(e164)) throw Object.assign(new Error("invalid_recipient"), { code: "invalid_recipient" });
    if (mode === "group" && !groupChoiceId) throw Object.assign(new Error("invalid_recipient"), { code: "invalid_recipient" });
    const audio = Boolean(state.media && state.media.kind === "audio"); const text = audio ? "" : nodes.text.value;
    if (!state.media && !text.trim()) throw Object.assign(new Error("invalid_message"), { code: "invalid_message" });
    if (text.length > Number(nodes.text.maxLength)) throw Object.assign(new Error("message_too_long"), { code: "message_too_long" });
    const preview = activePreview(); return { recipientMode: mode, e164: mode === "direct" ? e164 : undefined, groupChoiceId: mode === "group" ? groupChoiceId : undefined, text, replyToMessageId: activeReplyId, linkPreviewId: preview ? preview.id : undefined, attachmentId: state.media ? state.media.id : null };
  }
  async function send(event) {
    event.preventDefault(); if (!state || state.state !== "open" || submitting) return; clearError(); let body;
    try { body = validateDraft(); } catch (error) { showError(error.code); return; }
    submissionStarted = true; submitting = true; state.state = "validating"; setPhase("validating"); renderStateViews(); renderControls();
    try { const result = await jsonMutation("./send", "POST", body); if (result.response.status !== 202) throw new Error("send_status_pending"); submissionStatusUnknown = false; if (isFullState(result.data)) render(result.data, false); else { state.state = "sending"; setPhase("sending"); renderStateViews(); renderControls(); } schedulePoll(300); }
    catch (error) {
      if (error && error.responseReceived) { submissionStarted = false; submitting = false; submissionStatusUnknown = false; await refresh(false); showError(error.code); renderControls(); return; }
      submissionStatusUnknown = true; submissionNoticeCode = "send_status_pending"; state.state = "validating"; setPhase("validating"); renderStateViews(); showError(submissionNoticeCode); renderControls(); schedulePoll(500); }
  }
  async function cancel() {
    if (!state || state.state !== "open" || submitting) return; submitting = true; renderControls(); clearError();
    try { const result = await jsonMutation("./cancel", "POST", {}); if (isFullState(result.data)) render(result.data, false); else await refresh(false); } catch (error) { showError(error.code); } finally { submitting = false; renderControls(); }
  }
  function bind() {
    nodes.form.addEventListener("submit", send); nodes.cancel.addEventListener("click", cancel);
    nodes.directMode.addEventListener("change", () => { clearReplyForRecipientEdit(); updateRecipientUi(); }); nodes.groupMode.addEventListener("change", () => { clearReplyForRecipientEdit(); updateRecipientUi(); });
    nodes.e164.addEventListener("input", () => { clearReplyForRecipientEdit(); updateRecipientUi(); }); nodes.group.addEventListener("change", () => { clearReplyForRecipientEdit(); updateRecipientUi(); });
    nodes.text.addEventListener("input", () => { updateCount(); updatePreviewOffer(); }); nodes.removeReply.addEventListener("click", () => { activeReplyId = undefined; nodes.replyCard.hidden = true; });
    nodes.emojiToggle.addEventListener("click", () => nodes.text.focus());
    nodes.file.addEventListener("change", () => uploadAttachment(nodes.file.files && nodes.file.files[0])); nodes.removeAttachment.addEventListener("click", removeAttachment);
    nodes.retryLink.addEventListener("click", retryPreview); nodes.removeLink.addEventListener("click", () => { clearTimeout(previewTimer); removedPreviewUrl = firstHttpUrl(nodes.text.value); previewFailureUrl = ""; previewFailureCode = ""; renderLinkPreview(); renderControls(); });
    window.addEventListener("pagehide", () => { clearTimeout(pollTimer); clearTimeout(previewTimer); }); setInterval(updateCountdown, 1000);
  }
  loadActionToken(); configureEmojiHelper(); bind();
  if (!actionToken) { state = { state: "failed" }; setPhase("failed"); nodes.statePill.textContent = "Review link incomplete"; showError("missing_action"); renderStateViews(); renderControls(); return; }
  refresh(true);
})();`;
}
