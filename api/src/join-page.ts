// The Join page: what a fleet is, told plainly, with a picture.
//
// The audience is someone who has just been handed a machine and an invite, so
// the page says what a fleet does for them before it says how it is built, and
// it uses the same words throughout: a buddy, a team, a space.

import { FAVICON } from "./ui-css";
import { LANDING_CSS } from "./landing-page";

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

export const JOIN_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Join</title>
    <link rel="icon" href="__FAVICON__" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet" />
    <style>
__CSS__
      .fleet { margin: 26px 0; border: 1px solid #111; padding: 14px; }
      .fleet-name { font-weight: 700; display: flex; align-items: baseline; gap: 8px; }
      .fleet-name .tag { font-weight: 400; font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 0.8px; }
      .spaces { display: flex; gap: 10px; margin-top: 12px; }
      .space { flex: 1; border: 1px solid #111; padding: 10px; }
      .space .n { font-weight: 700; }
      .space .r { font-size: 11px; color: #666; margin-top: 2px; }
      .space.primary { border-width: 2px; border-color: #16a34a; background: #f0fdf4; }
      .space.primary .r { color: #166534; }
      .legend { font-size: 11px; color: #999; margin-top: 10px; }
      .steps { margin: 20px 0 0; border-top: 1px solid #eee; }
      .steps li { list-style: none; padding: 10px 0; border-bottom: 1px solid #eee; }
      .steps b { font-weight: 700; }
      .steps span { color: #666; }
      .meta { margin-top: 26px; font-size: 10px; color: #999; }
      .foot { margin-top: 34px; }
      .foot a { color: #111; }
      .foot svg { width: 18px; height: 18px; fill: currentColor; }
    </style>
  </head>
  <body>
    <h1>Join</h1>
    <div class="sub">bring your spaces together</div>
    <p class="desc">Bring your spaces together in a fleet: one piece of work, kept in step on every machine you trust, so it is never in only one place and never waits for one machine to come back.</p>

    <p class="desc">A fleet is a small team of spaces. At any moment exactly one of them is in charge - the one holding what the fleet calls the <b>lease</b>. That one does the writing. The others keep an identical copy and wait their turn.</p>

    <p class="desc">When the one in charge goes quiet, the lease runs out and another steps up. It already has the work, so there is nothing to catch up on: the fleet carries on from where it was.</p>

    <div class="fleet">
      <div class="fleet-name">acme <span class="tag">a fleet</span></div>
      <div class="spaces">
        <div class="space primary">
          <div class="n">alpha</div>
          <div class="r">in charge</div>
        </div>
        <div class="space">
          <div class="n">beta</div>
          <div class="r">same work, waiting</div>
        </div>
        <div class="space">
          <div class="n">gamma</div>
          <div class="r">same work, waiting</div>
        </div>
      </div>
      <div class="legend">One writes; the others follow. When alpha stops, beta takes over.</div>
    </div>

    <p class="desc">A space is made in a moment and can be kept for as long as you like. Several of them can live on the same machine, and the fleet keeps them all at the same point in the work.</p>

    <ul class="steps">
      <li><b>The operator makes the fleet.</b> <span>It starts empty, and belongs to whoever is admitted first.</span></li>
      <li><b>A space asks to join.</b> <span>It is given a code that works once, and is good for a few minutes.</span></li>
      <li><b>The operator admits it.</b> <span>Nothing joins a fleet unnoticed - the code is an invitation, the operator is the door.</span></li>
      <li><b>It takes its place.</b> <span>First one in is in charge; every one after keeps a copy and waits.</span></li>
    </ul>

    <p class="desc" style="margin-top:20px">The fleet is one address: a job sent to it reaches whichever space is in charge, and the answer comes back the same way. Nobody has to know which machine ran it.</p>

    <p class="meta"><a href="/connect">Set up a buddy</a> &middot; <a href="https://github.com/Tuanm/prime/blob/main/docs/fleets.md">The full picture</a></p>
    <div class="foot">
      <a href="https://github.com/Tuanm/prime" aria-label="Source on GitHub">__ICON__</a>
    </div>
  </body>
</html>
`.replace("__FAVICON__", FAVICON).replace("__CSS__", LANDING_CSS).replace("__ICON__", GITHUB_ICON);
