(() => {
  const PANEL_ID = "cx-autonext-panel-host";
  const VIDEO_SELECTOR = "#rightBox .in-player-panel video";
  const NEXT_SELECTOR = ".progress-count .right .next";

  let enabled = true;
  let busy = false;
  let observedVideo = null;
  let host = null;
  let statusNode = null;
  let toggleButton = null;

  chrome.storage.local.get({ enabled: true }, (data) => {
    enabled = data.enabled !== false;
    renderState();
  });

  function currentVideo() {
    return document.querySelector(VIDEO_SELECTOR);
  }

  function currentTitle() {
    return document.querySelector("#rightBox .topBox .title_box h1")?.textContent?.trim() || "";
  }

  function setStatus(message) {
    if (statusNode) statusNode.textContent = message;
  }

  function renderState() {
    if (!toggleButton) return;
    toggleButton.textContent = enabled ? "自动续播：开启" : "自动续播：暂停";
    toggleButton.setAttribute("aria-pressed", String(enabled));
    if (!busy) setStatus(enabled ? "等待本讲播放结束" : "已暂停自动续播");
  }

  function mountPanel() {
    if (host?.isConnected || !document.body) return;

    host = document.createElement("div");
    host.id = PANEL_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; z-index: 2147483647; right: 18px; top: 18px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .panel { width: 210px; padding: 12px; border: 1px solid #ddd; border-radius: 10px; background: #fff; color: #222; box-shadow: 0 3px 14px #0002; }
        button { width: 100%; border: 0; border-radius: 7px; padding: 9px 10px; background: #c91520; color: white; font-size: 13px; cursor: pointer; }
        button[aria-pressed="false"] { background: #666; }
        .status { margin-top: 8px; font-size: 12px; line-height: 1.5; color: #555; }
        .hint { margin-top: 5px; font-size: 11px; line-height: 1.4; color: #888; }
      </style>
      <div class="panel">
        <button type="button" aria-pressed="true">自动续播：开启</button>
        <div class="status" role="status" aria-live="polite">正在初始化</div>
        <div class="hint">保持课程页面在前台播放</div>
      </div>`;
    document.body.appendChild(host);
    toggleButton = shadow.querySelector("button");
    statusNode = shadow.querySelector(".status");
    toggleButton.addEventListener("click", () => {
      enabled = !enabled;
      chrome.storage.local.set({ enabled });
      renderState();
    });
    renderState();
  }

  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const poll = () => {
        let value = false;
        try { value = check(); } catch (_) { /* The page may be replacing the player. */ }
        if (value) return resolve(value);
        if (Date.now() - startedAt >= timeoutMs) return resolve(null);
        setTimeout(poll, 250);
      };
      poll();
    });
  }

  async function handleEnded(video) {
    if (!enabled || busy || video !== currentVideo()) return;

    const nextButton = document.querySelector(NEXT_SELECTOR);
    if (!nextButton) {
      if (document.querySelector(".progress-count .right .next-no-active")) {
        setStatus("已到最后一讲");
      } else {
        setStatus("没有找到下一讲按钮，请检查课程页面");
      }
      return;
    }

    busy = true;
    const oldTitle = currentTitle();
    const oldSource = video.currentSrc || video.src;
    const oldTime = video.currentTime;
    setStatus("正在切换到下一讲…");

    try {
      nextButton.click();
      const switched = await waitFor(() => {
        const nextVideo = currentVideo();
        const nextSource = nextVideo?.currentSrc || nextVideo?.src || "";
        return currentTitle() !== oldTitle || nextVideo !== video || (nextSource && nextSource !== oldSource);
      }, 20000);

      if (!switched) {
        setStatus("切换没有完成，请手动确认课程页面");
        return;
      }

      setStatus("下一讲已切换，正在等待视频加载…");
      const loadedVideo = await waitFor(() => {
        const nextVideo = currentVideo();
        const nextSource = nextVideo?.currentSrc || nextVideo?.src || "";
        if (!nextVideo) return null;
        const sourceChanged = Boolean(nextSource && nextSource !== oldSource);
        const playerChanged = nextVideo !== video;
        const lessonRestarted = currentTitle() !== oldTitle && !nextVideo.ended && nextVideo.currentTime < oldTime;
        if (!sourceChanged && !playerChanged && !lessonRestarted) return null;
        return nextVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? nextVideo : null;
      }, 20000);

      if (!loadedVideo) {
        setStatus("下一讲已切换，视频仍未就绪；可手动点击播放");
        return;
      }

      if (loadedVideo.paused || loadedVideo.ended) {
        try {
          await loadedVideo.play();
          setStatus("下一讲已开始播放");
        } catch (_) {
          setStatus("下一讲已切换，请点击视频上的播放键");
        }
      } else {
        setStatus("下一讲已开始播放");
      }
    } finally {
      setTimeout(() => {
        busy = false;
        if (enabled && statusNode?.textContent === "下一讲已开始播放") {
          setStatus("等待本讲播放结束");
        }
      }, 1200);
    }
  }

  function bindVideo() {
    const video = currentVideo();
    if (!video || video === observedVideo) return;
    observedVideo = video;
    video.addEventListener("ended", () => handleEnded(video));
  }

  function initialize() {
    if (location.pathname !== "/e-training/quality/courselearn") {
      host?.remove();
      host = null;
      statusNode = null;
      toggleButton = null;
      return;
    }
    mountPanel();
    bindVideo();
  }

  const observer = new MutationObserver(() => {
    initialize();
    bindVideo();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  initialize();
})();
