// Whether a message is Claude Code saying a plan limit stopped the turn ("Claude usage limit
// reached…", "You've hit your limit · resets 7pm", "5-hour limit reached ∙ resets 3pm"). Not
// "rate limit" (what half of all API work talks about) nor "context limit".
const LIMIT = /usage limit reached|hit your (?:[\w-]+ )?limit|(?:5-hour|weekly|session|opus|sonnet|fable) limit reached|limit will reset/i

export const isUsageLimit = (text: string | undefined) => !!text && LIMIT.test(text)
