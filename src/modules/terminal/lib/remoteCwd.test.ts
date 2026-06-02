import { describe, expect, it } from "vitest";
import { isLocalHost } from "./remoteCwd";

describe("isLocalHost", () => {
  it("treats the always-local hosts as local regardless of hostname", () => {
    for (const h of ["", "localhost", "127.0.0.1", "::1", "0.0.0.0"]) {
      expect(isLocalHost(h, "my-mac.local")).toBe(true);
      expect(isLocalHost(h, null)).toBe(true);
    }
  });

  it("matches an exact hostname", () => {
    expect(isLocalHost("my-mac.local", "my-mac.local")).toBe(true);
    expect(isLocalHost("MY-MAC.LOCAL", "my-mac.local")).toBe(true);
  });

  it("matches short-name against FQDN in both directions", () => {
    expect(isLocalHost("prod", "prod.example.com")).toBe(true);
    expect(isLocalHost("prod.example.com", "prod")).toBe(true);
  });

  it("treats a genuinely different host as remote", () => {
    expect(isLocalHost("prod.example.com", "my-mac.local")).toBe(false);
    expect(isLocalHost("10.0.0.5", "my-mac.local")).toBe(false);
    expect(isLocalHost("server", "laptop")).toBe(false);
  });

  it("assumes local while the hostname is still unknown", () => {
    expect(isLocalHost("prod.example.com", null)).toBe(true);
    expect(isLocalHost("anything", null)).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isLocalHost("  prod  ", "prod.example.com")).toBe(true);
  });
});
