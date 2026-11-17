// Claude Code desktop's "Claude Light" / "Claude Dark" code colours (spec A.3) as Shiki themes, for
// code blocks in the chat and the diffs.
const SCOPES = {
  comment: ["comment", "punctuation.definition.comment"],
  punct: ["punctuation", "meta.brace", "keyword.operator"],
  keyword: ["keyword", "storage", "keyword.operator.new", "keyword.operator.expression"],
  string: ["string", "markup.inline.raw", "markup.inserted"],
  regex: ["string.regexp"],
  number: ["constant.numeric", "constant.language", "constant.character", "support.constant"],
  tag: ["entity.name.tag", "support.type.property-name", "meta.object-literal.key", "markup.deleted"],
  attr: ["entity.other.attribute-name"],
  fn: ["entity.name.function", "support.function", "meta.function-call entity.name.function", "markup.heading"],
  type: ["entity.name.type", "entity.name.class", "support.class", "support.type", "variable.language", "variable.other.constant"],
  param: ["variable.parameter"],
} as const

type Palette = Record<keyof typeof SCOPES | "fg" | "bg", string>

function theme(name: string, type: "light" | "dark", c: Palette) {
  return {
    name,
    type,
    colors: { "editor.background": c.bg, "editor.foreground": c.fg },
    tokenColors: (Object.keys(SCOPES) as (keyof typeof SCOPES)[]).map((k) => ({
      scope: [...SCOPES[k]],
      settings: { foreground: c[k] },
    })),
  }
}

export const CLAUDE_LIGHT = theme("claude-light", "light", {
  bg: "#ffffff",
  fg: "#14181f",
  comment: "#6e7687",
  punct: "#2b303b",
  keyword: "#8100c2",
  string: "#008000",
  regex: "#078307",
  number: "#007f80",
  tag: "#b80a18",
  attr: "#bd0f1e",
  fn: "#0051c2",
  type: "#b24a00",
  param: "#b84f05",
})

export const CLAUDE_DARK = theme("claude-dark", "dark", {
  bg: "#191919",
  fg: "#eaecf0",
  comment: "#818898",
  punct: "#d3d7de",
  keyword: "#cc7bf4",
  string: "#9be963",
  regex: "#96e35f",
  number: "#5eeded",
  tag: "#f47b85",
  attr: "#f0757f",
  fn: "#70b8ff",
  type: "#fbad60",
  param: "#f7ab5f",
})
