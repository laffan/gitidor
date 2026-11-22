import { describe, expect, it } from "vitest";
import { fileCandidates, matchUpload } from "./upload-refs";
import type { UploadEntry } from "./types";

const entry = (path: string): UploadEntry => ({ path, name: path.split("/").pop()!, size: 1, modified: 0, change: "" });
const uploads = [
  entry("public/blog-images/harbour.jpg"),
  entry("public/blog-images/2024/harbour.jpg"),
  entry("public/blog-images/my photo.png"),
  entry("public/files/menu.pdf"),
  entry("public/audio/Waves.MP3"),
];

describe("fileCandidates", () => {
  it("finds the file names a frontmatter line gives, with where they end", () => {
    const line = "image: /images/blog/harbour.jpg";
    expect(fileCandidates(line)).toEqual([{ text: "/images/blog/harbour.jpg", from: 7, to: line.length }]);
  });

  it("reads quoted names whole, lists, and TOML", () => {
    expect(fileCandidates(`cover: "my photo.png"`).map((c) => c.text)).toEqual(["my photo.png"]);
    expect(fileCandidates("attachments: [menu.pdf, 'Waves.MP3']").map((c) => c.text)).toEqual(["menu.pdf", "Waves.MP3"]);
    expect(fileCandidates("  - harbour.jpg").map((c) => c.text)).toEqual(["harbour.jpg"]);
    expect(fileCandidates(`image = "harbour.jpg"`).map((c) => c.text)).toEqual(["harbour.jpg"]);
    const quoted = `cover: "my photo.png"`;
    const [c] = fileCandidates(quoted);
    expect(quoted.slice(c.from, c.to)).toBe("my photo.png");
  });

  it("leaves out keys, dates, versions and plain words", () => {
    expect(fileCandidates("logo.png: something")).toEqual([]);
    expect(fileCandidates("date: 2026-11-02")).toEqual([]);
    expect(fileCandidates("title: Version 2.0 notes")).toEqual([]);
    expect(fileCandidates("summary: An island at the end of the line")).toEqual([]);
  });
});

describe("matchUpload", () => {
  const viaSite = (ref: string) => (ref.startsWith("/images/blog/") ? `public/blog-images/${ref.slice(13)}` : null);

  it("follows the site's URL map first", () => {
    expect(matchUpload("/images/blog/2024/harbour.jpg", uploads, viaSite)?.path).toBe("public/blog-images/2024/harbour.jpg");
    expect(matchUpload("/images/blog/harbour.jpg", uploads, viaSite)?.path).toBe("public/blog-images/harbour.jpg");
  });

  it("falls back to the file name, preferring the closest path", () => {
    expect(matchUpload("menu.pdf", uploads)?.path).toBe("public/files/menu.pdf");
    expect(matchUpload("assets/2024/harbour.jpg", uploads)?.path).toBe("public/blog-images/2024/harbour.jpg");
    expect(matchUpload("my%20photo.png?v=2", uploads)?.path).toBe("public/blog-images/my photo.png");
    expect(matchUpload("waves.mp3", uploads)?.path).toBe("public/audio/Waves.MP3");
  });

  it("does not match another site's file or a name that is not there", () => {
    expect(matchUpload("https://cdn.example.com/harbour.jpg", uploads, () => null)).toBeNull();
    expect(matchUpload("missing.jpg", uploads)).toBeNull();
  });
});
