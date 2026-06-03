import { describe, expect, it } from "vitest";
import { isLocalHost, parseSshHost, parseSshTarget } from "./remoteCwd";

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

describe("parseSshHost", () => {
  it("extracts the bare host from a plain ssh invocation", () => {
    expect(parseSshHost("ssh pi")).toBe("pi");
  });

  it("strips a user@ prefix", () => {
    expect(parseSshHost("ssh user@pi")).toBe("pi");
  });

  it("skips a value flag and its separate argument", () => {
    expect(parseSshHost("ssh -p 2222 user@host.example.com")).toBe(
      "host.example.com",
    );
  });

  it("skips -i and its key path", () => {
    expect(parseSshHost("ssh -i ~/.ssh/id_ed25519 pi")).toBe("pi");
  });

  it("skips -o key=value option pairs", () => {
    expect(parseSshHost("ssh -o StrictHostKeyChecking=no host")).toBe("host");
  });

  it("ignores boolean flags before the host", () => {
    expect(parseSshHost("ssh -4 -v pi")).toBe("pi");
  });

  it("returns the host, not the trailing remote command", () => {
    expect(parseSshHost("ssh -tt pi htop")).toBe("pi");
  });

  it("skips a -L port-forward spec", () => {
    expect(parseSshHost("ssh -L 8080:localhost:80 pi")).toBe("pi");
  });

  it("treats a glued-on flag value as consuming nothing extra", () => {
    expect(parseSshHost("ssh -p2222 pi")).toBe("pi");
  });

  it("handles a short-flag bundle ending in a value-flag (consumes next token)", () => {
    // OpenSSH splits `-Cp` into -C (boolean) + -p (value), and -p takes "2222"
    // as its argument — the host is the token after that.
    expect(parseSshHost("ssh -Cp 2222 examplehost")).toBe("examplehost");
    expect(parseSshHost("ssh -qp 2222 pi")).toBe("pi");
    expect(parseSshHost("ssh -fp 2222 host")).toBe("host");
  });

  it("handles a bundle whose value-flag has its value glued on", () => {
    // `-fp2222`: the value-flag char (p) is mid-bundle, so "2222" is its glued
    // value and nothing extra is consumed — the very next token is the host.
    expect(parseSshHost("ssh -fp2222 host")).toBe("host");
  });

  it("accepts a path to the ssh binary", () => {
    expect(parseSshHost("/usr/bin/ssh host")).toBe("host");
  });

  it("parses the ssh:// URL form", () => {
    expect(parseSshHost("ssh://user@host:22/x")).toBe("host");
  });

  it("rejects ssh-keygen (basename is not exactly ssh)", () => {
    expect(parseSshHost("ssh-keygen -t ed25519")).toBeNull();
  });

  it("rejects sshpass wrapping ssh", () => {
    expect(parseSshHost("sshpass -p x ssh h")).toBeNull();
  });

  it("returns null for non-ssh commands", () => {
    expect(parseSshHost("ls")).toBeNull();
    expect(parseSshHost("git push")).toBeNull();
  });

  it("returns null when ssh has no host", () => {
    expect(parseSshHost("ssh")).toBeNull();
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(parseSshHost("")).toBeNull();
    expect(parseSshHost("   ")).toBeNull();
  });

  it("rejects the other ssh-* sibling tools", () => {
    expect(parseSshHost("ssh-add ~/.ssh/id")).toBeNull();
    expect(parseSshHost("ssh-copy-id pi")).toBeNull();
    expect(parseSshHost("ssh-agent")).toBeNull();
    expect(parseSshHost("sshfs pi:/ /mnt")).toBeNull();
    expect(parseSshHost("autossh -M 0 pi")).toBeNull();
  });

  it("collapses runs of whitespace between tokens", () => {
    expect(parseSshHost("  ssh   -v    pi  ")).toBe("pi");
  });

  it("strips a :port from a [user@]host token", () => {
    expect(parseSshHost("ssh user@host.example.com:2222")).toBe(
      "host.example.com",
    );
  });
});

describe("parseSshTarget", () => {
  it("returns the bare host when no user is given", () => {
    expect(parseSshTarget("ssh pi")).toBe("pi");
  });

  it("PRESERVES the user@ prefix (the whole point — connect as that identity)", () => {
    expect(parseSshTarget("ssh user@pi")).toBe("user@pi");
    expect(parseSshTarget("ssh deploy@host.example.com")).toBe(
      "deploy@host.example.com",
    );
  });

  it("preserves user@ on an IP-address host", () => {
    expect(parseSshTarget("ssh user@10.0.0.5")).toBe("user@10.0.0.5");
  });

  it("keeps the user but drops the port flag and remote command", () => {
    expect(parseSshTarget("ssh -p 2222 root@host htop")).toBe("root@host");
  });

  it("skips -i and keeps the user@host", () => {
    expect(parseSshTarget("ssh -i ~/.ssh/id_ed25519 deploy@host")).toBe(
      "deploy@host",
    );
  });

  it("strips the scheme and /path but keeps user (and port) in the URL form", () => {
    expect(parseSshTarget("ssh://user@host:22/x")).toBe("user@host:22");
  });

  it("rejects the ssh-* sibling tools just like parseSshHost", () => {
    expect(parseSshTarget("ssh-add ~/.ssh/id")).toBeNull();
    expect(parseSshTarget("ssh-keygen -t ed25519")).toBeNull();
    expect(parseSshTarget("sshpass -p x ssh h")).toBeNull();
  });

  it("returns null for non-ssh / hostless / empty input", () => {
    expect(parseSshTarget("ls")).toBeNull();
    expect(parseSshTarget("ssh")).toBeNull();
    expect(parseSshTarget("")).toBeNull();
  });
});
