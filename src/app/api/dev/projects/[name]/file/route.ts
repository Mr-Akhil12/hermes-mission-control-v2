import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ghFetch, GH_OWNER_CONST } from "../../../_shared";

const MAX_FILE_BYTES = 200 * 1024;

type GhContentsFile = {
  type: string;
  path: string;
  size: number;
  encoding: string;
  content: string;
};

// GET /api/dev/projects/[name]/file?path=... — decoded GitHub file contents.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const path = request.nextUrl.searchParams.get("path");

  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  if (path.startsWith("/") || path.split("/").includes("..")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  const encodedName = encodeURIComponent(name);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");

  try {
    const result = await ghFetch<GhContentsFile | GhContentsFile[]>(
      `/repos/${GH_OWNER_CONST}/${encodedName}/contents/${encodedPath}`
    );

    if (Array.isArray(result)) {
      return NextResponse.json({ error: "is a directory" }, { status: 400 });
    }

    if (result.encoding !== "base64" || typeof result.content !== "string") {
      return NextResponse.json(
        { error: `unsupported GitHub content encoding: ${result.encoding || "unknown"}` },
        { status: 502 }
      );
    }

    const decoded = Buffer.from(result.content.replace(/\s/g, ""), "base64");
    const truncated = decoded.length > MAX_FILE_BYTES;
    const content = decoded.subarray(0, MAX_FILE_BYTES).toString("utf8");

    return NextResponse.json({
      path: result.path || path,
      size: typeof result.size === "number" ? result.size : decoded.length,
      content,
      truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^github 404\b/.test(message)) {
      return NextResponse.json({ error: "not found", status: 404 }, { status: 404 });
    }

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
