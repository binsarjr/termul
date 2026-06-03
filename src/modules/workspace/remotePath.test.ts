import { describe, expect, it } from "vitest";
import {
  isRemotePath,
  makeRemoteUri,
  parseRemoteUri,
  REMOTE_SCHEME,
} from "./remotePath";

describe("isRemotePath", () => {
  it("detects the ssh scheme", () => {
    expect(isRemotePath("ssh://pi/home/pi")).toBe(true);
    expect(isRemotePath("ssh://user@host/etc/hosts")).toBe(true);
  });

  it("treats every other path as local", () => {
    expect(isRemotePath("/home/pi")).toBe(false);
    expect(isRemotePath("C:\\Users\\me")).toBe(false);
    expect(isRemotePath("\\\\wsl$\\Ubuntu\\home")).toBe(false);
    expect(isRemotePath("")).toBe(false);
    expect(isRemotePath("sshfoo")).toBe(false);
  });
});

describe("parseRemoteUri", () => {
  it("splits host and absolute path", () => {
    expect(parseRemoteUri("ssh://pi/home/pi/notes.txt")).toEqual({
      host: "pi",
      path: "/home/pi/notes.txt",
    });
  });

  it("keeps a user@host token intact", () => {
    expect(parseRemoteUri("ssh://ubuntu@1.2.3.4/var/log")).toEqual({
      host: "ubuntu@1.2.3.4",
      path: "/var/log",
    });
  });

  it("returns the bare root path", () => {
    expect(parseRemoteUri("ssh://pi/")).toEqual({ host: "pi", path: "/" });
  });

  it("preserves spaces and other characters in the path", () => {
    expect(parseRemoteUri("ssh://pi/home/pi/My Docs/a b.txt")).toEqual({
      host: "pi",
      path: "/home/pi/My Docs/a b.txt",
    });
  });

  it("rejects local paths", () => {
    expect(parseRemoteUri("/home/pi")).toBeNull();
    expect(parseRemoteUri("relative/path")).toBeNull();
  });

  it("rejects a remote uri with no host", () => {
    expect(parseRemoteUri("ssh:///home/pi")).toBeNull();
  });

  it("rejects a remote uri with a host but no absolute path", () => {
    expect(parseRemoteUri("ssh://pi")).toBeNull();
  });
});

describe("makeRemoteUri", () => {
  it("is the inverse of parseRemoteUri", () => {
    const uri = makeRemoteUri("pi", "/home/pi/x");
    expect(uri).toBe("ssh://pi/home/pi/x");
    expect(parseRemoteUri(uri)).toEqual({ host: "pi", path: "/home/pi/x" });
  });

  it("uses the shared scheme constant", () => {
    expect(makeRemoteUri("h", "/p").startsWith(REMOTE_SCHEME)).toBe(true);
  });
});
