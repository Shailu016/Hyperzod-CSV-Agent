import { NextResponse } from "next/server";

const MAX_URLS = 50;
const CONCURRENCY = 5;
const MAX_BYTES = 100_000; // only need image headers

export async function POST(request: Request) {
  try {
    const { imageUrls } = (await request.json()) as {
      imageUrls: string[];
    };

    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      return NextResponse.json(
        { error: "Provide an array of image URLs" },
        { status: 400 }
      );
    }
    if (imageUrls.length > MAX_URLS) {
      return NextResponse.json(
        { error: `Too many URLs — max ${MAX_URLS}` },
        { status: 400 }
      );
    }

    const results: unknown[] = [];
    const queue = [...imageUrls];

    async function worker() {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) continue;
        results.push(await inspectUrl(url));
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)
    );

    return NextResponse.json({ results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function inspectUrl(url: string): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, source: "invalid", width: null, height: null, isSquare: null, fixedUrl: url, needsFix: false, note: "Invalid URL" };
  }

  // SSRF guard: HTTPS only, no credentials, no internal hosts
  if (parsed.protocol !== "https:") {
    return { url, source: "blocked", width: null, height: null, isSquare: null, fixedUrl: url, needsFix: false, note: "HTTPS required" };
  }
  if (parsed.username || parsed.password) {
    return { url, source: "blocked", width: null, height: null, isSquare: null, fixedUrl: url, needsFix: false, note: "Credentials not allowed" };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "169.254.169.254"
  ) {
    return { url, source: "blocked", width: null, height: null, isSquare: null, fixedUrl: url, needsFix: false, note: "Blocked host" };
  }

  // Unsplash: fixable via URL params
  if (host.endsWith("unsplash.com")) {
    return inspectUnsplash(parsed);
  }

  return inspectGeneric(parsed);
}

function inspectUnsplash(u: URL): unknown {
  const w = parseInt(u.searchParams.get("w") || "", 10) || null;
  const h = parseInt(u.searchParams.get("h") || "", 10) || null;
  const square = w !== null && h !== null && w === h;

  const fixed = new URL(u.toString());
  fixed.searchParams.set("w", "600");
  fixed.searchParams.set("h", "600");
  fixed.searchParams.set("fit", "crop");

  return {
    url: u.toString(),
    source: "unsplash",
    width: w,
    height: h,
    isSquare: square,
    fixedUrl: square ? u.toString() : fixed.toString(),
    needsFix: !square,
  };
}

async function inspectGeneric(u: URL): Promise<unknown> {
  try {
    const res = await fetch(u, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 300 && res.status < 400) {
      return { url: u.toString(), source: "redirect", width: null, height: null, isSquare: null, fixedUrl: u.toString(), needsFix: false, note: `Redirect ${res.status} — not followed` };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return { url: u.toString(), source: "not-image", width: null, height: null, isSquare: null, fixedUrl: u.toString(), needsFix: false, note: `Content-Type: ${contentType}` };
    }

    // Read only the first bytes to extract dimensions
    const reader = res.body?.getReader();
    if (!reader) {
      return { url: u.toString(), source: "unknown", width: null, height: null, isSquare: null, fixedUrl: u.toString(), needsFix: false };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    reader.releaseLock();
    const buf = Buffer.concat(chunks);

    const dims = extractDimensions(buf);
    if (dims) {
      return {
        url: u.toString(),
        source: "fetched",
        width: dims.width,
        height: dims.height,
        isSquare: dims.width === dims.height,
        fixedUrl: u.toString(),
        needsFix: dims.width !== dims.height,
        ratio: `${dims.width}x${dims.height}`,
      };
    }
    return { url: u.toString(), source: "unknown", width: null, height: null, isSquare: null, fixedUrl: u.toString(), needsFix: false, note: "Could not determine dimensions" };
  } catch {
    return { url: u.toString(), source: "unknown", width: null, height: null, isSquare: null, fixedUrl: u.toString(), needsFix: false, note: "Fetch failed" };
  }
}

function extractDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    // JPEG
    if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] === 0xff) {
          const marker = buf[i + 1];
          // SOF0-SOF15 (excluding DHT/DAC/RST/SOI/EOI which have no length)
          if (
            (marker >= 0xc0 && marker <= 0xcf) &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
          ) {
            const h = (buf[i + 5] << 8) | buf[i + 6];
            const w = (buf[i + 7] << 8) | buf[i + 8];
            if (w > 0 && h > 0) return { width: w, height: h };
          }
          if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2; // standalone markers
            continue;
          }
          const segLen = ((buf[i + 2] << 8) | buf[i + 3]) + 2;
          i += segLen;
        } else {
          i++;
        }
      }
    }
    // PNG
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    // GIF
    if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49) {
      const w = buf.readUInt16LE(6);
      const h = buf.readUInt16LE(8);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    // WebP (VP8/VP8L/VP8X)
    if (buf.length > 30 && buf.slice(0, 4).toString() === "RIFF") {
      if (buf.slice(8, 12).toString() === "WEBP") {
        const kind = buf.slice(12, 16).toString();
        if (kind === "VP8X") {
          const w = 1 + buf.readUIntLE(24, 3);
          const h = 1 + buf.readUIntLE(27, 3);
          if (w > 0 && h > 0) return { width: w, height: h };
        } else if (kind === "VP8L") {
          const bits = buf.readUInt32LE(21);
          const w = (bits & 0x3fff) + 1;
          const h = ((bits >> 14) & 0x3fff) + 1;
          if (w > 0 && h > 0) return { width: w, height: h };
        } else if (kind === "VP8 ") {
          const w = buf.readUInt16LE(26) & 0x3fff;
          const h = buf.readUInt16LE(28) & 0x3fff;
          if (w > 0 && h > 0) return { width: w, height: h };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
