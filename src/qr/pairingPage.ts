// Agent context note: Renders the self-contained branded pairing/status page and its same-origin poller. Tests: test/browser-qr.test.mjs plus visual browser verification. Keep it free of remote assets, inline scripts, QR transforms/filters, and user-controlled HTML; update this note after meaningful changes.
export type PairingPhase = "pairing" | "finalizing" | "linked" | "failed";

const PAGE_VIEWS: Record<PairingPhase, { badge: string; title: string; status: string; detail: string }> = {
  pairing: {
    badge: "Ready to scan",
    title: "Connect your WhatsApp",
    status: "Link this computer from WhatsApp on your phone.",
    detail: "The QR refreshes here automatically when WhatsApp rotates it.",
  },
  finalizing: {
    badge: "QR accepted",
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
    :root { color-scheme: light; --ink: #24211d; --muted: #6f675d; --line: #ded5c9; --paper: #fffdf9; --accent: #1e9a67; }
    * { box-sizing: border-box; }
    html { min-height: 100%; background: #e9e1d6; font: 16px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 24px; color: var(--ink); background: radial-gradient(circle at 12% 5%, #fff9ee 0, transparent 36%), radial-gradient(circle at 88% 90%, #d8eee4 0, transparent 35%), linear-gradient(145deg, #eee5d9, #e6ded3); }
    main { width: min(980px, 100%); overflow: hidden; border: 1px solid #ffffffa8; border-radius: 28px; background: #fffaf3e8; box-shadow: 0 28px 90px #51483b24, 0 2px 8px #51483b12; backdrop-filter: blur(18px); }
    .topbar { min-height: 68px; padding: 16px 22px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); }
    .brand { display: flex; align-items: center; gap: 11px; font-size: 14px; font-weight: 720; letter-spacing: -.01em; }
    .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px; color: white; background: linear-gradient(145deg, #29b979, #137a52); box-shadow: 0 8px 18px #16845838; font-size: 13px; letter-spacing: -.04em; }
    .byline { color: var(--muted); font-size: 13px; }
    .badge { margin-bottom: 22px; display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border: 1px solid #acd7c4; border-radius: 999px; color: #176844; background: #e9f7ef; font-size: 12px; font-weight: 700; }
    .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px #31ae7540; }
    .content { padding: clamp(24px, 5vw, 54px); display: grid; grid-template-columns: minmax(0, .9fr) minmax(360px, 1.1fr); gap: clamp(28px, 5vw, 58px); align-items: center; }
    .eyebrow { margin: 0 0 14px; color: #257954; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 560px; font-size: clamp(34px, 5vw, 58px); line-height: .98; letter-spacing: -.052em; }
    .lead { margin: 22px 0 0; max-width: 540px; color: var(--muted); font-size: clamp(17px, 2vw, 20px); line-height: 1.45; }
    .steps { margin-top: 30px; display: grid; gap: 12px; }
    .step { display: grid; grid-template-columns: 28px 1fr; gap: 11px; align-items: start; color: #49433c; font-size: 14px; }
    .number { width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid #cfc4b7; border-radius: 9px; background: #fff; font-size: 12px; font-weight: 800; }
    .safety { margin: 30px 0 0; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
    .safety strong { color: var(--ink); font-weight: 700; }
    .qr-panel { justify-self: stretch; min-width: 0; padding: 18px; border: 1px solid #dedede; border-radius: 22px; background: #fff; box-shadow: 0 16px 42px #40372c17; }
    .qr-label { margin: 2px 0 14px; display: flex; align-items: center; justify-content: space-between; color: #797167; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .local { display: inline-flex; align-items: center; gap: 6px; color: #287552; letter-spacing: 0; text-transform: none; }
    .local::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #29a46d; }
    img { display: block; width: auto; max-width: 100%; height: auto; max-height: 66vh; margin: 0 auto; image-rendering: pixelated; }
    footer { min-height: 56px; padding: 16px 22px; border-top: 1px solid var(--line); color: var(--muted); text-align: center; font-size: 13px; }
    [hidden] { display: none !important; }
    main:not([data-phase="pairing"]) .content { grid-template-columns: 1fr; min-height: 390px; text-align: center; }
    main:not([data-phase="pairing"]) .copy { display: grid; justify-items: center; }
    main:not([data-phase="pairing"]) .pairing-only { display: none; }
    main[data-phase="finalizing"] .badge::before { animation: pulse 1.15s ease-in-out infinite; }
    main[data-phase="linked"] .badge { border-color: #9fd4bd; color: #12603e; background: #e2f6ea; }
    main[data-phase="failed"] .badge, main[data-phase="closed"] .badge { border-color: #dfbeb8; color: #8a3c31; background: #faece9; }
    main[data-phase="failed"] .badge::before, main[data-phase="closed"] .badge::before { background: #be5a4b; box-shadow: none; }
    @keyframes pulse { 50% { opacity: .38; transform: scale(.72); } }
    @media (max-width: 760px) {
      body { padding: 12px; place-items: start center; }
      main { margin: 12px 0; border-radius: 22px; }
      .topbar { padding: 14px 16px; }
      .byline { display: none; }
      .content { padding: 26px 18px 22px; grid-template-columns: 1fr; gap: 24px; }
      h1 { font-size: clamp(34px, 12vw, 48px); }
      .steps { margin-top: 22px; }
      .safety { margin-top: 22px; }
      .qr-panel { width: 100%; padding: 13px; border-radius: 18px; }
      img { max-height: 54vh; }
    }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  </style>${script}
</head>
<body>
  <main data-phase="${phase}" aria-live="polite">
    <header class="topbar">
      <div class="brand"><span class="mark" aria-hidden="true">SW</span><span>Safe WhatsApp</span></div>
      <span class="byline">Local MCP by Bliss AI</span>
    </header>
    <div class="content">
      <section class="copy" aria-labelledby="title">
        <p class="eyebrow">Personal WhatsApp · On this computer</p>
        <span class="badge" id="badge">${view.badge}</span>
        <h1 id="title">${view.title}</h1>
        <p class="lead" id="status">${view.status}</p>
        <div class="steps pairing-only" id="steps">
          <div class="step"><span class="number">1</span><span>Open <strong>WhatsApp</strong> on your phone.</span></div>
          <div class="step"><span class="number">2</span><span>Go to <strong>Settings → Linked Devices → Link a device</strong>.</span></div>
          <div class="step"><span class="number">3</span><span>Scan the QR shown here.</span></div>
        </div>
        <p class="safety"><strong>Private by design.</strong> Reads sync on demand. Sending still requires your confirmation.</p>
      </section>
      <section class="qr-panel pairing-only" id="qr-panel" aria-label="Private pairing QR">
        <div class="qr-label"><span>Scan with WhatsApp</span><span class="local">Local only</span></div>
        ${qr}
      </section>
    </div>
    <footer id="detail">${view.detail}</footer>
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
    if (phase === "pairing") return;
    clearQr();
    if (phase === "finalizing") {
      badge.textContent = "QR accepted";
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
