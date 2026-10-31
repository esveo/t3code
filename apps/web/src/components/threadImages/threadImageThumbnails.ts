const THUMBNAIL_WIDTH = 320;
const MAX_CONCURRENT = 4;
const VIDEO_TIMEOUT_MS = 15_000;
// ponytail: fixed cap of small webps; tie it to memory if huge galleries need more.
const MAX_CACHED = 500;

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
let running = 0;

async function firstVideoFrame(src: string): Promise<ImageBitmap> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      // A stalled or undecodable video must not hold its slot.
      const timeout = setTimeout(
        () => reject(new Error("Video frame timed out.")),
        VIDEO_TIMEOUT_MS,
      );
      video.onerror = () => reject(new Error("Video could not be decoded."));
      video.onloadeddata = () => {
        video.currentTime = Math.min(0.1, video.duration / 2 || 0);
      };
      video.onseeked = () => {
        clearTimeout(timeout);
        resolve();
      };
      video.src = src;
    });
    return await createImageBitmap(video, {
      resizeWidth: THUMBNAIL_WIDTH,
      resizeQuality: "medium",
    });
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function imageBitmap(src: string): Promise<ImageBitmap> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Thumbnail source answered ${response.status}.`);
  return createImageBitmap(await response.blob(), {
    resizeWidth: THUMBNAIL_WIDTH,
    resizeQuality: "medium",
  });
}

async function createThumbnail(src: string, kind: "image" | "video"): Promise<string> {
  const bitmap = await (kind === "video" ? firstVideoFrame(src) : imageBitmap(src));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return URL.createObjectURL(await canvas.convertToBlob({ type: "image/webp", quality: 0.8 }));
  } finally {
    bitmap.close();
  }
}

function remember(key: string, url: string) {
  cache.set(key, url);
  if (cache.size <= MAX_CACHED) return;
  const oldest = cache.entries().next().value;
  if (!oldest) return;
  cache.delete(oldest[0]);
  URL.revokeObjectURL(oldest[1]);
}

export function cachedThumbnail(key: string): string | undefined {
  const url = cache.get(key);
  if (url !== undefined) {
    cache.delete(key);
    cache.set(key, url);
  }
  return url;
}

/**
 * A small still decoded off the main thread: an image or GIF's first frame, or a video's. When that
 * fails an image falls back to its original; a video has nothing an `<img>` could show.
 */
export function loadThumbnail(
  key: string,
  src: string,
  kind: "image" | "video",
): Promise<string | null> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    // Newest request first: after a fast scroll, the tiles now on screen go ahead of those passed.
    if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      const url = await createThumbnail(src, kind);
      remember(key, url);
      return url;
    } catch {
      return kind === "video" ? null : src;
    } finally {
      inFlight.delete(key);
      const next = waiting.pop();
      if (next) next();
      else running--;
    }
  })();
  inFlight.set(key, promise);
  return promise;
}
