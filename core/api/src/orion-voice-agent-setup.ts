import { agentBody, ORION_VOICE_TOOLS, syncOrionVoiceAgent, toolConfig } from "./orion-voice-agent";

if (process.argv.includes("--print")) {
  console.log(
    JSON.stringify({ tools: ORION_VOICE_TOOLS.map(toolConfig), agent: agentBody([]) }, null, 2),
  );
} else {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Set ELEVENLABS_API_KEY (or run with --print to see what is sent).");
  const result = await syncOrionVoiceAgent({
    apiKey,
    ...(process.env.VOICE_AGENT_ID ? { agentId: process.env.VOICE_AGENT_ID } : {}),
    ...(process.env.ELEVENLABS_API_BASE ? { apiBase: process.env.ELEVENLABS_API_BASE } : {}),
    fetch: (input, init) => fetch(input, init),
  });
  console.log(`${result.created ? "created" : "updated"} agent ${result.agentId}`);
  for (const [name, id] of Object.entries(result.tools)) console.log(`tool ${name} ${id}`);
  if (result.created) console.log(`Set VOICE_AGENT_ID=${result.agentId} for the Core API.`);
}
