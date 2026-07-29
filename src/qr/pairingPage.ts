// Agent context note: Renders the self-contained pairing/status page in the review composer's brand system, including an accessible finalizing indicator and same-origin poller. Tests: test/browser-qr.test.mjs plus visual browser verification. Keep it free of remote assets, inline scripts, QR transforms/filters, and user-controlled HTML; update this note after meaningful changes.
export type PairingPhase = "pairing" | "finalizing" | "linked" | "failed";

const PAGE_VIEWS: Record<PairingPhase, { badge: string; title: string; status: string; detail: string }> = {
  pairing: {
    badge: "Ready to scan",
    title: "Connect your WhatsApp",
    status: "Link this computer from WhatsApp on your phone.",
    detail: "The QR refreshes here automatically when WhatsApp rotates it.",
  },
  finalizing: {
    badge: "Connecting",
    title: "Finishing WhatsApp login",
    status: "Keep WhatsApp open on your phone while this computer finishes linking.",
    detail: "This usually takes a moment.",
  },
  linked: {
    badge: "Connected",
    title: "WhatsApp linked",
    status: "Safe WhatsApp is ready on this computer.",
    detail: "You can close this private local tab.",
  },
  failed: {
    badge: "Not connected",
    title: "WhatsApp couldn’t link",
    status: "Run safewhatsapp connect again to retry.",
    detail: "The terminal has the specific error and next step.",
  },
};

