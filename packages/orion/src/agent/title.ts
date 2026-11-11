// Names a conversation from its first exchange, so the chat list reads as a list of jobs
// instead of a list of opening lines.

export const TITLE_INSTRUCTION =
  "Give this conversation a short title: 2 to 6 words, in the language the farmer wrote in, saying what it is about. Reply with the title only, no quotes and no full stop.";

const FARMER = "Farmer: ";
const MAX_TITLE = 60;
const MAX_PART = 600;

export function titleRequest(asked: string, reply: string): string {
  const part = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, MAX_PART);
  return [
    TITLE_INSTRUCTION,
    "",
    `${FARMER}${part(asked)}`,
    ...(reply.trim() ? [`Orion: ${part(reply)}`] : []),
  ].join("\n");
}

export function askedIn(request: string): string {
  const line = request.split("\n").find((l) => l.startsWith(FARMER));
  return line ? line.slice(FARMER.length) : "";
}

/** The model's answer reduced to one clean line, or null when it gave nothing usable. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const title = line
    .replace(/^[#*\s"'“”‘’«»]+|[*\s"'“”‘’«».]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE)
    .trim();
  return title || null;
}
