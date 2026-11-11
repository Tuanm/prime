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
      /* The picture is drawn with the marks the admin page uses: a status dot
         outside the card, a square card with a 1px rule, and a green 2px rule
         for the space that is in charge. */
      .arch { margin: 26px 0; }
      .a-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
      .a-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
      .a-dot.on { background: #16a34a; }
      .a-dot.off { background: #fff; border: 1.5px solid #b91c1c; }
      .a-cloud { width: 12px; height: 12px; flex: none; color: #111; }
      .a-cloud svg { display: block; width: 100%; height: 100%; fill: currentColor; }
      .a-box {
        position: relative;
        flex: 1;
        display: flex;
        align-items: center;
        border: 1px solid #111;
        background: #fff;
        padding: 8px 10px;
        font-size: 12px;
      }
      .a-name { font-weight: 700; }
      /* The tag is pinned to the right edge, so it reads in the same place on
         every card whatever it says - and the tags that are hidden by the
         animation do not push the one that is showing about. */
      .a-tag {
        position: absolute;
        right: 10px;
        font-size: 11px;
        color: #666;
        transition: none;
      }
      .a-leaves { list-style: none; margin: 8px 0 0; padding: 0 0 0 24px; }
      .a-leaves > li { margin-bottom: 8px; }

      /* From the person to the fleet: the dashes keep moving, because the
         requests do - including while a space changes places. */
      .a-flow {
        width: 2px;
        height: 26px;
        margin: -2px 0 8px 5px;
        background-image: repeating-linear-gradient(180deg, #111 0 4px, transparent 4px 9px);
        background-size: 2px 9px;
        animation: a-dash 0.8s linear infinite;
      }
      @keyframes a-dash {
        from { background-position: 0 0; }
        to { background-position: 0 9px; }
      }

      /* What the picture shows when nothing is moving - and therefore what a
         reader who asked for no motion sees: alpha in charge, the others in
         step, no delta yet. */
      .a-alpha .a-box { border: 2px solid #16a34a; background: #f0fdf4; padding: 7px 9px; }
      .a-alpha .a-tag.charge { opacity: 1; }
      .a-alpha .a-tag.stopped,
      .a-alpha .a-tag.step,
      .a-beta .a-tag.charge,
      .a-delta .a-tag.joining,
      .a-delta .a-tag.step { opacity: 0; }

      /* The loop: one space stops, another takes over, a new one joins, the
         stopped one comes back. Sixteen seconds, then again. */
      .a-alpha .a-dot { animation: a-alpha-dot 16s ease-in-out infinite; }
      .a-alpha .a-box { animation: a-alpha-box 16s ease-in-out infinite; }
      .a-beta .a-box { animation: a-beta-box 16s ease-in-out infinite; }
      .a-beta .a-tag.charge { animation: a-beta-charge 16s ease-in-out infinite; }
      .a-beta .a-tag.step { animation: a-beta-step 16s ease-in-out infinite; }
      .a-alpha .a-tag.charge { animation: a-alpha-charge 16s ease-in-out infinite; }
      .a-alpha .a-tag.step { animation: a-alpha-step 16s ease-in-out infinite; }
      .a-alpha .a-tag.stopped { animation: a-alpha-stopped 16s ease-in-out infinite; }
      .a-delta { animation: a-delta-row 16s ease-in-out infinite; }
      .a-delta .a-box { animation: a-delta-box 16s ease-in-out infinite; }
      .a-delta .a-tag.joining { animation: a-delta-joining 16s ease-in-out infinite; }
      .a-delta .a-tag.step { animation: a-delta-step 16s ease-in-out infinite; }

      @keyframes a-alpha-dot {
        0%, 19% { background: #16a34a; border: 0; }
        22%, 52% { background: #fff; border: 1.5px solid #b91c1c; }
        56%, 100% { background: #16a34a; border: 0; }
      }
      @keyframes a-alpha-box {
        0%, 19% { border: 2px solid #16a34a; background: #f0fdf4; padding: 7px 9px; }
        23%, 52% { border: 1px dashed #b91c1c; background: #fff; padding: 8px 10px; color: #999; }
        56%, 86% { border: 1px solid #111; background: #fff; padding: 8px 10px; color: #111; }
        90%, 100% { border: 2px solid #16a34a; background: #f0fdf4; padding: 7px 9px; color: #111; }
      }
      @keyframes a-beta-box {
        0%, 20% { border: 1px solid #111; background: #fff; padding: 8px 10px; }
        24%, 86% { border: 2px solid #16a34a; background: #f0fdf4; padding: 7px 9px; }
        90%, 100% { border: 1px solid #111; background: #fff; padding: 8px 10px; }
      }
      @keyframes a-alpha-charge { 0%, 19% { opacity: 1; } 22%, 86% { opacity: 0; } 90%, 100% { opacity: 1; } }
      @keyframes a-alpha-stopped { 0%, 19% { opacity: 0; } 22%, 52% { opacity: 1; } 56%, 100% { opacity: 0; } }
      @keyframes a-alpha-step { 0%, 19% { opacity: 0; } 22%, 52% { opacity: 0; } 56%, 86% { opacity: 1; } 90%, 100% { opacity: 0; } }
      @keyframes a-beta-charge { 0%, 20% { opacity: 0; } 24%, 86% { opacity: 1; } 90%, 100% { opacity: 0; } }
      @keyframes a-beta-step { 0%, 20% { opacity: 1; } 24%, 86% { opacity: 0; } 90%, 100% { opacity: 1; } }
      @keyframes a-delta-row { 0%, 39% { opacity: 0; height: 0; margin: 0; overflow: hidden; } 43%, 92% { opacity: 1; height: auto; margin-bottom: 8px; } 96%, 100% { opacity: 0; height: 0; margin: 0; overflow: hidden; } }
      @keyframes a-delta-box { 0%, 46% { border: 1px dashed #111; background: #fff; } 50%, 100% { border: 1px solid #111; background: #fff; } }
      @keyframes a-delta-joining { 0%, 46% { opacity: 1; } 50%, 100% { opacity: 0; } }
      @keyframes a-delta-step { 0%, 46% { opacity: 0; } 50%, 92% { opacity: 1; } 96%, 100% { opacity: 0; } }

      /* Nothing moves for a reader who asked for no motion: it stops on the
         first frame, with alpha in charge. */
      @media (prefers-reduced-motion: reduce) {
        .arch * { animation: none !important; }
        .a-delta { display: none; }
      }

      .legend { font-size: 11px; color: #999; margin-top: 12px; }
      .steps { margin: 20px 0 0; border-top: 1px solid #eee; }
      .steps li { list-style: none; padding: 10px 0; border-bottom: 1px solid #eee; }
      .steps b { font-weight: 700; }
      .steps span { color: #666; }
      .meta { margin-top: 26px; font-size: 10px; color: #999; }
      .meta a { color: #999; }
      .foot { margin-top: 14px; }
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

    <div class="arch">
      <div class="a-row">
        <span class="a-dot on"></span>
        <div class="a-box"><span class="a-name">only you</span><span class="a-tag">requests</span></div>
      </div>
      <div class="a-flow"></div>
      <div class="a-row">
        <span class="a-cloud"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg></span>
        <div class="a-box"><span class="a-name">acme</span><span class="a-tag">a fleet</span></div>
      </div>
      <ul class="a-leaves">
        <li class="a-alpha">
          <div class="a-row">
            <span class="a-dot on"></span>
            <div class="a-box">
              <span class="a-name">alpha</span>
              <span class="a-tag charge">in charge</span>
              <span class="a-tag stopped">stopped</span>
              <span class="a-tag step">in step</span>
            </div>
          </div>
        </li>
        <li class="a-beta">
          <div class="a-row">
            <span class="a-dot on"></span>
            <div class="a-box">
              <span class="a-name">beta</span>
              <span class="a-tag charge">in charge</span>
              <span class="a-tag step">in step</span>
            </div>
          </div>
        </li>
        <li>
          <div class="a-row">
            <span class="a-dot on"></span>
            <div class="a-box"><span class="a-name">gamma</span><span class="a-tag">in step</span></div>
          </div>
        </li>
        <li class="a-delta">
          <div class="a-row">
            <span class="a-dot on"></span>
            <div class="a-box">
              <span class="a-name">delta</span>
              <span class="a-tag joining">joining</span>
              <span class="a-tag step">in step</span>
            </div>
          </div>
        </li>
      </ul>
      <div class="legend">One space is in charge; the others keep the same work. If it stops, the next one takes over, and a space that was stopped can come back. Requests keep arriving the whole time - that is what the moving dashes are.</div>
    </div>

    <p class="desc">A space is made in a moment and can be kept for as long as you like. Several of them can live on the same machine, and the fleet keeps them all at the same point in the work.</p>

    <ul class="steps">
      <li><b>The operator makes the fleet.</b> <span>It starts empty, and belongs to whoever is admitted first.</span></li>
      <li><b>A space asks to join.</b> <span>It is given a code that works once, and is good for a few minutes.</span></li>
      <li><b>The operator admits it.</b> <span>Nothing joins a fleet unnoticed - the code is an invitation, the operator is the door.</span></li>
      <li><b>It takes its place.</b> <span>First one in is in charge; every one after keeps a copy and waits.</span></li>
    </ul>

    <p class="desc" style="margin-top:20px">The fleet is one address: a job sent to it reaches whichever space is in charge, and the answer comes back the same way. Nobody has to know which machine ran it.</p>

    <p class="meta"><a href="/connect">Set up a buddy</a></p>
    <div class="foot">
      <a href="https://github.com/Tuanm/prime" aria-label="Source on GitHub">__ICON__</a>
    </div>
  </body>
</html>
`.replace("__FAVICON__", FAVICON).replace("__CSS__", LANDING_CSS).replace("__ICON__", GITHUB_ICON);
