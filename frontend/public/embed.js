/*
 * Elections Simplified newsroom embed.
 *
 * Usage (paste where the box should appear):
 *   <script src="https://electionssimplified.com/embed.js"></script>
 *
 * The box opens on the site's landing page: an address search that gives
 * the reader their own ballot, inside the box. Optional:
 *   data-publisher="your-code"  counts readers who came from your page
 *
 * Optional size, in pixels: data-max-width (240-2000) is the widest the box may
 * be; without it the box fills its container. It always shrinks to fit a
 * narrower screen. data-height is described below.
 *
 * Inserts an iframe of /embed right after the script tag. The
 * publisher sets the box's size: data-height (pixels, 240-2000) is its exact
 * height. Without it the box is sized as it loads (it may settle for a
 * couple of seconds), from the page's reported content height (the landing page), between 380 and 600
 * pixels. Either way it never changes after that: readers scroll inside it,
 * so nothing they do moves the rest of the host page. The height message is
 * only honoured when it comes from our origin and from this iframe's window. The publisher code rides in the URL fragment so the framed
 * page can be cached once for every publisher; the page reads it in the
 * browser and tags its outbound links.
 *
 * Plain script on purpose: no build step, runs in any browser a newsroom's
 * readers still use, and does nothing at all if its attributes are invalid.
 */
(function () {
  var script = document.currentScript;
  if (!script || !script.src) {
    return;
  }
  var CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var MAX_CODE_LENGTH = 48;
  var DEFAULT_HEIGHT = 600;
  var MIN_HEIGHT = 240;
  var MIN_WIDTH = 240;
  var MAX_WIDTH = 2000;
  // The box is a small copy of the site (address search, ballot, race and
  // candidate pages), so even a short list leaves room to read those.
  var SMALLEST_BOX = 380;
  var SETTLE_MS = 2500;
  var BORDER = 2;
  var MAX_HEIGHT = 2000;
  var publisher = script.getAttribute("data-publisher") || "";
  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch {
    return;
  }
  var src = origin + "/embed";
  if (CODE.test(publisher) && publisher.length <= MAX_CODE_LENGTH) {
    src += "#pub=" + publisher;
  }

  var frame = document.createElement("iframe");
  frame.src = src;
  frame.title = "Find what is on your ballot, from Elections Simplified";
  frame.setAttribute("loading", "lazy");
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.style.display = "block";
  frame.style.width = "100%";
  // A maximum, not a fixed width: a fixed 560px box overflows a phone.
  var width = Number(script.getAttribute("data-max-width"));
  if (isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) {
    frame.style.maxWidth = Math.round(width) + "px";
  }
  frame.style.boxSizing = "border-box";
  frame.style.border = "1px solid #dddddd";
  frame.style.borderRadius = "8px";
  var height = Number(script.getAttribute("data-height"));
  var fixedHeight = isFinite(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT;
  var maxHeight = fixedHeight ? Math.round(height) : DEFAULT_HEIGHT;
  frame.style.height = maxHeight + "px";
  script.parentNode.insertBefore(frame, script.nextSibling);
  if (fixedHeight) {
    // The publisher chose the height; nothing to fit.
    return;
  }

  var settling = false;
  function onMessage(event) {
    if (event.origin !== origin || event.source !== frame.contentWindow) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== "es-embed-height") {
      return;
    }
    var content = Number(data.height);
    if (!isFinite(content) || content <= 0) {
      return;
    }
    // Settle, then lock: a first measurement can be early (styles or fonts
    // still arriving), so later ones are honoured for a short while after
    // it. From then on the box never changes, whatever the reader does.
    if (!settling) {
      settling = true;
      window.setTimeout(function () {
        window.removeEventListener("message", onMessage);
      }, SETTLE_MS);
    }
    var fitted = Math.ceil(content) + BORDER;
    frame.style.height = Math.min(maxHeight, Math.max(SMALLEST_BOX, fitted)) + "px";
  }
  window.addEventListener("message", onMessage);
})();
