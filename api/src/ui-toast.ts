// A page's way of saying something happened.
//
// Every page that can report a result uses the same toast: a short dark note in
// the corner that leaves on its own, in the weights the rest of the interface
// uses - a green edge for something that worked, a red one for something that
// did not. A line of text under the page is not used for this any more: it stayed
// there after the thing it described was long gone.

/** The holder the toasts land in. Put it in the page, as the last body child. */
export const TOASTS_HTML = '<div class="toasts" id="toasts"></div>';

/** The function behind it, for a page that builds its script as strings. */
export const TOAST_SCRIPT = `
        function toast(text, variant) {
          var holder = document.getElementById("toasts");
          if (!holder) return;
          var msg = String(text == null ? "" : text).slice(0, 300);
          if (!msg) return;
          var t = document.createElement("div");
          t.className = "toast " + (variant === "error" ? "error" : "success");
          t.textContent = msg;
          holder.appendChild(t);
          // A few at a time is enough: the oldest goes when the list grows.
          while (holder.children.length > 4) holder.removeChild(holder.children[0]);
          setTimeout(function () {
            t.classList.add("leaving");
            setTimeout(function () {
              if (t.parentNode) t.parentNode.removeChild(t);
            }, 300);
          }, variant === "error" ? 6000 : 3500);
        }
`;
