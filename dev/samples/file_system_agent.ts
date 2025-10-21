import { MCPToolset, LlmAgent } from "@google/adk";

const TARGET_FOLDER_PATH = "/Users/kalenkevich/projects/";

export const rootAgent = new LlmAgent({
  model: "gemini-2.5-flash",
  name: "filesystem_assistant_agent",
  instruction: "Help the user manage their files. You can list files, read files, etc.",
  tools: [
    // To filter tools, pass a list of tool names as the second argument
    // to the MCPToolset constructor.
    // e.g., new MCPToolset(connectionParams, ['list_directory', 'read_file'])
    new MCPToolset(
      {
        type: "StdioConnectionParams",
        serverParams: {
          command: "npx",
          args: [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            // IMPORTANT: This MUST be an ABSOLUTE path to a folder the
            // npx process can access.
            // Replace with a valid absolute path on your system.
            // For example: "/Users/youruser/accessible_mcp_files"
            TARGET_FOLDER_PATH,
          ],
        },
      }
    )
  ],
});