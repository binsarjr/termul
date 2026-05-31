---
description: Cut and publish a new Its Just Terminal release — auto semver from commits, bump, tag, build, then auto-publish
argument-hint: "[patch|minor|major|X.Y.Z]  — optional, overrides the auto-detected bump"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(curl:*), Bash(python3:*), Read, Edit, Write
---

You are cutting a new release of **Its Just Terminal** (`binsarjr/its-just-terminal`). Work through the steps in order. If any step fails, **stop and report** — never continue past a failure, and never publish a broken build.

Key fact that drives everything: Tauri reads the released version from `src-tauri/tauri.conf.json` (`version`), **not** from the git tag. So the version file must be bumped and committed *before* tagging, and the tag must point at that bump commit.

## 0. Preflight
- `gh auth status` must be authed; abort if not.
- `git fetch origin main --tags`.
- Last tag: `git describe --tags --abbrev=0 origin/main` (e.g. `v0.1.0`). If there are no tags, treat the previous version as `0.0.0`.
- Commits since: `git log <lasttag>..origin/main --oneline`. If empty → stop: "Nothing to release; no commits since <lasttag>."

## 1. Decide the new version  ← the one confirmation gate
- Current version = last tag without the `v`.
- If `$ARGUMENTS` is given: `patch`/`minor`/`major` → apply that bump; an explicit `X.Y.Z` → use it verbatim.
- Otherwise auto-detect from the conventional commits since the last tag:
  - `feat!:` / `fix!:` / a `BREAKING CHANGE:` footer → **major**
  - else any `feat:` → **minor**
  - else (`fix:`, `chore:`, `refactor:`, …) → **patch**
- Compute the new version and tag `vX.Y.Z`.
- **Show the user**: the commit list, the detected bump type, and `current → new`. **Wait for an explicit "yes" before continuing.** This is the only interactive gate.

## 2–3. Bump + commit + tag (in a throwaway worktree, so other working trees are untouched)
Run all git mutations through a temporary worktree off the freshly-fetched `origin/main` — never touch the user's main checkout (another agent may be working there):

```sh
git worktree add /tmp/ijt-release origin/main --detach
```
In `/tmp/ijt-release`:
- Edit `src-tauri/tauri.conf.json` → set `"version"` to the new version.
- Edit `package.json` → set `"version"` to the new version.
- **Do not** touch `src-tauri/Cargo.toml` or `Cargo.lock` — `tauri.conf.json` is the source of truth for the released version, and leaving `Cargo.*` unchanged keeps the `--locked` CI green.
- Commit and push the bump to main, then tag that commit and push the tag:
```sh
git -C /tmp/ijt-release commit -am "chore(release): vX.Y.Z"
git -C /tmp/ijt-release push origin HEAD:main
git -C /tmp/ijt-release tag vX.Y.Z
git -C /tmp/ijt-release push origin vX.Y.Z       # ← triggers the Release workflow
git worktree remove /tmp/ijt-release --force
```
(Substitute the real version. The tag now points at the bump commit, so the build produces correctly-versioned artifacts.)

## 4. Wait for the build
- Find the run: `gh run list --workflow release.yml --limit 1` (the one whose head is `vX.Y.Z`).
- Poll `gh run view <id> --json status,conclusion` roughly every 2–3 minutes until `status == completed`. The 4-platform sequential matrix (`max-parallel: 1`) takes **~30–40 min** — be patient, don't spam-poll.
- If `conclusion != success`: stop, print the failed run URL, do **not** publish.

## 5. Verify artifacts
- `gh release view vX.Y.Z --json isDraft,assets`.
- Confirm the draft contains: `latest.json`, both macOS `.dmg`, the Windows `.exe` + `.msi`, the Linux `.deb`/`.rpm`/`.AppImage`, and a `.sig` for **every** updater artifact (`.app.tar.gz.sig`, `.AppImage.sig`, `.deb.sig`, `.rpm.sig`, `.exe.sig`, `.msi.sig`).
- If `latest.json` or any `.sig` is missing → stop and report (signing failed). Don't publish.

## 6. Auto-publish
- Build the release notes: a short **What's changed** changelog (the commit list from step 0) followed by the unsigned-install block below. Write it to `/tmp/ijt-release-notes.md`.
- Publish: `gh release edit vX.Y.Z --draft=false --notes-file /tmp/ijt-release-notes.md`.
- Confirm the public updater endpoint is live:
  `curl -sL -o /dev/null -w "%{http_code}\n" https://github.com/binsarjr/its-just-terminal/releases/latest/download/latest.json` → expect **200**.

## 7. Report
Print: new version, release URL, asset count, endpoint HTTP status. Done.

---

### Release-notes install block (append after the changelog)

```md
## ⚠️ Unsigned builds — first launch
These builds are not code-signed, so your OS warns on first launch. The app is safe.
- **macOS**: after moving the app into Applications, run `xattr -cr "/Applications/Its Just Terminal.app"`, then open it (or right-click → **Open** the first time).
- **Windows**: on the SmartScreen prompt, click **More info → Run anyway**.

Updates are delivered automatically from this Releases page.
```
