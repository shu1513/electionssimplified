/*
 * Elections Simplified newsroom embed.
 *
 * Usage (paste where the box should appear):
 *   <script src="https://electionssimplified.com/embed.js"
 *           data-city="austin-tx" data-publisher="your-code"></script>
 *
 * Inserts an iframe of /embed/city/<city> right after the script tag and
 * grows it to fit its content. The publisher code rides in the URL fragment
 * so the framed page can be cached once for every publisher; the page reads
 * it in the browser and tags its outbound links. Height messages are only
 * honoured when they come from our origin and from this iframe's window.
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
  frame.setAttribute("scrolling", "no");
  frame.setAttribute("loading", "lazy");
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.style.display = "block";
  frame.style.width = "100%";
  frame.style.border = "0";
  frame.style.height = "480px";
  script.parentNode.insertBefore(frame, script.nextSibling);

  window.addEventListener("message", function (event) {
    if (event.origin !== origin || event.source !== frame.contentWindow) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== "es-embed-height") {
      return;
    }
    var height = Number(data.height);
    if (!isFinite(height) || height < 100 || height > 20000) {
      return;
    }
    frame.style.height = Math.ceil(height) + "px";
  });
})();
