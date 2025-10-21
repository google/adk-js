import { MCPToolset, LlmAgent } from "@google/adk";

const githubMCPToolset = new MCPToolset({
  type: "StreamableHTTPConnectionParams",
  url: "https://seolinkmap.com/mcp/",
});

export const rootAgent = new LlmAgent({
  name: "github_agent",
  model: "gemini-2.5-flash",
  description: "Github agent with mcp toolset.",
  instruction:
    "You are a helpful github agent who use mcp tools to handle user request.",
  tools: [githubMCPToolset],
});