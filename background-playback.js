// MAIN world: the page's Vue instance is unavailable in an isolated content script.
(() => {
  "use strict";
  const CONTROL_EVENT = "cx-autonext-background-control-v1";
  const STATE_EVENT = "cx-autonext-background-state-v1";
  let enabled = false;
  let suspended = false;
  let attachment = null;
  let lastState = "";

  function report(state, force = false) {
    if (state === lastState && !force) return;
    lastState = state;
    document.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: state }));
  }

  function restore() {
    if (!attachment) return;
    const { component, handler } = attachment;
    attachment = null;
    if (!component._isDestroyed && component.hanldeVisiblityChange === handler) {
      document.addEventListener("visibilitychange", handler, false);
    }
  }

  function reconcile(force = false) {
    if (!enabled || suspended ||
        location.pathname !== "/e-training/quality/courselearn") {
      restore();
      report("disabled", force);
      return;
    }

    const component = document.querySelector("#courseLearnBox")?.__vue__;
    if (!component || !component._isMounted || component._isDestroyed) {
      restore();
      report("waiting", force);
      return;
    }

    const handler = component.hanldeVisiblityChange;
    if (typeof handler !== "function") {
      restore();
      report("unsupported", force);
      return;
    }

    if (attachment?.component !== component || attachment?.handler !== handler) {
      restore();
      document.removeEventListener("visibilitychange", handler, false);
      attachment = { component, handler };
    }
    report("enabled", force);
  }

  document.addEventListener(CONTROL_EVENT, (event) => {
    if (event.detail !== "enable" && event.detail !== "disable") return;
    enabled = event.detail === "enable";
    reconcile(true);
  });
  const observer = new MutationObserver(() => reconcile());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => {
    suspended = true;
    restore();
  });
  window.addEventListener("pageshow", () => {
    suspended = false;
    reconcile(true);
  });
  // Handshake also covers the isolated script loading before this script.
  report("ready", true);
})();
