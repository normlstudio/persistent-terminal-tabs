/** Codex publishes a braille spinner in its OSC title only while a turn is active.
 * Idle prompt animations, scrollback, and arbitrary terminal output are NOT work signals.
 * Require the foreground process too: a shell can retain a departed agent's title.
 * Unknown agents/title formats deliberately stay at their attachment color.
 */
const CODEX_BUSY_TITLE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u;

export function isAgentWorking(command: string, title: string): boolean {
  return /^codex(?:\.exe)?$/i.test(command) && CODEX_BUSY_TITLE.test(title);
}

/** Strip runtime decoration for exact conversation-name matching, never shorten names. */
export function codexConversationTitle(title: string): string {
  return title.replace(CODEX_BUSY_TITLE, '').replace(/^\[ ! \] Action Required \| /, '');
}
