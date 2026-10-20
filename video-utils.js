globalThis.CXAutoNextVideoUtils = Object.freeze({
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
