(() => {
  const PANEL_ID = "cx-autonext-panel-host";
  const VIDEO_SELECTOR = "#rightBox .in-player-panel video";
  const NEXT_SELECTOR = ".progress-count .right .next";
  const PREVIOUS_SELECTOR = ".progress-count .right .last";
  const VERIFY_TIMEOUT_MS = 20000;
  const BACKGROUND_TIMEOUT_MS = 120000;
  const END_POLL_INTERVAL_MS = 1000;
  const CONTROL_EVENT = "cx-autonext-background-control-v1";
  const STATE_EVENT = "cx-autonext-background-state-v1";

  let enabled = true;
  let backgroundPlaybackEnabled = true;
  let settingsReady = false;
  let backgroundState = "waiting";
  let busy = false;
  let runId = 0;
  let observedVideo = null;
  let endPollTimer = null;
  const boundVideos = new WeakSet();
  let host = null;
  let statusNode = null;
  let toggleButton = null;
  let backgroundButton = null;
  let backgroundHint = null;

  document.addEventListener(STATE_EVENT, (event) => {
    if (event.detail === "ready") {
      publishBackgroundSetting();
      return;
    }
    if (!["enabled", "disabled", "waiting", "unsupported"].includes(event.detail)) return;
    backgroundState = event.detail;
    renderBackgroundState();
  });

  chrome.storage.local.get({ enabled: true, backgroundPlaybackEnabled: true }, (data) => {
    enabled = data.enabled !== false;
    backgroundPlaybackEnabled = data.backgroundPlaybackEnabled !== false;
    settingsReady = true;
    renderState();
    publishBackgroundSetting();
  });

  function publishBackgroundSetting() {
    if (!settingsReady) return;
    document.dispatchEvent(new CustomEvent(CONTROL_EVENT, {
      detail: backgroundPlaybackEnabled ? "enable" : "disable",
    }));
  }

  function renderBackgroundState() {
    if (!backgroundButton || !backgroundHint) return;
    backgroundButton.textContent = backgroundPlaybackEnabled ? "后台播放：开启" : "后台播放：关闭";
    backgroundButton.setAttribute("aria-pressed", String(backgroundPlaybackEnabled));
    const hints = {
      enabled: "后台播放已启用；手动暂停仍有效",
      waiting: "正在等待课程播放器",
      unsupported: "当前页面暂不支持后台播放",
      disabled: "后台播放已关闭",
    };
    const hint = hints[backgroundState] || hints.waiting;
    if (backgroundHint.textContent !== hint) backgroundHint.textContent = hint;
  }

  function currentWaitBudget(foregroundMs) {
    return document.hidden && backgroundPlaybackEnabled ? BACKGROUND_TIMEOUT_MS : foregroundMs;
  }

  function currentVideo() {
    return document.querySelector(VIDEO_SELECTOR);
  }

  function currentTitle() {
    return document.querySelector("#rightBox .topBox .title_box h1")?.textContent?.trim() || "";
  }

  function normalizedTitle(title) {
    return title.replace(/^\s*\d+(?:\.\d+)*\s*/, "").trim();
  }

  function durationInSeconds(value) {
    return globalThis.CXAutoNextVideoUtils.durationInSeconds(value);
  }

  function findPreviousButton() {
    const exact = document.querySelector(PREVIOUS_SELECTOR);
    if (exact) return exact;

    const containers = document.querySelectorAll(".progress-count .right");
    for (const container of containers) {
      const children = [...container.children];
      const nextButton = container.querySelector(".next, .next-no-active");
      const isDisabled = (element) => {
        if (!element || element.disabled === true || element.getAttribute("aria-disabled") === "true") return true;
        const classes = typeof element.className === "string" ? element.className : "";
        return /no[-_]?active|disabled/i.test(classes);
      };
      const label = (element) => [element.getAttribute("aria-label"), element.getAttribute("title")]
        .filter(Boolean).join(" ");
      const markedPrevious = children.find((element) => {
        if (isDisabled(element)) return false;
        const classes = typeof element.className === "string" ? element.className : "";
        return /(^|[\s_-])(last|prev|previous)([\s_-]|$)/i.test(classes) || /上/.test(label(element));
      });
      if (markedPrevious) return markedPrevious;

      // The platform renders the previous and next controls as adjacent children.
      // If its previous-control class changes, use the enabled sibling before next.
      const nextIndex = children.indexOf(nextButton);
      if (nextIndex > 0 && !isDisabled(children[nextIndex - 1])) return children[nextIndex - 1];
    }
    return null;
  }

  function findLesson(nodes, title) {
    const target = normalizedTitle(title);
    for (const node of nodes || []) {
      if (node.contentType === "video" && node.name?.trim() === target) return node;
      const found = findLesson(node.sub, title);
      if (found) return found;
    }
    return null;
  }

  async function readLessonCompletion(title) {
    const courseId = new URLSearchParams(location.search).get("courseId");
    if (!courseId) throw new Error("courseId 参数不存在");

    // 公需课（lecture）页面同样用这个接口读取课程树，路由不同但数据源一致。
    const url = `${location.origin}/e-training/api/course/quality/${encodeURIComponent(courseId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), currentWaitBudget(15000));
    let course;
    try {
      const response = await fetch(url, {
        credentials: "include", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error(`课程接口返回 HTTP ${response.status}`);
      course = await response.json();
    } finally {
      clearTimeout(timeout);
    }
    const lesson = findLesson(course.courseTree?.sub, title);
    if (!lesson) throw new Error("课程接口中没有找到当前讲");

    const duration = durationInSeconds(lesson.duration);
    const progress = Number(lesson.isLearned?.learnProgress) || 0;
    const learnedDuration = Number(lesson.isLearned?.learnDuration) || 0;
    const playPercent = duration ? Math.floor(progress / duration * 100) : 0;
    const durationPercent = duration ? learnedDuration / duration * 100 : 0;

    return {
      completed: lesson.isLearned?.isLearned === true && playPercent > 90 && durationPercent >= 90,
      learned: lesson.isLearned?.isLearned === true,
      playPercent,
      durationPercent,
    };
  }

  async function waitForLessonCompletion(title, assertActive) {
    const startedAt = Date.now();
    let latest = null;
    let latestError = null;

    while (true) {
      assertActive();
      try {
        latest = await readLessonCompletion(title);
        latestError = null;
        if (latest.completed) return { result: latest };
      } catch (error) {
        latestError = error;
      }
      assertActive();
      if (Date.now() - startedAt >= currentWaitBudget(VERIFY_TIMEOUT_MS)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return { result: latest, error: latestError };
  }

  async function returnToLesson(title) {
    const previousButton = findPreviousButton();
    if (!previousButton) return false;
    previousButton.click();
    return Boolean(await waitFor(() => currentTitle() === title, 10000));
  }

  function setStatus(message) {
    if (statusNode) statusNode.textContent = message;
  }

  function renderState() {
    if (!toggleButton) return;
    toggleButton.textContent = enabled ? "自动续播：开启" : "自动续播：暂停";
    toggleButton.setAttribute("aria-pressed", String(enabled));
    renderBackgroundState();
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
        .background { margin-top: 8px; background: #285a86; }
        .status { margin-top: 8px; font-size: 12px; line-height: 1.5; color: #555; }
        .hint { margin-top: 5px; font-size: 11px; line-height: 1.4; color: #888; }
      </style>
      <div class="panel">
        <button class="autonext" type="button" aria-pressed="true">自动续播：开启</button>
        <button class="background" type="button" aria-pressed="true">后台播放：开启</button>
        <div class="status" role="status" aria-live="polite">正在初始化</div>
        <div class="hint">正在等待课程播放器</div>
      </div>`;
    document.body.appendChild(host);
    toggleButton = shadow.querySelector(".autonext");
    backgroundButton = shadow.querySelector(".background");
    backgroundHint = shadow.querySelector(".hint");
    statusNode = shadow.querySelector(".status");
    toggleButton.addEventListener("click", () => {
      enabled = !enabled;
      runId += 1;
      chrome.storage.local.set({ enabled });
      renderState();
      if (!enabled) setStatus("已暂停自动续播");
    });
    backgroundButton.addEventListener("click", () => {
      backgroundPlaybackEnabled = !backgroundPlaybackEnabled;
      chrome.storage.local.set({ backgroundPlaybackEnabled });
      publishBackgroundSetting();
      renderBackgroundState();
    });
    renderState();
  }

  function waitFor(check, timeoutMs, assertActive = () => {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        try { assertActive(); } catch (error) { reject(error); return; }
        let value = false;
        try { value = check(); } catch (_) { /* The page may be replacing the player. */ }
        if (value) return resolve(value);
        if (Date.now() - startedAt >= currentWaitBudget(timeoutMs)) return resolve(null);
        setTimeout(poll, 250);
      };
      poll();
    });
  }

  async function handleEnded(video) {
    if (!settingsReady || !enabled || busy || video !== currentVideo()) return;

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
    const thisRun = ++runId;
    const pageUrl = location.href;
    const assertActive = () => {
      if (!enabled || runId !== thisRun || location.href !== pageUrl) {
        throw new DOMException("续播已取消", "AbortError");
      }
    };
    const oldTitle = currentTitle();
    const oldTime = video.currentTime;
    setStatus("正在切换到下一讲…");

    try {
      nextButton.click();
      const switched = await waitFor(() => {
        return Boolean(oldTitle && currentTitle() && currentTitle() !== oldTitle);
      }, 20000, assertActive);
      assertActive();

      if (!switched) {
        setStatus("切换没有完成，请手动确认课程页面");
        return;
      }

      setStatus("下一讲已切换，正在等待视频加载…");
      const loadedVideo = await waitFor(() => {
        const nextVideo = currentVideo();
        if (!nextVideo) return null;
        const playerChanged = nextVideo !== video;
        const lessonRestarted = currentTitle() !== oldTitle && !nextVideo.ended && nextVideo.currentTime < oldTime;
        if (!playerChanged && !lessonRestarted) return null;
        return nextVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? nextVideo : null;
      }, 20000, assertActive);
      assertActive();

      if (!loadedVideo) {
        setStatus("下一讲已切换，视频仍未就绪；可手动点击播放");
        return;
      }

      setStatus("正在核对平台保存的播放进度和累计时长…");
      const verification = await waitForLessonCompletion(oldTitle, assertActive);
      assertActive();
      if (!verification.result?.completed) {
        const returned = await returnToLesson(oldTitle);
        assertActive();
        if (!verification.result) {
          setStatus(returned
            ? "暂时无法读取平台学习记录，已返回本讲并停止续播"
            : "暂时无法读取平台学习记录，自动续播已停止");
        } else {
          const { playPercent, durationPercent } = verification.result;
          setStatus(returned
            ? `平台尚未确认本讲完成（进度 ${playPercent}%，时长 ${Math.floor(durationPercent)}%）；已返回本讲并停止续播`
            : `平台尚未确认本讲完成（进度 ${playPercent}%，时长 ${Math.floor(durationPercent)}%）；自动续播已停止`);
        }
        return;
      }

      assertActive();
      if (loadedVideo !== currentVideo()) return;
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
    } catch (error) {
      if (error.name !== "AbortError") setStatus("续播遇到异常，请检查课程页面");
    } finally {
      busy = false;
    }
  }

  function bindVideo() {
    const video = currentVideo();
    if (!video || video === observedVideo) return;
    observedVideo = video;
    if (boundVideos.has(video)) return;
    boundVideos.add(video);
    video.addEventListener("ended", () => handleEnded(video));
  }

  function startEndPoller() {
    if (endPollTimer) return;
    endPollTimer = setInterval(() => {
      if (!settingsReady || !enabled || busy) return;
      const video = currentVideo();
      if (video && globalThis.CXAutoNextVideoUtils.hasReachedEnd(video)) void handleEnded(video);
    }, END_POLL_INTERVAL_MS);
  }

  function initialize() {
    if (!globalThis.CXAutoNextVideoUtils.isCourseLearnPage(location.pathname)) {
      host?.remove();
      host = null;
      statusNode = null;
      toggleButton = null;
      backgroundButton = null;
      backgroundHint = null;
      if (endPollTimer) clearInterval(endPollTimer);
      endPollTimer = null;
      return;
    }
    mountPanel();
    bindVideo();
    startEndPoller();
  }

  const observer = new MutationObserver(() => {
    initialize();
    bindVideo();
  });
  // A user's navigation takes priority over a pending automatic transition.
  document.addEventListener("click", (event) => {
    if (event.isTrusted && event.target instanceof Element &&
        event.target.closest("#leftBox, .progress-count .right")) runId += 1;
  }, true);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  initialize();
})();
