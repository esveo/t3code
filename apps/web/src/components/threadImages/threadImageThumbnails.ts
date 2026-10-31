const THUMBNAIL_WIDTH = 320;
const MAX_CONCURRENT = 4;
// ponytail: fixed cap of small webps; tie it to memory if huge galleries need more.
const MAX_CACHED = 500;

const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const waiting: Array<() => void> = [];
let running = 0;

async function createThumbnail(src: string): Promise<string> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Thumbnail source answered ${response.status}.`);
  const bitmap = await createImageBitmap(await response.blob(), {
    resizeWidth: THUMBNAIL_WIDTH,
    resizeQuality: "medium",
  });
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

/** A small copy decoded off the main thread; the original when it cannot be fetched or decoded. */
export function loadThumbnail(key: string, src: string): Promise<string> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    // Newest request first: after a fast scroll, the tiles now on screen go ahead of those passed.
    if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      const url = await createThumbnail(src);
      remember(key, url);
      return url;
    } catch {
      return src;
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
