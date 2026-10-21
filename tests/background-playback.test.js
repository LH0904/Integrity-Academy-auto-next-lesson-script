/* Run from the extension directory with Node.js or macOS JavaScriptCore. */
(() => {
  const read = typeof readFile === "function"
    ? readFile
    : (path) => require("node:fs").readFileSync(path, "utf8");
  const output = typeof print === "function" ? print : console.log;
  const source = read("background-playback.js");
  const start = new Function("document", "window", "location", "MutationObserver", "CustomEvent", source);
  new Function(read("content.js")); // Parse the isolated-world script too.
  const manifest = JSON.parse(read("manifest.json"));
  let checks = 0;
  function assert(condition, message) {
    if (!condition) throw new Error(message);
    checks += 1;
  }

  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) {
      event.target = this;
      for (const callback of [...(this.listeners.get(event.type) || [])]) callback(event);
    }
  }
  class CustomEventStub {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const CONTROL = "cx-autonext-background-control-v1";
  const STATE = "cx-autonext-background-state-v1";
  function fixture(initiallyMounted = true) {
    const document = new Target();
    const window = new Target();
    const location = { pathname: "/e-training/quality/courselearn" };
    const callbacks = [];
    const states = [];
    document.documentElement = {};
    document.visibilityState = "visible";
    document.addEventListener(STATE, (event) => states.push(event.detail));
    function makeComponent(mounted = true) {
      const component = { _isMounted: mounted, _isDestroyed: false, pauses: 0 };
      component.hanldeVisiblityChange = (event) => {
        if (event.target.visibilityState === "hidden") component.pauses += 1;
      };
      if (mounted) document.addEventListener("visibilitychange", component.hanldeVisiblityChange);
      return component;
    }
    let component = makeComponent(initiallyMounted);
    document.querySelector = () => ({ __vue__: component });
    class Observer {
      constructor(callback) { callbacks.push(callback); }
      observe() {}
    }
    start(document, window, location, Observer, CustomEventStub);
    return {
      document, window, location, states,
      get component() { return component; },
      command(enabled) {
        document.dispatchEvent(new CustomEventStub(CONTROL, { detail: enabled ? "enable" : "disable" }));
      },
      hide() {
        document.visibilityState = "hidden";
        document.dispatchEvent(new CustomEventStub("visibilitychange"));
      },
      mutate() { callbacks.forEach((callback) => callback()); },
      replace() {
        component._isDestroyed = true;
        document.removeEventListener("visibilitychange", component.hanldeVisiblityChange);
        component = makeComponent();
        this.mutate();
      },
    };
  }

  assert(manifest.version === "1.4.0", "Version must match the packaged release");
  assert(manifest.content_scripts.some((entry) =>
    entry.world === "MAIN" && entry.js.includes("background-playback.js")), "Missing MAIN-world bridge");
  assert(manifest.content_scripts.some((entry) =>
    entry.world !== "MAIN" && entry.js.includes("content.js")), "Settings must remain isolated");

  const f = fixture();
  assert(f.states[0] === "ready", "Bridge must announce readiness");
  f.hide();
  assert(f.component.pauses === 1, "Do not modify the site before receiving settings");
  let otherListenerCalls = 0;
  f.document.addEventListener("visibilitychange", () => { otherListenerCalls += 1; });
  f.command(true);
  f.command(true);
  f.hide();
  assert(f.component.pauses === 1, "Enabled background mode must remove the site pause handler");
  assert(otherListenerCalls === 1, "Other visibility listeners must still run");
  f.mutate();
  assert(f.states.at(-1) === "enabled", "DOM updates must preserve active status");
  f.command(false);
  f.command(false);
  f.hide();
  assert(f.component.pauses === 2, "Disabling must restore exactly one pause listener");
  f.command(true);
  f.window.dispatchEvent(new CustomEventStub("pagehide"));
  f.hide();
  assert(f.component.pauses === 3, "Leaving the page must restore its original handler");
  f.window.dispatchEvent(new CustomEventStub("pageshow"));
  f.hide();
  assert(f.component.pauses === 3, "Restoring a cached page must reapply the preference");
  f.replace();
  f.hide();
  assert(f.component.pauses === 0, "A rebuilt course component must be handled automatically");
  f.location.pathname = "/e-training/quality/lecture_list";
  f.mutate();
  f.hide();
  assert(f.component.pauses === 1, "Navigating away must restore site behavior");
  f.location.pathname = "/e-training/quality/courselearn";
  f.mutate();
  f.hide();
  assert(f.component.pauses === 1, "Returning to the course must reapply background mode");
  f.command(false);
  f.component.hanldeVisiblityChange = null;
  f.command(true);
  assert(f.states.at(-1) === "unsupported", "Missing handlers must be reported without guessing");

  const late = fixture(false);
  late.command(true);
  assert(late.states.at(-1) === "waiting", "Wait for Vue's mounted hook to register its listener");
  late.component._isMounted = true;
  late.document.addEventListener("visibilitychange", late.component.hanldeVisiblityChange);
  late.mutate();
  late.hide();
  assert(late.component.pauses === 0, "A late-mounted component must be patched");
  const count = late.states.length;
  late.command(true);
  assert(late.states.length === count + 1, "Repeated commands must acknowledge state for late clients");
  output(`PASS: ${checks} checks; both scripts parse; manifest and background listener lifecycle verified.`);
})();
