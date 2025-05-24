# Codex Reference: alexyangjie/mem0-mcp

> **Note**: This is a living document. Please update it whenever you find new information that could be useful in your future coding sessions.

**Project**: alexyangjie/mem0-mcp
 **Version**: 0.3.3
 **Description**: A Model Context Protocol (MCP) server providing persistent memory for LLMs via Mem0.ai and optional local storage.
 
 ## Tech Stack
 - Language: TypeScript (ES2022)
 - Runtime: Node.js (ESM)
 - Build: TypeScript Compiler (tsc)
 - MCP SDK: @modelcontextprotocol/sdk
 - Memory SDK: mem0ai
 - Tokenisation: tiktoken-node
 - CLI: Bash (config_generator.sh)
 
 ## Directory Structure
 ```
 .
 ├── src/                   # TypeScript source code
 │   └── index.ts           # Main server entry
 ├── build/                 # Compiled JavaScript output
 │   └── index.js           # Executable entry
 ├── config_generator.sh    # Helper for generating mcp.json configs
 ├── README.md              # Usage guide and installation
 ├── OVERVIEW.md            # High-level project overview
 ├── CHANGELOG.md           # Version history and changelog
 ├── CONTRIBUTING.md        # Contribution guidelines
 ├── LICENSE                # MIT License
 ├── package.json           # NPM metadata, scripts, dependencies
 ├── tsconfig.json          # TypeScript configuration
 └── node_modules/          # Installed dependencies
 ```
 
 ## Build & Development Scripts
 - **npm run build**: Compile TS → JS and set execute permissions
 - **npm run prepare**: Run build before package publish
 - **npm run watch**: Recompile on file changes
 - **npm run inspector**: Launch MCP inspector (`@modelcontextprotocol/inspector`)
 
 ## Installation & CLI
- **Global**: `npm install -g alexyangjie/mem0-mcp`
- **npx**: `npx alexyangjie/mem0-mcp`
 - **Local build**: `node build/index.js`
 
 Installed command: `alexyangjie/mem0-mcp` → `build/index.js` entry point
 
 ## Configuration & Environment Variables
 - `MEM0_API_KEY` (cloud storage; required for Mem0.ai)
 - `OPENAI_API_KEY` (local storage; required for in-memory mode)
 - `DEFAULT_USER_ID` (fallback user ID)
 - Optional: `ORG_ID`, `PROJECT_ID` (for Mem0 scoping)
 - Session identifiers: `RUN_ID` (cloud) / `SESSION_ID` (local)
 
 ## MCP Tools
 - **add_memory**: Store a memory (content, userId, [sessionId], [agentId], [metadata])
- **search_memory**: Retrieve memories (query, userId, [sessionId], [agentId], [filters], [threshold], [limit])
 - **delete_memory**: Remove memory (memoryId, userId, [agentId])
 
 ## Storage Modes
 1. **Cloud Storage** (Mem0.ai): Persistent, scalable
 2. **Local Storage** (in-memory vector DB): Ephemeral, for dev/testing
 
 ## Notes & Conventions
 - ESM modules enforced via `"type": "module"`
 - Semantic versioning and Keep a Changelog
 - No built-in tests; use `inspector` and manual testing
 - Ensure no stdout writes outside MCP protocol (uses SafeLogger)
 
 ## Future Considerations
 - Add CI/CD pipelines and automated tests
 - Enhance filtering and batch operations
 - Add persistent local DB options
 - Improve logging and error handling
 
 *Generated for Codex CLI reference*
