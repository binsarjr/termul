# Changelog

All notable changes to Termul are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Termul follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). On
release, the section matching the `v<version>` tag is published as the GitHub
release notes and shown inside Termul (the update prompt and the What's New
dialog after an update).

## [Unreleased]

## [0.3.9] - 2026-06-14

### Fixed

- Resize handles work again: the pane, sidebar, and tab-bar dividers had become
  invisible and could not be dragged.
- Settings search keeps its highlight in range, so pressing Enter always opens
  the highlighted result instead of doing nothing.
- The tab-close and theme Edit/Remove buttons now show a visible focus ring when
  reached by keyboard, instead of being invisible focus stops.

## [0.3.8] - 2026-06-14

### Added

- Left-side vertical tab bar as an alternative to the top tab strip.
- Global settings search with jump-to navigation.
- Adeberry built-in theme.
- SSH host badge and active-pane tab titles, with full titles shown by default.
- In-app changelog: release notes are sourced from this file and shown in the
  update prompt and in a What's New dialog the first time you launch a new
  version.

### Changed

- More reliable update detection, with a manual recheck that cannot get stuck a
  version behind.
- Zoom-aware sidebar and split-pane resize handles that stay accurate at any UI
  zoom level.

### Fixed

- Radix overlays (dropdowns, popovers) now flip and shift correctly under CSS
  zoom instead of drifting away from their trigger.

### Security

- Block SSRF through IPv4-mapped and NAT64 IPv6 addresses and trailing-dot
  metadata hostnames.
- Filter secret files out of AI grep and glob results and harden the secret
  deny-list.
