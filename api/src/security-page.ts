// The Security page: what the design does for you, what it does not, in plain
// words and a picture per idea. It is deliberately short: a security page nobody
// reads protects nobody.

import { FAVICON } from "./ui-css";
import { LANDING_CSS } from "./landing-page";

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3z"/></svg>';

export const SECURITY_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Security</title>
    <link rel="icon" href="__FAVICON__" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
    <style>
__CSS__
      /* One connection, drawn top to bottom: the machine reaches out, and only
         the client it allows comes back down the same line. */
      .chain { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin: 20px 0; font-size: 12px; }
      .chain .n { border: 1px solid #111; padding: 8px 12px; font-weight: 600; }
      .chain .n.quiet { font-weight: 400; color: #666; }
      .chain .arr { color: #999; font-size: 11px; padding-left: 12px; }
      .sealed { border: 1px solid #111; padding: 12px 14px; margin: 20px 0; font-size: 12px; }
      .sealed-top { display: flex; align-items: center; gap: 8px; font-weight: 700; }
      .sealed-top svg { width: 15px; height: 15px; fill: #16a34a; }
      .sealed-text { color: #666; margin-top: 6px; }
      .sealed-key { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 11px; color: #999; }
      .sealed-key .k { color: #16a34a; font-weight: 600; }
      h2 { font-size: 13px; font-weight: 700; margin: 26px 0 6px; }
      .limit { border-left: 4px solid #b91c1c; padding: 2px 0 2px 12px; margin: 22px 0 0; }
      .meta { margin-top: 26px; font-size: 10px; color: #999; }
      .meta a { color: #999; }
      .foot { margin-top: 14px; }
      .foot a { color: #999; display: inline-flex; align-items: center; }
      .foot svg { width: 18px; height: 18px; fill: currentColor; }
    </style>
  </head>
  <body>
    <h1>Security</h1>
    <div class="sub">what it does, and what it cannot</div>
    <p class="desc">Prime keeps a small door instead of a wide one. Nothing on your machine listens to the network; the only connections are ones it makes itself, and they last only while it is running.</p>

    <div class="chain">
      <span class="n">your machine</span>
      <span class="arr">&darr; one connection out</span>
      <span class="n">gateway</span>
      <span class="arr">&uarr; answered only to</span>
      <span class="n quiet">the client you allow</span>
    </div>

    <h2>Every request is proved</h2>
    <p class="desc">A buddy is an ID and a token. The gateway checks the pair before it moves anything, and a request that does not match gets a refusal and nothing else - it cannot even tell a real ID from a made-up one. A revoked token stops working at the next request.</p>

    <h2>The gateway carries, it does not read</h2>
    <p class="desc">What is stored for a buddy or a space is sealed for that space's own key, and the key never leaves the machine it belongs to. The gateway holds ciphertext: it can lose it or refuse to pass it on, but it cannot open it.</p>

    <div class="sealed">
      <div class="sealed-top">__LOCK__ sealed for your key</div>
      <div class="sealed-text">What the gateway keeps for a space is a box with no lid it can undo.</div>
      <div class="sealed-key"><span class="k">the key</span> stays with the space, on your machine</div>
    </div>

    <h2>A space is contained</h2>
    <p class="desc">A space runs rootless, in its own network, with no folder of yours mounted into it, no docker socket shared with it, and cpu and memory limits it cannot lift. Root inside a space is not root on the machine it runs on.</p>

    <h2>A fleet is the same work in several places</h2>
    <p class="desc">Each space in a fleet is sealed for its own key, so one compromised machine does not hand over the others. Whoever is in charge is decided by a short lease, and a space that has stopped stops being in charge.</p>

    <div class="limit">
      <p class="desc" style="margin:0"><b>What this does not do.</b> Nothing here helps with a machine that is already compromised. A buddy is its machine. Keep the token - and the machine - as carefully as you keep the work on it.</p>
    </div>

    <p class="meta"><a href="/connect">Set up a buddy</a> &middot; <a href="/join">Join a fleet</a></p>
    <div class="foot">
      <a href="https://github.com/Tuanm/prime" aria-label="Source on GitHub">__ICON__</a>
    </div>
  </body>
</html>
`.replace("__FAVICON__", FAVICON).replace("__CSS__", LANDING_CSS).replace("__LOCK__", LOCK_ICON).replace("__ICON__", GITHUB_ICON);