export function renderPairingPage(version: number, phase: PairingPhase): string {
  const view = PAGE_VIEWS[phase];
  const qr = phase === "pairing"
    ? `<img id="qr" data-version="${version}" src="./qr.png?v=${version}" alt="WhatsApp linked-device QR code">`
    : `<img id="qr" data-version="${version}" alt="" hidden>`;
  const script = phase === "linked" || phase === "failed"
    ? ""
    : `\n  <script src="./poll.js" defer></script>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Safe WhatsApp</title>
  <style>
    :root { color-scheme: light; --paper: #f8f3ea; --surface: #fffdf8; --ink: #221f1b; --muted: #6e6457; --subtle: #918678; --line: #ded4c6; --soft-line: #e9e1d6; --accent: #d08a35; --accent-deep: #9b5e1f; --green: #28775b; --red: #a24d3e; --shadow: 0 24px 70px rgba(62, 47, 31, .13), 0 3px 12px rgba(62, 47, 31, .05); font: 16px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--paper); }
    body { min-height: 100vh; min-height: 100svh; margin: 0; padding: clamp(12px, 4vw, 48px); display: grid; place-items: center; color: var(--ink); background: radial-gradient(circle at 7% 8%, rgba(234, 175, 99, .22), transparent 28rem), radial-gradient(circle at 94% 85%, rgba(91, 154, 126, .15), transparent 30rem), linear-gradient(145deg, #fbf7f0, #f3ecdf 72%, #f6f0e6); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .13; background-image: repeating-radial-gradient(circle at 20% 30%, #5e4f3c 0 .45px, transparent .6px 5px); background-size: 13px 11px; mix-blend-mode: soft-light; }
    .atmosphere { position: fixed; z-index: -1; border-radius: 50%; pointer-events: none; }
    .atmosphere-one { width: 19rem; height: 19rem; left: -10rem; top: 30%; border: 1px solid rgba(208, 138, 53, .14); box-shadow: 0 0 0 4rem rgba(208, 138, 53, .022), 0 0 0 8rem rgba(208, 138, 53, .016); }
    .atmosphere-two { width: 15rem; height: 15rem; right: -7rem; top: 7%; background: rgba(94, 147, 119, .055); }
    main { width: min(640px, 100%); margin: 0 auto; overflow: hidden; border: 1px solid rgba(255, 255, 255, .8); border-radius: 24px; background: rgba(255, 252, 246, .82); box-shadow: var(--shadow); backdrop-filter: blur(18px) saturate(1.06); transition: width .2s ease; }
    main[data-phase="pairing"] { width: min(960px, 100%); }
    .topbar { min-height: 62px; padding: 11px clamp(16px, 4vw, 24px); display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid rgba(222, 212, 198, .78); }
    .brand { display: inline-flex; align-items: center; gap: 10px; }
    .brand > span:last-child { display: grid; line-height: 1.1; }
    .brand strong { font-size: 13px; letter-spacing: -.02em; }
    .brand small { margin-top: 3px; color: var(--muted); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
    .brand-mark { width: 34px; height: 34px; position: relative; display: grid; place-items: center; overflow: hidden; border-radius: 11px; background: linear-gradient(145deg, #e6a34f, #bd7526); box-shadow: 0 8px 18px rgba(170, 100, 28, .22); }
    .brand-mark i { width: 14px; height: 6px; position: absolute; border: 1.5px solid #fff; border-radius: 50%; transform-origin: 7px 3px; }
    .brand-mark i:nth-child(1) { transform: rotate(0deg) translateX(5px); }
    .brand-mark i:nth-child(2) { transform: rotate(120deg) translateX(5px); }
    .brand-mark i:nth-child(3) { transform: rotate(240deg) translateX(5px); }
    .state-pill { padding: 6px 10px; display: inline-flex; align-items: center; gap: 7px; border: 1px solid #ddd2c2; border-radius: 999px; color: #665c4f; background: rgba(255, 255, 255, .7); font-size: 11px; white-space: nowrap; }
    .state-pill span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(208, 138, 53, .13); }
    main[data-phase="finalizing"] .state-pill span { animation: pulse 1.15s ease-in-out infinite; }
    main[data-phase="linked"] .state-pill { color: #246247; border-color: #b9d5c7; background: #edf7f1; }
    main[data-phase="linked"] .state-pill span { background: var(--green); box-shadow: 0 0 0 3px rgba(40, 119, 91, .12); }
    main[data-phase="failed"] .state-pill, main[data-phase="closed"] .state-pill { color: #82483e; border-color: #dfc1b9; background: #fbefec; }
    main[data-phase="failed"] .state-pill span, main[data-phase="closed"] .state-pill span { background: var(--red); box-shadow: 0 0 0 3px rgba(162, 77, 62, .1); }
    .content { padding: clamp(24px, 4vw, 38px); display: grid; grid-template-columns: minmax(0, .9fr) minmax(340px, 1.1fr); gap: clamp(26px, 4vw, 44px); align-items: center; }
    .eyebrow { margin: 0 0 7px; color: var(--accent-deep); font-size: 9px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    .phase-visual { min-height: 46px; margin: 0 0 20px; display: none; place-items: center; }
    .spinner { width: 46px; height: 46px; display: none; border: 3px solid #eadfce; border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    .result-mark { width: 42px; height: 42px; display: none; place-items: center; border-radius: 14px; color: #fff; font-size: 18px; font-weight: 800; }
    h1 { margin: 0; max-width: 520px; font-size: clamp(32px, 5vw, 46px); line-height: 1.02; letter-spacing: -.045em; }
    .lead { margin: 15px 0 0; max-width: 500px; color: var(--muted); font-size: clamp(15px, 2vw, 18px); line-height: 1.48; }
    .phase-detail { margin: 13px 0 0; color: var(--subtle); font-size: 11px; }
    .steps { margin-top: 25px; display: grid; gap: 10px; }
    .step { display: grid; grid-template-columns: 26px 1fr; gap: 10px; align-items: start; color: #49433c; font-size: 12px; }
    .number { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid #d4c8b9; border-radius: 8px; background: rgba(255, 255, 255, .72); font-size: 10px; font-weight: 800; }
    .safety { margin: 24px 0 0; padding-top: 16px; border-top: 1px solid var(--soft-line); color: var(--muted); font-size: 10px; }
    .safety strong { color: var(--ink); font-weight: 750; }
    .qr-panel { min-width: 0; justify-self: stretch; padding: 16px; border: 1px solid var(--line); border-radius: 18px; background: #fff; box-shadow: 0 14px 34px rgba(62, 47, 31, .09); }
    .qr-label { margin: 1px 0 12px; display: flex; align-items: center; justify-content: space-between; color: var(--subtle); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .local { display: inline-flex; align-items: center; gap: 6px; color: var(--green); letter-spacing: 0; text-transform: none; }
    .local::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
    img { display: block; width: auto; max-width: 100%; height: auto; max-height: 64vh; margin: 0 auto; image-rendering: pixelated; }
    [hidden] { display: none !important; }
    main:not([data-phase="pairing"]) .content { min-height: 380px; grid-template-columns: 1fr; place-items: center; text-align: center; }
    main:not([data-phase="pairing"]) .copy { max-width: 500px; display: grid; justify-items: center; }
    main:not([data-phase="pairing"]) .pairing-only { display: none; }
    main:not([data-phase="pairing"]) .phase-visual { display: grid; }
    main:not([data-phase="pairing"]) h1 { font-size: clamp(27px, 5vw, 32px); }
    main:not([data-phase="pairing"]) .lead { max-width: 390px; margin-top: 10px; font-size: 12px; }
    main:not([data-phase="pairing"]) .phase-detail { margin-top: 18px; padding: 8px 13px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255, 255, 255, .62); font-size: 9px; }
    main[data-phase="finalizing"] .spinner { display: block; }
    main[data-phase="linked"] .linked-mark { display: grid; background: var(--green); }
    main[data-phase="failed"] .failed-mark, main[data-phase="closed"] .failed-mark { display: grid; background: var(--red); }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 50% { opacity: .38; transform: scale(.72); } }
    @media (max-width: 720px) {
      body { padding: 0; place-items: start center; }
      main, main[data-phase="pairing"] { min-height: 100svh; border: 0; border-radius: 0; }
      .topbar { min-height: 60px; padding: 10px 15px; }
      .brand small { display: none; }
      .content { padding: 24px 16px calc(20px + env(safe-area-inset-bottom)); grid-template-columns: 1fr; gap: 24px; }
      main:not([data-phase="pairing"]) .content { min-height: calc(100svh - 60px); }
      h1 { font-size: clamp(31px, 10vw, 40px); }
      .qr-panel { width: 100%; padding: 13px; }
      img { max-height: none; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } .spinner { border-top-color: var(--accent-deep); } }
    @media (prefers-contrast: more) { :root { --line: #9b8e7e; } main, .qr-panel, .number, .phase-detail { background: #fff; } }
  </style>${script}
</head>
<body>
  <div class="atmosphere atmosphere-one" aria-hidden="true"></div>
  <div class="atmosphere atmosphere-two" aria-hidden="true"></div>
  <main data-phase="${phase}" aria-busy="${phase === "finalizing" ? "true" : "false"}">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span><strong>Safe WhatsApp</strong><small>by Bliss AI</small></span>
      </div>
      <div class="state-pill"><span aria-hidden="true"></span><b id="badge">${view.badge}</b></div>
    </header>
    <div class="content">
      <section class="copy">
        <p class="eyebrow">Personal WhatsApp · On this computer</p>
        <div class="phase-visual" aria-hidden="true">
          <span class="spinner"></span>
          <span class="result-mark linked-mark">✓</span>
          <span class="result-mark failed-mark">×</span>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          <h1 id="title">${view.title}</h1>
          <p class="lead" id="status">${view.status}</p>
          <p class="phase-detail" id="detail">${view.detail}</p>
        </div>
        <div class="steps pairing-only" id="steps">
          <div class="step"><span class="number">1</span><span>Open <strong>WhatsApp</strong> on your phone.</span></div>
          <div class="step"><span class="number">2</span><span>Open <strong>Linked Devices</strong> and choose <strong>Link a device</strong>.</span></div>
          <div class="step"><span class="number">3</span><span>Scan this QR and keep WhatsApp open.</span></div>
        </div>
        <p class="safety pairing-only"><strong>Private by design.</strong> This QR is served only on this computer.</p>
      </section>
      <section class="qr-panel pairing-only" id="qr-panel" aria-label="Private pairing QR">
        <div class="qr-label"><span>Scan with WhatsApp</span><span class="local">Local only</span></div>
        ${qr}
      </section>
    </div>
  </main>
</body>
</html>`;
}

