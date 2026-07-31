import { NextResponse } from "next/server";

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

    const results = await Promise.all(
      imageUrls.map(async (url: string) => {
        try {
          const parsed = new URL(url);
          const u = parsed.toString();

          // Unsplash: we know the pattern — can force square with params
          if (u.includes("unsplash.com")) {
            const isPlaceholder = u.includes("placeholder");
            const hasSquare = u.includes("&h=") && u.includes("&w=");
            const wMatch = u.match(/w=(\d+)/);
            const hMatch = u.match(/h=(\d+)/);
            const w = wMatch ? parseInt(wMatch[1]) : null;
            const h = hMatch ? parseInt(hMatch[1]) : null;
            const is1x1 = w && h && w === h;
            const fixedUrl = u.replace(
              /[?&]w=\d+/g,
              ""
            ).replace(
              /[?&]h=\d+/g,
              ""
            ).replace(
              /[?&]fit=\w+/g,
              ""
            ) + "&w=600&h=600&fit=crop";

            return {
              url,
              source: "unsplash",
              width: w,
              height: h,
              isSquare: is1x1 || !hasSquare || isPlaceholder,
              fixedUrl: is1x1 || isPlaceholder ? url : fixedUrl,
              needsFix: !(is1x1 || isPlaceholder),
            };
          }

          // Try to fetch image headers to get dimensions
          try {
            const res = await fetch(u, {
              method: "HEAD",
              signal: AbortSignal.timeout(5000),
            });
            const contentType = res.headers.get("content-type") || "";

            // Some CDNs return dimensions in headers
            const contentLength = res.headers.get("content-length");

            if (contentType.startsWith("image/")) {
              // Try a range request to read image dimensions from header
              try {
                const imgRes = await fetch(u, {
                  headers: { Range: "bytes=0-50000" },
                  signal: AbortSignal.timeout(5000),
                });
                const buffer = Buffer.from(await imgRes.arrayBuffer());

                // JPEG: look for SOF marker (FF C0) to get dimensions
                let w: number | null = null;
                let h: number | null = null;

                if (buffer[0] === 0xff && buffer[1] === 0xd8) {
                  // JPEG
                  let i = 2;
                  while (i < buffer.length - 8) {
                    if (buffer[i] === 0xff) {
                      const marker = buffer[i + 1];
                      if (
                        marker >= 0xc0 &&
                        marker <= 0xc2
                      ) {
                        h = (buffer[i + 5] << 8) | buffer[i + 6];
                        w = (buffer[i + 7] << 8) | buffer[i + 8];
                        break;
                      }
                      const segLen =
                        ((buffer[i + 2] << 8) | buffer[i + 3]) + 2;
                      i += segLen;
                    } else {
                      i++;
                    }
                  }
                } else if (
                  buffer[0] === 0x89 &&
                  buffer[1] === 0x50
                ) {
                  // PNG: IHDR chunk at offset 16
                  w =
                    (buffer[16] << 24) |
                    (buffer[17] << 16) |
                    (buffer[18] << 8) |
                    buffer[19];
                  h =
                    (buffer[20] << 24) |
                    (buffer[21] << 16) |
                    (buffer[22] << 8) |
                    buffer[23];
                }

                if (w && h) {
                  return {
                    url,
                    source: "fetched",
                    width: w,
                    height: h,
                    isSquare: w === h,
                    fixedUrl: url,
                    needsFix: w !== h,
                    ratio: `${w}x${h}`,
                  };
                }
              } catch {
                // fall through
              }
            }
          } catch {
            // network error, skip
          }

          return {
            url,
            source: "unknown",
            width: null,
            height: null,
            isSquare: null,
            fixedUrl: url,
            needsFix: false,
            note: "Could not determine dimensions",
          };
        } catch {
          return {
            url,
            source: "invalid",
            width: null,
            height: null,
            isSquare: null,
            fixedUrl: url,
            needsFix: false,
            note: "Invalid URL",
          };
        }
      })
    );

    return NextResponse.json({ results });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
