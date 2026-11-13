/** 雷达室配色: 近黑冷灰 / 琥珀信号 / 青绿回波 */

import { platform } from "nsh";

export const BG = "#101214";
export const PANEL = "#16191c";
export const RAISED = "#1c2024";   // 悬停 / 选中行的底
export const LINE = "#262b30";
export const LINE_STRONG = "#3a4148";
export const TEXT = "#d6dade";
export const MUTED = "#8a9299";    // 次要文字, 在 BG 和 PANEL 上对比度都 ≥ 5:1
export const FAINT = "#5c646b";    // 只用于不承载信息的刻度线和失效项

export const ACCENT = "#e8a33d";       // 琥珀: 选中、命中、自己提交过的仓库
export const ACCENT_TEXT = "#c9974a";  // 小字号琥珀文字 (ACCENT_DIM 当文字太暗)
export const ACCENT_DIM = "#8a6224";   // 琥珀的边框和条形底色
export const TEAL = "#5fb3a1";         // 青绿: 就绪、只是 clone 下来的仓库

/** nsh 不按 CSS 那样逐个回落字体列表, 所以按平台给一个一定存在的等宽字体 */
export const MONO =
  platform.os === "macos" || platform.os === "ios" ? "Menlo" : platform.os === "windows" ? "Consolas" : "monospace";