export const PAIRING_POLL_SCRIPT = `(() => {
  const main = document.querySelector("main");
  const badge = document.querySelector("#badge");
  const title = document.querySelector("#title");
  const status = document.querySelector("#status");
  const detail = document.querySelector("#detail");
  const qr = document.querySelector("#qr");
  if (!main || !badge || !title || !status || !detail || !qr) return;

  let version = Number(qr.dataset.version);
  let stopped = false;
  let failures = 0;
  const clearQr = () => {
    qr.removeAttribute("src");
    qr.hidden = true;
  };
  const render = (phase) => {
    main.dataset.phase = phase;
    main.setAttribute("aria-busy", phase === "finalizing" ? "true" : "false");
    if (phase === "pairing") return;
    clearQr();
    if (phase === "finalizing") {
      badge.textContent = "Connecting";
      title.textContent = "Finishing WhatsApp login";
      status.textContent = "Keep WhatsApp open on your phone while this computer finishes linking.";
      detail.textContent = "This usually takes a moment.";
      return;
    }
    stopped = true;
    if (phase === "linked") {
      badge.textContent = "Connected";
      title.textContent = "WhatsApp linked";
      status.textContent = "Safe WhatsApp is ready on this computer.";
      detail.textContent = "You can close this private local tab.";
      return;
    }
    if (phase === "failed") {
      badge.textContent = "Not connected";
      title.textContent = "WhatsApp couldn’t link";
      status.textContent = "Run safewhatsapp connect again to retry.";
      detail.textContent = "The terminal has the specific error and next step.";
      return;
    }
    badge.textContent = "Page closed";
    title.textContent = "Pairing page closed";
    status.textContent = "Run safewhatsapp connect again if WhatsApp is not linked.";
    detail.textContent = "This private page no longer has access to a pairing QR.";
  };
  const poll = async () => {
    try {
      const response = await fetch("./state.json", { cache: "no-store" });
      if (!response.ok) throw new Error("state unavailable");
      const state = await response.json();
      if (!["pairing", "finalizing", "linked", "failed"].includes(state.phase) ||
          !Number.isSafeInteger(state.version) || state.version < 1) {
        throw new Error("invalid state");
      }
      if (state.phase === "pairing" && state.version !== version) {
        version = state.version;
        qr.dataset.version = String(version);
        qr.src = "./qr.png?v=" + version;
      }
      failures = 0;
      render(state.phase);
    } catch {
      failures += 1;
      if (failures >= 3) render("closed");
    }
    if (!stopped) setTimeout(poll, failures > 0 ? 500 : 1000);
  };
  setTimeout(poll, 1000);
})();`;
