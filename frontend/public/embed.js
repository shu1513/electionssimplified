/*
 * Elections Simplified newsroom embed.
 *
 * Usage (paste where the box should appear):
 *   <script src="https://electionssimplified.com/embed.js"
 *           data-city="austin-tx" data-publisher="your-code"></script>
 *
 * Optional size, in pixels: data-width (240-2000) is the widest the box may
 * be; without it the box fills its container. It always shrinks to fit a
 * narrower screen. data-height is described below.
 *
 * Inserts an iframe of /embed/city/<city> right after the script tag. The
 * box is sized once, when the page first reports its content height (the
 * list with every group closed), up to data-height (pixels, 240-2000,
 * default 480). After that it never changes: readers scroll inside it, so
 * nothing they do moves the rest of the host page. The height message is
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
  var DEFAULT_HEIGHT = 480;
  var MIN_HEIGHT = 240;
  var MIN_WIDTH = 240;
  var MAX_WIDTH = 2000;
  // A short list (a state code with two groups closes to under 200px) must
  // still leave room to read a race or a candidate page inside the box.
  var SMALLEST_BOX = 300;
  var BORDER = 2;
  var MAX_HEIGHT = 2000;
  var city = script.getAttribute("data-city") || "";
  var publisher = script.getAttribute("data-publisher") || "";
  if (!CODE.test(city) || city.length > MAX_CODE_LENGTH) {
    return;
  }
  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch {
    return;
  }
  var src = origin + "/embed/city/" + city;
  if (CODE.test(publisher) && publisher.length <= MAX_CODE_LENGTH) {
    src += "#pub=" + publisher;
  }

  var frame = document.createElement("iframe");
  frame.src = src;
  frame.title = "Election races for this city, from Elections Simplified";
  frame.setAttribute("loading", "lazy");
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.style.display = "block";
  frame.style.width = "100%";
  // A maximum, not a fixed width: a fixed 560px box overflows a phone.
  var width = Number(script.getAttribute("data-width"));
  if (isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) {
    frame.style.maxWidth = Math.round(width) + "px";
  }
  frame.style.boxSizing = "border-box";
  frame.style.border = "1px solid #dddddd";
  frame.style.borderRadius = "8px";
  var height = Number(script.getAttribute("data-height"));
  if (!isFinite(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) {
    height = DEFAULT_HEIGHT;
  }
  var maxHeight = Math.round(height);
  frame.style.height = maxHeight + "px";
  script.parentNode.insertBefore(frame, script.nextSibling);

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
    window.removeEventListener("message", onMessage);
    var fitted = Math.ceil(content) + BORDER;
    frame.style.height = Math.min(maxHeight, Math.max(SMALLEST_BOX, fitted)) + "px";
  }
  window.addEventListener("message", onMessage);
})();
