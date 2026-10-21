const COURSE_LEARN_PATH = /^\/e-training\/([^/]+)\/courselearn\/?$/;

globalThis.CXAutoNextVideoUtils = Object.freeze({
  // 平台把课程学习页拆成了几套路由：/e-training/quality/courselearn（专业课）、
  // /e-training/lecture/courselearn（公需课/讲座）。它们加载同一个页面组件、
  // 调用同一个课程接口，所以只按路径形状识别，不再写死 quality。
  courseLearnKind(pathname) {
    const match = COURSE_LEARN_PATH.exec(pathname || "");
    return match ? match[1] : "";
  },

  isCourseLearnPage(pathname) {
    return COURSE_LEARN_PATH.test(pathname || "");
  },

  hasReachedEnd(video) {
    if (!video) return false;
    if (video.ended) return true;

    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);
    return Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime) &&
      video.paused === true && currentTime >= duration - 2;
  },

  durationInSeconds(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : 0;
    if (typeof value !== "string" || !value.trim()) return 0;

    const parts = value.trim().split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  },
});
