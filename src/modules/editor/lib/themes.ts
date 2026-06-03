import { atomone } from "@uiw/codemirror-theme-atomone";
import { aura } from "@uiw/codemirror-theme-aura";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { gruvboxDark } from "@uiw/codemirror-theme-gruvbox-dark";
import { nord } from "@uiw/codemirror-theme-nord";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { xcodeDark, xcodeLight } from "@uiw/codemirror-theme-xcode";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Prec, type Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import type { EditorThemeId } from "@/modules/settings/store";

// copilot (the editor theme the "claude" app theme uses in dark mode)
// renders comments in #707a84, almost identical to its muted identifier
// gray #939da5, so comments do not stand out. Override just copilot's
// comment color with a distinct warm tone. copilot is a dark theme, so a
// fixed value is correct regardless of the app light/dark mode.
const copilotCommentFix = Prec.highest(
  syntaxHighlighting(
    HighlightStyle.define([{ tag: tags.comment, color: "#b88a64" }]),
  ),
);

export const EDITOR_THEME_EXT: Record<EditorThemeId, Extension> = {
  atomone,
  aura,
  copilot: [copilot, copilotCommentFix],
  "github-dark": githubDark,
  "github-light": githubLight,
  "gruvbox-dark": gruvboxDark,
  nord,
  "tokyo-night": tokyoNight,
  "xcode-dark": xcodeDark,
  "xcode-light": xcodeLight,
};
